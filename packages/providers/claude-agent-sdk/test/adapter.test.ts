import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { query } from '@anthropic-ai/claude-agent-sdk';
import { ClaudeAgentProvider, buildOptions, classify, mapResult, toUserMessage } from '../src/adapter';

const Schema = z.object({ verdict: z.enum(['yes', 'no']), reason: z.string().min(3) });
const req = {
  system: 'You are a classifier.',
  user: [
    { type: 'image' as const, mime: 'image/png' as const, data: new Uint8Array([1, 2, 3]) },
    { type: 'text' as const, text: 'Is it a bottle?' },
  ],
  schema: Schema,
  model: 'claude-sonnet-5-5',
  effort: 'low' as const,
  idempotencyKey: 'k1',
  timeoutMs: 5_000,
};

const result = (over: Record<string, unknown>) => ({
  type: 'result', subtype: 'success', is_error: false, duration_ms: 1234, num_turns: 1, total_cost_usd: 0.0021,
  usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 80, cache_creation_input_tokens: 0 },
  modelUsage: {}, permission_denials: [], result: '', stop_reason: 'end_turn', ...over,
});

/** A fake `query` that yields the given messages, optionally then throws. */
function fakeQuery(messages: unknown[], thenThrow?: Error): typeof query {
  return (() =>
    (async function* () {
      for (const m of messages) yield m;
      if (thenThrow) throw thenThrow;
    })()) as unknown as typeof query;
}

describe('buildOptions', () => {
  it('disables tools and settings, sets model/effort/schema and never sets sampling params', async () => {
    const o = buildOptions(req, new AbortController(), { maxTurns: 4, cwd: 'TMP' });
    expect(o).not.toHaveProperty('temperature');
    const { abortController, ...rest } = o as Record<string, unknown>;
    expect(abortController).toBeInstanceOf(AbortController);
    await expect(JSON.stringify(rest, null, 2) + '\n').toMatchFileSnapshot('./golden/options.json');
  });
});

describe('toUserMessage', () => {
  it('sends images as base64 Anthropic blocks before the text', () => {
    const m = toUserMessage(req);
    expect(m).toMatchObject({ type: 'user', parent_tool_use_id: null, message: { role: 'user' } });
    expect(m.message.content).toEqual([
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AQID' } },
      { type: 'text', text: 'Is it a bottle?' },
    ]);
  });
});

describe('mapResult', () => {
  it('returns the Zod-validated structured output with usage and estimated cost', () => {
    const r = mapResult(result({ structured_output: { verdict: 'yes', reason: 'glass neck' } }), Schema);
    expect(r).toMatchObject({
      status: 'done',
      value: { value: { verdict: 'yes', reason: 'glass neck' }, usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 80, cacheCreationTokens: 0 } },
      cost: { amountUsd: 0.0021, estimated: true },
      latencyMs: 1234,
    });
  });

  it('treats success without structured_output as a retryable failure', () => {
    const r = mapResult(result({}), Schema);
    expect(r.status === 'failed' && r.error.code).toBe('UPSTREAM');
    expect(r.status === 'failed' && r.retryable).toBe(true);
  });

  it('treats output that fails our Zod refinements as a retryable failure', () => {
    const r = mapResult(result({ structured_output: { verdict: 'yes', reason: 'x' } }), Schema);
    expect(r.status === 'failed' && r.error.message).toMatch(/schema/i);
  });

  it('maps error subtypes, quoting the SDK errors', () => {
    const r = mapResult(result({ subtype: 'error_max_structured_output_retries', is_error: true, errors: ['could not satisfy schema'] }), Schema);
    expect(r.status === 'failed' && r.error.message).toContain('could not satisfy schema');
  });

  it('parses the recorded live result', () => {
    const live = JSON.parse(readFileSync(new URL('../fixtures/result-success.live.json', import.meta.url), 'utf8'));
    const r = mapResult(live, z.object({ verdict: z.enum(['yes', 'no']) }));
    expect(r.status).toBe('done');
  });
});

describe('classify', () => {
  it('recognises usage limits, auth and everything else', () => {
    expect(classify('Claude AI usage limit reached|1792044000')).toBe('RATE_LIMIT');
    expect(classify('API Error: 429 rate_limit_error')).toBe('RATE_LIMIT');
    expect(classify('authentication_failed: please run /login')).toBe('AUTH');
    expect(classify('socket hang up')).toBe('UPSTREAM');
    expect(classify('API Error: 401 invalid key')).toBe('AUTH');
    expect(classify('Please log in')).toBe('AUTH');
  });

  it('does not misread transient text as AUTH', () => {
    expect(classify('catalog index failed')).toBe('UPSTREAM');
    expect(classify('request took 403 ms')).toBe('UPSTREAM');
    expect(classify('backlog increased')).toBe('UPSTREAM');
  });
});

describe('ClaudeAgentProvider.generate', () => {
  it('captures the result even when query throws afterwards', async () => {
    const p = new ClaudeAgentProvider({
      queryImpl: fakeQuery(
        [result({ subtype: 'error_during_execution', is_error: true, errors: ['usage limit reached'] })],
        new Error('Claude Code process exited with code 1'),
      ),
    });
    const r = await p.generate(req);
    expect(r.status === 'failed' && r.error.code).toBe('RATE_LIMIT');
    expect(r.status === 'failed' && r.retryable).toBe(true);
  });

  it('maps an auth failure thrown before any result to non-retryable AUTH', async () => {
    const p = new ClaudeAgentProvider({ queryImpl: fakeQuery([], new Error('authentication_failed')) });
    const r = await p.generate(req);
    expect(r.status === 'failed' && r.error.code).toBe('AUTH');
    expect(r.status === 'failed' && r.retryable).toBe(false);
  });

  it('times out a hung query as a retryable TIMEOUT', async () => {
    const hung = ((args: { options?: { abortController?: AbortController } }) =>
      (async function* () {
        await new Promise((_, reject) =>
          args.options?.abortController?.signal.addEventListener('abort', () => reject(new Error('aborted'))),
        );
      })()) as unknown as typeof query;
    const r = await new ClaudeAgentProvider({ queryImpl: hung }).generate({ ...req, timeoutMs: 30 });
    expect(r.status === 'failed' && r.error.code).toBe('TIMEOUT');
    expect(r.status === 'failed' && r.retryable).toBe(true);
  });

  it('times out even when the generator ignores the abort signal', async () => {
    const stuck = (() => (async function* () { await new Promise(() => {}); })()) as unknown as typeof query;
    const t0 = Date.now();
    const r = await new ClaudeAgentProvider({ queryImpl: stuck }).generate({ ...req, timeoutMs: 30 });
    expect(r.status === 'failed' && r.error.code).toBe('TIMEOUT');
    expect(r.status === 'failed' && r.retryable).toBe(true);
    expect(Date.now() - t0).toBeLessThan(2_000);
  }, 5_000);
});
