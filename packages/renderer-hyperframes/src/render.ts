import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { drainBrowserPool } from '@hyperframes/engine';
import { createRenderJob, executeRenderJob } from '@hyperframes/producer';
import {
  ProviderError,
  isRetryable,
  type MediaRef,
  type ProviderResult,
  type RenderRequest,
  type RendererProvider,
  type StorageProvider,
} from '@adforge/core/providers/types';
import { VideoSpec } from '@adforge/core/spec/video-spec';
import { composeHtml } from './compose';
import { stageProject } from './stage';

const P = 'hyperframes';

export interface HyperframesOptions {
  storage: StorageProvider;
  /** Parent dir for per-render temp projects. Keep it outside OneDrive (e.g. <ADFORGE_DATA_DIR>/render-work). */
  workDir: string;
  /** Hard deadline per render; Chrome/FFmpeg are aborted when it passes. Default 15 min. */
  renderTimeoutMs?: number;
  quality?: 'draft' | 'standard' | 'high';
}

const failed = (code: ProviderError['code'], message: string, raw?: unknown): ProviderResult<never> => {
  const error = new ProviderError(P, code, message, raw);
  return { status: 'failed', error, retryable: isRetryable(code) };
};

export class HyperframesRenderer implements RendererProvider {
  readonly id = P;
  constructor(private readonly o: HyperframesOptions) {}

  async render(req: RenderRequest): Promise<ProviderResult<MediaRef>> {
    const parsed = VideoSpec.safeParse(req.spec);
    if (!parsed.success) return failed('INVALID_INPUT', `Invalid VideoSpec: ${parsed.error.issues.map((i) => i.message).join('; ')}`);
    const spec = parsed.data;

    await mkdir(this.o.workDir, { recursive: true });
    const dir = await mkdtemp(join(this.o.workDir, 'project-'));
    const deadline = AbortSignal.timeout(this.o.renderTimeoutMs ?? 15 * 60_000);
    const started = Date.now();
    try {
      await stageProject(spec, this.o.storage, dir);
      await writeFile(join(dir, 'index.html'), composeHtml(spec));
      const out = join(dir, 'out.mp4');

      const job = createRenderJob({ fps: { num: spec.fps, den: 1 }, quality: this.o.quality ?? 'standard', format: 'mp4' });
      try {
        await executeRenderJob(job, dir, out, undefined, deadline);
      } catch (e) {
        if (deadline.aborted) return failed('TIMEOUT', `Render ${req.idempotencyKey} exceeded ${this.o.renderTimeoutMs ?? 900_000}ms`, e);
        return failed('UPSTREAM', `Render ${req.idempotencyKey} failed: ${(e as Error).message}`, e);
      }
      if (deadline.aborted) return failed('TIMEOUT', `Render ${req.idempotencyKey} exceeded its deadline`);
      if (job.status === 'failed' || job.status === 'cancelled') {
        return failed('UPSTREAM', `Render ${req.idempotencyKey} ${job.status} at ${job.failedStage ?? 'unknown stage'}: ${job.error ?? 'no error message'}`);
      }
      const info = await stat(out).catch(() => null);
      if (!info || info.size === 0) return failed('UPSTREAM', `Render ${req.idempotencyKey} produced no output file`);

      const ref = await this.o.storage.put(await readFile(out), {
        mime: 'video/mp4',
        width: spec.width,
        height: spec.height,
        durationSec: spec.durationInFrames / spec.fps,
      });
      return { status: 'done', value: ref, cost: { amountUsd: 0, estimated: false }, latencyMs: Date.now() - started };
    } catch (e) {
      if (e instanceof ProviderError) return { status: 'failed', error: e, retryable: isRetryable(e.code) };
      if (deadline.aborted) return failed('TIMEOUT', `Render ${req.idempotencyKey} exceeded its deadline`, e);
      // Staging errors (missing asset key) are input problems, not transient ones.
      if (/Render asset missing/.test((e as Error).message)) return failed('INVALID_INPUT', (e as Error).message, e);
      throw e;
    } finally {
      // ponytail: drainBrowserPool is process-global — assumes renders are serialized (P7 heavy lane, concurrency 1); add an in-flight counter if renders ever run concurrently in one process.
      await drainBrowserPool().catch(() => {});
      await rm(dir, { recursive: true, force: true }).catch(() => {}); // EBUSY/EPERM on Windows must not mask the result
    }
  }
}
