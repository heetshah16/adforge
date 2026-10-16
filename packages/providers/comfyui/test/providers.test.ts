import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ProviderError, type VideoGenRequest } from '@adforge/core/providers/types';
import { promptIdFor } from '../src/client';
import { createComfyProviders } from '../src/providers';
import { fakeFetch, fixture, json, memoryStorage, pngBytes } from './helpers';

const BASE = 'http://127.0.0.1:8188';
const opts = {
  baseUrl: BASE,
  plateWorkflow: 'plate-flux-schnell',
  cutoutWorkflow: 'cutout-birefnet',
  brollWorkflow: 'broll-wan22-5b',
  sleep: async () => {},
  pollIntervalMs: 1,
};
const empty = { queue_running: [], queue_pending: [] };

/** Serves a fresh job: not found → queued → finished with the recorded entry for `name`. */
function jobRoutes(key: string, name: string, viewBytes: Uint8Array) {
  const id = promptIdFor(key);
  const rec = fixture(`${name}.history.json`) as Record<string, unknown>;
  let submitted = false;
  return {
    [`GET /history/${id}`]: () => json(submitted ? { [id]: Object.values(rec)[0] } : {}),
    'GET /queue': () => json(empty),
    'POST /prompt': () => {
      submitted = true;
      return json({ prompt_id: id, number: 1, node_errors: {} });
    },
    'GET /view': () => new Response(viewBytes),
  };
}

describe('createComfyProviders', () => {
  it('fails at construction on an unknown workflow', () => {
    expect(() => createComfyProviders({ ...opts, storage: memoryStorage(), plateWorkflow: 'plate-sdxl' })).toThrow(
      'Unknown plate workflow "plate-sdxl"',
    );
  });

  it('exposes workflow file hashes for the job config snapshot', () => {
    const { workflowHashes } = createComfyProviders({ ...opts, storage: memoryStorage() });
    expect(Object.keys(workflowHashes).sort()).toEqual(['broll-wan22-5b', 'cutout-birefnet', 'plate-flux-schnell']);
    expect(workflowHashes['plate-flux-schnell']).toMatch(/^[0-9a-f]{64}$/);
  });

  it('hashes line-ending-normalized text, so CRLF and LF checkouts agree', () => {
    const text = readFileSync(new URL('../workflows/plate-flux-schnell.json', import.meta.url), 'utf8').replaceAll('\r\n', '\n');
    const { workflowHashes } = createComfyProviders({ ...opts, storage: memoryStorage() });
    expect(workflowHashes['plate-flux-schnell']).toBe(createHash('sha256').update(text).digest('hex'));
  });

  it('preflight propagates ProviderError when ComfyUI is down', async () => {
    const down = (async () => {
      throw new TypeError('fetch failed');
    }) as typeof fetch;
    const { preflight } = createComfyProviders({ ...opts, storage: memoryStorage(), fetchImpl: down });
    await expect(preflight()).rejects.toBeInstanceOf(ProviderError);
  });
});

describe('image provider', () => {
  it('patches the plate workflow, waits, and returns an internal MediaRef', async () => {
    const f = fakeFetch(jobRoutes('img1', 'plate-flux-schnell', pngBytes(768, 1344)));
    const { image } = createComfyProviders({ ...opts, storage: memoryStorage(), fetchImpl: f });
    const r = await image.generate({ prompt: 'a kitchen', width: 768, height: 1344, idempotencyKey: 'img1' });
    expect(r.status).toBe('done');
    expect(r.status === 'done' && r.value).toMatchObject({ mime: 'image/png', width: 768, height: 1344 });
    const body = f.bodies['POST /prompt']?.[0] as { prompt: Record<string, { inputs: Record<string, unknown>; _meta: { title: string } }> };
    const byTitle = (t: string) => Object.values(body.prompt).find((n) => n._meta.title === t)!.inputs;
    expect(byTitle('in:prompt').text).toBe('a kitchen');
    expect(byTitle('in:size')).toMatchObject({ width: 768, height: 1344 });
  });

  it('patches a requested 512x896 size into in:size', async () => {
    const f = fakeFetch(jobRoutes('img-size', 'plate-flux-schnell', pngBytes(512, 896)));
    const { image } = createComfyProviders({ ...opts, storage: memoryStorage(), fetchImpl: f });
    await image.generate({ prompt: 'p', width: 512, height: 896, idempotencyKey: 'img-size' });
    const body = f.bodies['POST /prompt']?.[0] as { prompt: Record<string, { inputs: Record<string, unknown>; _meta: { title: string } }> };
    expect(Object.values(body.prompt).find((n) => n._meta.title === 'in:size')!.inputs).toMatchObject({ width: 512, height: 896 });
  });

  it('does not count time spent queued against syncTimeoutMs', async () => {
    const id = promptIdFor('img-q');
    const inner = jobRoutes('img-q', 'plate-flux-schnell', pngBytes(768, 1344));
    const rec = Object.values(fixture('plate-flux-schnell.history.json') as Record<string, unknown>)[0];
    let queueCalls = 0;
    const f = fakeFetch({
      ...inner,
      // Call 1 is submitOnce's check; calls 2-4 are the queue wait; the job finishes once it leaves the queue.
      'GET /queue': () => (++queueCalls >= 2 && queueCalls <= 4 ? json({ queue_running: [], queue_pending: [[1, id, {}]] }) : json(empty)),
      [`GET /history/${id}`]: () => json(queueCalls >= 5 ? { [id]: rec } : {}),
    });
    const { image } = createComfyProviders({ ...opts, storage: memoryStorage(), fetchImpl: f, syncTimeoutMs: 0 });
    const r = await image.generate({ prompt: 'p', width: 768, height: 1344, idempotencyKey: 'img-q' });
    expect(r.status).toBe('done');
    expect(queueCalls).toBeGreaterThanOrEqual(5);
  });

  it('derives the same seed from the same key when none is given', async () => {
    const seeds: unknown[] = [];
    for (let run = 0; run < 2; run++) {
      const f = fakeFetch(jobRoutes('seed-key', 'plate-flux-schnell', pngBytes(768, 1344)));
      const { image } = createComfyProviders({ ...opts, storage: memoryStorage(), fetchImpl: f });
      await image.generate({ prompt: 'p', width: 768, height: 1344, idempotencyKey: 'seed-key' });
      const body = f.bodies['POST /prompt']?.[0] as { prompt: Record<string, { inputs: { seed?: unknown }; _meta: { title: string } }> };
      seeds.push(Object.values(body.prompt).find((n) => n._meta.title === 'in:seed')!.inputs.seed);
    }
    expect(seeds[0]).toBe(seeds[1]);
    expect(typeof seeds[0]).toBe('number');
  });

  it('a retry with the same key returns the first job instead of rendering again', async () => {
    const f = fakeFetch(jobRoutes('img2', 'plate-flux-schnell', pngBytes(768, 1344)));
    const { image } = createComfyProviders({ ...opts, storage: memoryStorage(), fetchImpl: f });
    await image.generate({ prompt: 'p', width: 768, height: 1344, idempotencyKey: 'img2' });
    await image.generate({ prompt: 'p', width: 768, height: 1344, idempotencyKey: 'img2' });
    expect(f.calls.filter((c) => c === 'POST /prompt')).toHaveLength(1);
  });

  it('rejects an invalid size before any network call', async () => {
    const f = fakeFetch({});
    const { image } = createComfyProviders({ ...opts, storage: memoryStorage(), fetchImpl: f });
    const r = await image.generate({ prompt: 'p', width: 770, height: 1344, idempotencyKey: 'img3' });
    expect(r.status === 'failed' && r.error.code).toBe('INVALID_INPUT');
    expect(r.status === 'failed' && r.retryable).toBe(false);
    expect(f.calls).toEqual([]);
  });

  it('times out as retryable TIMEOUT when the job never finishes', async () => {
    const id = promptIdFor('img4');
    const f = fakeFetch({
      [`GET /history/${id}`]: () => json({}),
      'GET /queue': () => json({ queue_running: [[1, id, {}]], queue_pending: [] }),
    });
    const { image } = createComfyProviders({ ...opts, storage: memoryStorage(), fetchImpl: f, syncTimeoutMs: 0 });
    const r = await image.generate({ prompt: 'p', width: 768, height: 1344, idempotencyKey: 'img4' });
    expect(r.status === 'failed' && r.error.code).toBe('TIMEOUT');
  });
});

describe('cutout provider', () => {
  it('uploads the stored photo and uses the name ComfyUI returned', async () => {
    const storage = memoryStorage();
    const photo = await storage.put(pngBytes(768, 1344), { mime: 'image/png' });
    const routes = jobRoutes('cut1', 'cutout-birefnet', pngBytes(768, 1344));
    const f = fakeFetch({
      ...routes,
      'POST /upload/image': async (req) => {
        expect(((await req.formData()).get('image') as File).name).toBe(`${photo.sha256}.png`);
        return json({ name: `${photo.sha256} (1).png`, subfolder: '', type: 'input' });
      },
    });
    const { cutout } = createComfyProviders({ ...opts, storage, fetchImpl: f });
    const r = await cutout.cutout({ image: photo, idempotencyKey: 'cut1' });
    expect(r.status).toBe('done');
    const body = f.bodies['POST /prompt']?.[0] as { prompt: Record<string, { inputs: { image?: unknown }; _meta: { title: string } }> };
    expect(Object.values(body.prompt).find((n) => n._meta.title === 'in:image')!.inputs.image).toBe(`${photo.sha256} (1).png`);
  });

  it('rejects a non-image input', async () => {
    const storage = memoryStorage();
    const clip = await storage.put(new Uint8Array([1]), { mime: 'video/mp4' });
    const { cutout } = createComfyProviders({ ...opts, storage, fetchImpl: fakeFetch({}) });
    const r = await cutout.cutout({ image: clip, idempotencyKey: 'cut2' });
    expect(r.status === 'failed' && r.error.code).toBe('INVALID_INPUT');
  });
});

describe('video provider', () => {
  const frame = { id: 'ab/x.png', url: 'u', mime: 'image/png', sha256: 'x', bytes: 1 };
  const valid: VideoGenRequest = {
    mode: 'image_to_video',
    prompt: 'drifting light',
    firstFrame: frame,
    durationSec: 5,
    aspectRatio: '9:16',
    resolution: '720p',
    idempotencyKey: 'vid1',
  };

  it('declares only what the workflow can do', () => {
    const { video } = createComfyProviders({ ...opts, storage: memoryStorage() });
    expect(video.capabilities).toMatchObject({ modes: ['image_to_video'], resolutions: ['720p'], maxDurationSec: 5 });
  });

  for (const [label, patch] of [
    ['text_to_video mode', { mode: 'text_to_video' }],
    ['16:9 aspect', { aspectRatio: '16:9' }],
    ['6s duration', { durationSec: 6 }],
    ['missing first frame', { firstFrame: undefined }],
  ] as const) {
    it(`throws INVALID_INPUT before dispatch for ${label}`, async () => {
      const f = fakeFetch({});
      const { video } = createComfyProviders({ ...opts, storage: memoryStorage(), fetchImpl: f });
      const err = await video.submit({ ...valid, ...patch } as VideoGenRequest).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ProviderError);
      expect((err as ProviderError).code).toBe('INVALID_INPUT');
      expect(f.calls).toEqual([]);
    });
  }

  it('submits 49 frames for a 2s clip', async () => {
    const storage = memoryStorage();
    const ref = await storage.put(pngBytes(768, 1344), { mime: 'image/png' });
    const f = fakeFetch({
      ...jobRoutes('vid-2s', 'broll-wan22-5b', new Uint8Array([0])),
      'POST /upload/image': () => json({ name: 'frame.png', subfolder: '', type: 'input' }),
    });
    const { video } = createComfyProviders({ ...opts, storage, fetchImpl: f });
    await video.submit({ ...valid, firstFrame: ref, durationSec: 2, idempotencyKey: 'vid-2s' });
    const body = f.bodies['POST /prompt']?.[0] as { prompt: Record<string, { inputs: Record<string, unknown>; _meta: { title: string } }> };
    expect(Object.values(body.prompt).find((n) => n._meta.title === 'in:size')!.inputs.length).toBe(49);
  });

  it('polls a still-queued job as pending with a 15s hint', async () => {
    const id = promptIdFor('vid-q');
    const f = fakeFetch({
      [`GET /history/${id}`]: () => json({}),
      'GET /queue': () => json({ queue_running: [], queue_pending: [[1, id, {}]] }),
    });
    const { video } = createComfyProviders({ ...opts, storage: memoryStorage(), fetchImpl: f });
    const r = await video.poll({ provider: 'comfyui', externalId: id, pollAfterMs: 15_000 });
    expect(r.status === 'pending' && r.handle.pollAfterMs).toBe(15000);
  });

  it('submits 121 frames at 704x1280 for 5s and polls to a stored mp4', async () => {
    const storage = memoryStorage();
    const ref = await storage.put(pngBytes(768, 1344), { mime: 'image/png' });
    const f = fakeFetch({
      ...jobRoutes('vid1', 'broll-wan22-5b', new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112])),
      'POST /upload/image': () => json({ name: 'frame.png', subfolder: '', type: 'input' }),
    });
    const { video } = createComfyProviders({ ...opts, storage, fetchImpl: f });
    const handle = await video.submit({ ...valid, firstFrame: ref });
    expect(handle).toMatchObject({ provider: 'comfyui', externalId: promptIdFor('vid1') });
    const body = f.bodies['POST /prompt']?.[0] as { prompt: Record<string, { inputs: Record<string, unknown>; _meta: { title: string } }> };
    expect(Object.values(body.prompt).find((n) => n._meta.title === 'in:size')!.inputs).toMatchObject({
      width: 704,
      height: 1280,
      length: 121,
    });
    const r = await video.poll(handle);
    expect(r.status === 'done' && r.value).toMatchObject({ mime: 'video/mp4', width: 704, height: 1280 });
    expect(r.status === 'done' && r.value.durationSec).toBeCloseTo(121 / 24, 5);
  });
});

describe('systemStats', () => {
  it('reports only VRAM used/total, summed over devices', async () => {
    const f = fakeFetch({
      'GET /system_stats': () =>
        json({ system: { os: 'nt' }, devices: [{ name: 'cuda:0', type: 'cuda', vram_total: 16_000, vram_free: 4_000 }, { name: 'cuda:1', type: 'cuda', vram_total: 8_000, vram_free: 8_000 }] }),
    });
    const { systemStats } = createComfyProviders({ ...opts, storage: memoryStorage(), fetchImpl: f });
    await expect(systemStats()).resolves.toEqual({ vramUsedBytes: 12_000, vramTotalBytes: 24_000 });
  });

  it('is UPSTREAM when the response has no devices', async () => {
    const f = fakeFetch({ 'GET /system_stats': () => json({}) });
    const { systemStats } = createComfyProviders({ ...opts, storage: memoryStorage(), fetchImpl: f });
    await expect(systemStats()).rejects.toMatchObject({ code: 'UPSTREAM' });
  });
});
