import { describe, expect, it } from 'vitest';
import { ProviderError } from '@adforge/core/providers/types';
import { ComfyClient, promptIdFor } from '../src/client';
import { loadWorkflow } from '../src/workflows';
import { fakeFetch, fixture, json } from './helpers';

const BASE = 'http://127.0.0.1:8188';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe('promptIdFor', () => {
  it('is a canonical lowercase UUID, stable per key, distinct across keys', () => {
    expect(promptIdFor('job1:plate:0')).toMatch(UUID);
    expect(promptIdFor('job1:plate:0')).toBe(promptIdFor('job1:plate:0'));
    expect(promptIdFor('job1:plate:0')).not.toBe(promptIdFor('job1:plate:1'));
  });
});

describe('ComfyClient', () => {
  it('maps a missing-model 400 to INVALID_INPUT naming the node title and file', async () => {
    const rec = fixture('prompt-missing-model.400.json') as { status: number; body: unknown };
    const client = new ComfyClient(BASE, fakeFetch({ 'POST /prompt': () => json(rec.body, rec.status) }));
    const { json: wf } = loadWorkflow('broll-wan22-5b');
    const err = await client.queuePrompt(wf, promptIdFor('k')).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).code).toBe('INVALID_INPUT');
    expect((err as ProviderError).message).toContain('unet (UNETLoader)');
    expect((err as ProviderError).message).toContain('wan2.2_ti2v_5B_fp16.safetensors');
  });

  it('sends the prompt_id it was given', async () => {
    const f = fakeFetch({ 'POST /prompt': () => json({ prompt_id: 'x', number: 1, node_errors: {} }) });
    await new ComfyClient(BASE, f).queuePrompt({}, promptIdFor('k'));
    expect(f.bodies['POST /prompt']?.[0]).toMatchObject({ prompt_id: promptIdFor('k') });
  });

  for (const name of ['plate-flux-schnell', 'cutout-birefnet', 'broll-wan22-5b']) {
    it(`parses the recorded ${name} history entry`, async () => {
      const rec = fixture(`${name}.history.json`) as Record<string, unknown>;
      const id = Object.keys(rec)[0]!;
      const client = new ComfyClient(BASE, fakeFetch({ [`GET /history/${id}`]: () => json(rec) }));
      const entry = await client.history(id);
      expect(entry?.status?.status_str).toBe('success');
      expect(Object.keys(entry!.outputs).length).toBeGreaterThan(0);
    });
  }

  it('returns null for an id not in history', async () => {
    const client = new ComfyClient(BASE, fakeFetch({ 'GET /history/abc': () => json({}) }));
    expect(await client.history('abc')).toBeNull();
  });

  it('reports an unreachable server as UPSTREAM naming the URL', async () => {
    const down = (async () => {
      throw new TypeError('fetch failed');
    }) as typeof fetch;
    const err = await new ComfyClient(BASE, down).systemStats().catch((e: unknown) => e);
    expect((err as ProviderError).code).toBe('UPSTREAM');
    expect((err as ProviderError).message).toContain(BASE);
  });

  it('rejects an unexpected response shape as UPSTREAM', async () => {
    const client = new ComfyClient(BASE, fakeFetch({ 'GET /history/abc': () => json({ abc: { outputs: 5 } }) }));
    const err = await client.history('abc').catch((e: unknown) => e);
    expect((err as ProviderError).code).toBe('UPSTREAM');
    expect((err as ProviderError).message).toContain('Unexpected /history/abc response');
  });

  it('finds an id among running and pending jobs', async () => {
    const client = new ComfyClient(
      BASE,
      fakeFetch({ 'GET /queue': () => json({ queue_running: [[1, 'run-id', {}]], queue_pending: [[2, 'wait-id', {}]] }) }),
    );
    expect(await client.isQueued('run-id')).toBe(true);
    expect(await client.isQueued('wait-id')).toBe(true);
    expect(await client.isQueued('other')).toBe(false);
  });

  it('uploads multipart and returns the name the server chose', async () => {
    const f = fakeFetch({
      'POST /upload/image': async (req) => {
        const form = await req.formData();
        expect(form.get('overwrite')).toBe('true');
        expect((form.get('image') as File).name).toBe('abc.png');
        return json({ name: 'abc (1).png', subfolder: '', type: 'input' });
      },
    });
    expect(await new ComfyClient(BASE, f).uploadImage(new Uint8Array([1, 2]), 'abc.png')).toBe('abc (1).png');
  });

  it('downloads an output file through /view', async () => {
    const f = fakeFetch({ 'GET /view': () => new Response(new Uint8Array([9, 8, 7])) });
    const bytes = await new ComfyClient(BASE, f).view({ filename: 'a.png', subfolder: 'adforge', type: 'output' });
    expect([...bytes]).toEqual([9, 8, 7]);
  });
});
