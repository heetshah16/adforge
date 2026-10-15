import { describe, expect, it } from 'vitest';
import { ProviderError } from '@adforge/core/providers/types';
import { ComfyClient, promptIdFor, type HistoryEntry } from '../src/client';
import { collect, pngSize, submitOnce, waitFor } from '../src/job';
import { loadWorkflow } from '../src/workflows';
import { fakeFetch, fixture, json, memoryStorage, pngBytes } from './helpers';

const BASE = 'http://127.0.0.1:8188';
const plate = loadWorkflow('plate-flux-schnell').json;
const broll = loadWorkflow('broll-wan22-5b').json;
const IMAGE_OUT = { title: 'out:image', mime: 'image/png' } as const;

/** The recorded plate entry, re-keyed to `id`, with optional message overrides. */
function plateEntry(id: string, messages?: [string, Record<string, unknown>][]) {
  const rec = fixture('plate-flux-schnell.history.json') as Record<string, HistoryEntry>;
  const entry = structuredClone(Object.values(rec)[0]!);
  if (messages) entry.status = { ...entry.status!, status_str: 'error', messages };
  return { [id]: entry };
}

describe('submitOnce', () => {
  it('queues a fresh job under the id derived from the key', async () => {
    const id = promptIdFor('k1');
    const f = fakeFetch({
      [`GET /history/${id}`]: () => json({}),
      'GET /queue': () => json({ queue_running: [], queue_pending: [] }),
      'POST /prompt': () => json({ prompt_id: id, number: 1, node_errors: {} }),
    });
    expect(await submitOnce(new ComfyClient(BASE, f), plate, 'k1')).toBe(id);
    expect(f.bodies['POST /prompt']?.[0]).toMatchObject({ prompt_id: id });
  });

  it('does not queue again when the job already finished', async () => {
    const id = promptIdFor('k2');
    const f = fakeFetch({ [`GET /history/${id}`]: () => json(plateEntry(id)) });
    expect(await submitOnce(new ComfyClient(BASE, f), plate, 'k2')).toBe(id);
    expect(f.calls).not.toContain('POST /prompt');
  });

  it('does not queue again when the job is still queued', async () => {
    const id = promptIdFor('k3');
    const f = fakeFetch({
      [`GET /history/${id}`]: () => json({}),
      'GET /queue': () => json({ queue_running: [[1, id, {}]], queue_pending: [] }),
    });
    await submitOnce(new ComfyClient(BASE, f), plate, 'k3');
    expect(f.calls).not.toContain('POST /prompt');
  });
});

describe('collect', () => {
  it('downloads the output, stores it, and reports execution time', async () => {
    const id = 'p1';
    const storage = memoryStorage();
    const f = fakeFetch({
      [`GET /history/${id}`]: () => json(plateEntry(id)),
      'GET /view': () => new Response(pngBytes(768, 1344)),
    });
    const r = await collect(new ComfyClient(BASE, f), storage, plate, id, IMAGE_OUT);
    expect(r.status).toBe('done');
    if (r.status !== 'done') return;
    expect(r.value).toMatchObject({ mime: 'image/png', width: 768, height: 1344 });
    expect(r.value.url).toMatch(/^http:\/\/localhost:3000\/media\//);
    expect(r.latencyMs).toBe(1792044731145 - 1792044726228);
    expect(r.cost).toEqual({ amountUsd: 0, estimated: false });
    expect(storage.files.size).toBe(1);
  });

  it('stores video with the size and duration it is told', async () => {
    const rec = fixture('broll-wan22-5b.history.json') as Record<string, HistoryEntry>;
    const id = Object.keys(rec)[0]!;
    const f = fakeFetch({
      [`GET /history/${id}`]: () => json(rec),
      'GET /view': () => new Response(new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112])),
    });
    const r = await collect(new ComfyClient(BASE, f), memoryStorage(), broll, id, {
      title: 'out:video',
      mime: 'video/mp4',
      width: 704,
      height: 1280,
      durationSec: () => 121 / 24,
    });
    expect(r.status === 'done' && r.value).toMatchObject({ mime: 'video/mp4', width: 704, height: 1280, durationSec: 121 / 24 });
  });

  it('is pending while the job is queued', async () => {
    const f = fakeFetch({
      'GET /history/p2': () => json({}),
      'GET /queue': () => json({ queue_running: [[1, 'p2', {}]], queue_pending: [] }),
    });
    const r = await collect(new ComfyClient(BASE, f), memoryStorage(), plate, 'p2', IMAGE_OUT);
    expect(r).toMatchObject({ status: 'pending', handle: { provider: 'comfyui', externalId: 'p2' } });
  });

  it('reports a job lost to a restart as a retryable failure', async () => {
    const f = fakeFetch({
      'GET /history/p3': () => json({}),
      'GET /queue': () => json({ queue_running: [], queue_pending: [] }),
    });
    const r = await collect(new ComfyClient(BASE, f), memoryStorage(), plate, 'p3', IMAGE_OUT);
    expect(r.status === 'failed' && r.retryable).toBe(true);
    expect(r.status === 'failed' && r.error.message).toContain('neither queued nor in history');
  });

  it('does not call a job lost when it finishes between the two checks', async () => {
    let historyCalls = 0;
    const f = fakeFetch({
      'GET /history/p4': () => json(historyCalls++ === 0 ? {} : plateEntry('p4')),
      'GET /queue': () => json({ queue_running: [], queue_pending: [] }),
      'GET /view': () => new Response(pngBytes(768, 1344)),
    });
    const r = await collect(new ComfyClient(BASE, f), memoryStorage(), plate, 'p4', IMAGE_OUT);
    expect(r.status).toBe('done');
  });

  it('maps an execution error to a retryable UPSTREAM failure with the exception text', async () => {
    const f = fakeFetch({
      'GET /history/p5': () =>
        json(plateEntry('p5', [['execution_error', { node_id: '5', node_type: 'KSampler', exception_message: 'CUDA out of memory' }]])),
    });
    const r = await collect(new ComfyClient(BASE, f), memoryStorage(), plate, 'p5', IMAGE_OUT);
    expect(r.status === 'failed' && r.error.code).toBe('UPSTREAM');
    expect(r.status === 'failed' && r.retryable).toBe(true);
    expect(r.status === 'failed' && r.error.message).toContain('CUDA out of memory');
  });

  it('treats an interrupted job as not retryable', async () => {
    const f = fakeFetch({ 'GET /history/p6': () => json(plateEntry('p6', [['execution_interrupted', { node_id: '5' }]])) });
    const r = await collect(new ComfyClient(BASE, f), memoryStorage(), plate, 'p6', IMAGE_OUT);
    expect(r.status === 'failed' && r.retryable).toBe(false);
  });

  it('fails cleanly when the image output is not a PNG', async () => {
    const f = fakeFetch({
      'GET /history/p7': () => json(plateEntry('p7')),
      'GET /view': () => new Response(new Uint8Array([1, 2, 3])),
    });
    const r = await collect(new ComfyClient(BASE, f), memoryStorage(), plate, 'p7', IMAGE_OUT);
    expect(r.status === 'failed' && r.error.message).toContain('not a PNG');
  });

  it('turns an unreachable server into a retryable failure instead of throwing', async () => {
    const down = (async () => {
      throw new TypeError('fetch failed');
    }) as typeof fetch;
    const r = await collect(new ComfyClient(BASE, down), memoryStorage(), plate, 'p8', IMAGE_OUT);
    expect(r.status === 'failed' && r.retryable).toBe(true);
  });
});

describe('waitFor', () => {
  const pending = { status: 'pending', handle: { provider: 'comfyui', externalId: 'x', pollAfterMs: 1 } } as const;

  it('polls until a terminal result', async () => {
    let n = 0;
    const done = { status: 'done', value: {} as never, cost: { amountUsd: 0, estimated: false }, latencyMs: 1 } as const;
    const r = await waitFor(async () => (++n < 3 ? pending : done), { timeoutMs: 1000, intervalMs: 1, sleep: async () => {} });
    expect(r.status).toBe('done');
    expect(n).toBe(3);
  });

  it('times out as a retryable TIMEOUT', async () => {
    const r = await waitFor(async () => pending, { timeoutMs: 0, intervalMs: 1, sleep: async () => {} });
    expect(r.status === 'failed' && r.error.code).toBe('TIMEOUT');
    expect(r.status === 'failed' && r.retryable).toBe(true);
  });
});

describe('pngSize', () => {
  it('reads IHDR dimensions and rejects non-PNG bytes', () => {
    expect(pngSize(pngBytes(704, 1280))).toEqual({ width: 704, height: 1280 });
    expect(() => pngSize(new Uint8Array(30))).toThrow(ProviderError);
  });
});
