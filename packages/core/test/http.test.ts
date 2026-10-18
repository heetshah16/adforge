import { describe, expect, it } from 'vitest';
import { ProviderError } from '../src/providers/types';
import { classifyFailure, classifyStatus, fetchWithDeadline, readClassified } from '../src/providers/http';

const u = 'http://h:1/x';
const run = (fetchImpl: typeof fetch, timeoutMs = 30) => fetchWithDeadline({ provider: 'p', label: 'svc', fetchImpl, url: u, timeoutMs });

describe('classifyStatus', () => {
  it.each([[400, 'INVALID_INPUT'], [404, 'INVALID_INPUT'], [413, 'INVALID_INPUT'], [422, 'INVALID_INPUT'], [500, 'UPSTREAM'], [503, 'UPSTREAM'], [429, 'UPSTREAM']])('%i -> %s', (s, c) => expect(classifyStatus(s)).toBe(c));
});

describe('classifyFailure', () => {
  it('maps abort and timeout names to TIMEOUT, others to UPSTREAM', () => {
    expect(classifyFailure('p', 'svc', Object.assign(new Error('x'), { name: 'TimeoutError' }), 'GET /x', 5).code).toBe('TIMEOUT');
    expect(classifyFailure('p', 'svc', Object.assign(new Error('x'), { name: 'AbortError' }), 'GET /x', 5).code).toBe('TIMEOUT');
    expect(classifyFailure('p', 'svc', new Error('reset'), 'GET /x', 5)).toMatchObject({ code: 'UPSTREAM', message: expect.stringContaining('reset') });
  });
});

describe('fetchWithDeadline', () => {
  it('returns an ok response and maps non-ok statuses', async () => {
    expect((await run((async () => new Response('ok')) as typeof fetch)).status).toBe(200);
    await expect(run((async () => new Response('bad', { status: 422 })) as typeof fetch)).rejects.toMatchObject({ code: 'INVALID_INPUT', message: expect.stringContaining('bad') });
    await expect(run((async () => new Response('boom', { status: 502 })) as typeof fetch)).rejects.toMatchObject({ code: 'UPSTREAM' });
  });
  it('truncates long error details', async () => {
    const e = await run((async () => new Response('z'.repeat(2000), { status: 500 })) as typeof fetch).catch((x) => x as ProviderError) as ProviderError;
    expect(e.message.length).toBeLessThan(600);
  });
  it('a hung fetch becomes TIMEOUT', async () => {
    const hung = ((_u: unknown, init?: RequestInit) => new Promise((_r, rej) => init!.signal!.addEventListener('abort', () => rej(init!.signal!.reason)))) as unknown as typeof fetch;
    await expect(run(hung)).rejects.toMatchObject({ code: 'TIMEOUT' });
  });
  it('a stalled body read under readClassified becomes TIMEOUT', async () => {
    const stall = ((_u: unknown, init?: RequestInit) => Promise.resolve(new Response(new ReadableStream({ start(c) { init!.signal!.addEventListener('abort', () => c.error(init!.signal!.reason)); } })))) as unknown as typeof fetch;
    const res = await run(stall);
    await expect(readClassified('p', 'svc', 'GET /x', 30, () => res.arrayBuffer())).rejects.toMatchObject({ code: 'TIMEOUT' });
  });
  it('readClassified passes ProviderErrors through untouched', async () => {
    const pe = new ProviderError('p', 'AUTH', 'no');
    await expect(readClassified('p', 'svc', 'x', 1, async () => { throw pe; })).rejects.toBe(pe);
  });
});
