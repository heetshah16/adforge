import { z } from 'zod';
import {
  ProviderError,
  type CutoutProvider,
  type ImageProvider,
  type JobHandle,
  type MediaRef,
  type ProviderResult,
  type StorageProvider,
  type VideoCapabilities,
  type VideoProvider,
} from '@adforge/core/providers/types';
import { ComfyClient, promptIdFor, type Fetch, type HistoryEntry } from './client';
import { collect, submitOnce, toFailed, waitFor, waitWhileQueued, type OutputSpec } from './job';
import { nodeIdByTitle, patchWorkflow, type ApiWorkflow } from './patch';
import {
  BROLL_WORKFLOWS,
  BrollParams,
  CUTOUT_WORKFLOWS,
  CutoutParams,
  PLATE_WORKFLOWS,
  PlateParams,
  assertManifestMatches,
  loadWorkflow,
  pickWorkflow,
  type Manifest,
} from './workflows';

const P = 'comfyui';
const IMAGE_EXT: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };

export interface ComfyOptions {
  baseUrl: string;
  storage: StorageProvider;
  plateWorkflow: string;
  cutoutWorkflow: string;
  brollWorkflow: string;
  fetchImpl?: Fetch;
  /** How long image/cutout calls wait for their job to RUN to completion, queue wait excluded. Default 120s. */
  syncTimeoutMs?: number;
  /** How long image/cutout calls wait for a job that is merely queued behind others. Default 30 min. */
  queueTimeoutMs?: number;
  /** Per-HTTP-request timeout. Default 30s. */
  requestTimeoutMs?: number;
  /** Poll interval for image/cutout waits. Default 1s. */
  pollIntervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

const SystemStats = z.object({ devices: z.array(z.object({ vram_total: z.number(), vram_free: z.number() })) });

const invalid = (message: string): ProviderResult<never> => ({
  status: 'failed',
  error: new ProviderError(P, 'INVALID_INPUT', message),
  retryable: false,
});

/** No seed given → derive one from the key, so retries reproduce the same pixels. */
const seedFor = (key: string): number => Number.parseInt(promptIdFor(`seed:${key}`).slice(0, 8), 16);

function load<Params>(table: Record<string, Manifest<Params>>, name: string, role: string) {
  const manifest = pickWorkflow(table, name, role);
  const { json, sha256 } = loadWorkflow(manifest.name);
  assertManifestMatches(json, manifest);
  return { manifest, json, sha256 };
}

export function createComfyProviders(o: ComfyOptions): {
  image: ImageProvider;
  cutout: CutoutProvider;
  video: VideoProvider;
  /** Throws a ProviderError if ComfyUI is unreachable. */
  preflight(): Promise<void>;
  /** Unload models and free memory so another GPU service can run. */
  free(): Promise<void>;
  /** VRAM in use / total across devices, to verify a `free()` hand-off took effect. */
  systemStats(): Promise<{ vramUsedBytes: number; vramTotalBytes: number }>;
  workflowHashes: Record<string, string>;
} {
  const client = new ComfyClient(o.baseUrl, o.fetchImpl, o.requestTimeoutMs);
  const plate = load(PLATE_WORKFLOWS, o.plateWorkflow, 'plate');
  const cut = load(CUTOUT_WORKFLOWS, o.cutoutWorkflow, 'cutout');
  const broll = load(BROLL_WORKFLOWS, o.brollWorkflow, 'broll');
  const wait = { timeoutMs: o.syncTimeoutMs ?? 120_000, intervalMs: o.pollIntervalMs ?? 1000, sleep: o.sleep };

  const runSync = async (wf: ApiWorkflow, key: string, output: OutputSpec): Promise<ProviderResult<MediaRef>> => {
    try {
      const promptId = await submitOnce(client, wf, key);
      const queued = await waitWhileQueued(client, promptId, {
        maxMs: o.queueTimeoutMs ?? 30 * 60_000,
        intervalMs: wait.intervalMs,
        sleep: o.sleep,
      });
      if (queued) return queued;
      return await waitFor(() => collect(client, o.storage, wf, promptId, output), wait);
    } catch (e) {
      return toFailed(e);
    }
  };

  const upload = async (ref: MediaRef): Promise<string> => {
    const ext = IMAGE_EXT[ref.mime];
    if (!ext) throw new ProviderError(P, 'INVALID_INPUT', `Unsupported image type for ComfyUI input: ${ref.mime}`);
    return client.uploadImage(await o.storage.read(ref.id), `${ref.sha256}.${ext}`);
  };

  const image: ImageProvider = {
    id: P,
    async generate(req) {
      const params = PlateParams.safeParse({
        prompt: req.prompt,
        seed: req.seed ?? seedFor(req.idempotencyKey),
        width: req.width,
        height: req.height,
      });
      if (!params.success) return invalid(`Invalid plate request: ${z.prettifyError(params.error)}`);
      return runSync(patchWorkflow(plate.json, plate.manifest.toPatches(params.data)), req.idempotencyKey, plate.manifest.output);
    },
  };

  const cutout: CutoutProvider = {
    id: P,
    async cutout(req) {
      try {
        const params = CutoutParams.parse({ image: await upload(req.image) });
        return await runSync(patchWorkflow(cut.json, cut.manifest.toPatches(params)), req.idempotencyKey, cut.manifest.output);
      } catch (e) {
        return toFailed(e);
      }
    },
  };

  const fps = broll.manifest.fps ?? 24;
  const size = broll.manifest.size ?? { width: 704, height: 1280 };
  const maxDurationSec = 5;
  const sizeNodeId = nodeIdByTitle(broll.json, 'in:size');
  const brollOutput: OutputSpec = {
    ...broll.manifest.output,
    ...size,
    pollAfterMs: 15_000,
    durationSec: (entry: HistoryEntry) => {
      const workflow = entry.prompt[2] as ApiWorkflow | undefined;
      const length = workflow?.[sizeNodeId]?.inputs.length;
      return typeof length === 'number' ? length / fps : undefined;
    },
  };
  const capabilities: VideoCapabilities = {
    modes: ['image_to_video'],
    maxDurationSec,
    resolutions: ['720p'],
    typicalLatencyMs: 275_000,
  };

  const video: VideoProvider = {
    id: P,
    capabilities,
    async submit(req): Promise<JobHandle> {
      const reject = (why: string) => new ProviderError(P, 'INVALID_INPUT', `Unsupported b-roll request: ${why}`);
      if (req.mode !== 'image_to_video') throw reject(`mode ${req.mode}`);
      if (req.aspectRatio !== '9:16' || req.resolution !== '720p') throw reject(`${req.aspectRatio} at ${req.resolution}`);
      if (!req.firstFrame) throw reject('firstFrame is required');
      if (!(req.durationSec > 0 && req.durationSec <= maxDurationSec)) throw reject(`durationSec ${req.durationSec}`);
      const length = Math.max(1, Math.round((req.durationSec * fps) / 4)) * 4 + 1;
      const params = BrollParams.safeParse({
        prompt: req.prompt,
        seed: req.seed ?? seedFor(req.idempotencyKey),
        image: 'pending-upload.png',
        ...size,
        length,
      });
      if (!params.success) throw reject(z.prettifyError(params.error));
      const imageName = await upload(req.firstFrame);
      const wf = patchWorkflow(broll.json, broll.manifest.toPatches({ ...params.data, image: imageName }));
      const promptId = await submitOnce(client, wf, req.idempotencyKey);
      return { provider: P, externalId: promptId, pollAfterMs: 15_000 };
    },
    poll(handle) {
      return collect(client, o.storage, broll.json, handle.externalId, brollOutput);
    },
  };

  return {
    image,
    cutout,
    video,
    free: () => client.free(),
    async systemStats() {
      const parsed = SystemStats.safeParse(await client.systemStats());
      if (!parsed.success) throw new ProviderError(P, 'UPSTREAM', `Unexpected /system_stats response: ${z.prettifyError(parsed.error)}`);
      const devices = parsed.data.devices;
      const total = devices.reduce((n, d) => n + d.vram_total, 0);
      return { vramTotalBytes: total, vramUsedBytes: total - devices.reduce((n, d) => n + d.vram_free, 0) };
    },
    async preflight() {
      await client.systemStats();
    },
    workflowHashes: {
      [plate.manifest.name]: plate.sha256,
      [cut.manifest.name]: cut.sha256,
      [broll.manifest.name]: broll.sha256,
    },
  };
}
