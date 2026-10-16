import { tmpdir } from 'node:os';
import { z, type ZodType } from 'zod';
import { query, type Options, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import {
  ProviderError,
  isRetryable,
  type LLMProvider,
  type LLMRequest,
  type LLMResult,
  type ProviderErrorCode,
  type ProviderResult,
} from '@adforge/core/providers/types';

const P = 'claude-agent-sdk';

export interface ClaudeAgentOptions {
  queryImpl?: typeof query;
  /** Structured output uses an internal turn; 4 leaves headroom without allowing tool loops (tools are off). */
  maxTurns?: number;
  /** Defaults to os.tmpdir() so the SDK never picks up this repo's CLAUDE.md. */
  cwd?: string;
}

export function classify(text: string): ProviderErrorCode {
  if (/usage limit|rate[ _-]?limit|\b429\b|too many requests|overloaded/i.test(text)) return 'RATE_LIMIT';
  if (/authentication_failed|oauth|not logged in|log ?in|credential|unauthori[sz]ed|\b401\b|\b403\b/i.test(text)) return 'AUTH';
  return 'UPSTREAM';
}

const fail = (code: ProviderErrorCode, message: string, raw?: unknown): ProviderResult<never> => ({
  status: 'failed',
  error: new ProviderError(P, code, message, raw),
  retryable: isRetryable(code),
});

export function buildOptions<T>(req: LLMRequest<T>, abort: AbortController, o: ClaudeAgentOptions = {}): Options {
  return {
    model: req.model,
    effort: req.effort,
    systemPrompt: req.system,
    tools: [],
    maxTurns: o.maxTurns ?? 4,
    settingSources: [],
    persistSession: false,
    cwd: o.cwd ?? tmpdir(),
    abortController: abort,
    outputFormat: { type: 'json_schema', schema: z.toJSONSchema(req.schema, { target: 'draft-7' }) as Record<string, unknown> },
  } as Options;
}

export function toUserMessage<T>(req: LLMRequest<T>): SDKUserMessage {
  // Images first, then text (Anthropic guidance for vision prompts).
  const images = req.user.filter((c) => c.type === 'image');
  const texts = req.user.filter((c) => c.type === 'text');
  const content = [
    ...images.map((c) => ({
      type: 'image' as const,
      source: { type: 'base64' as const, media_type: c.mime, data: Buffer.from(c.data).toString('base64') },
    })),
    ...texts.map((c) => ({ type: 'text' as const, text: c.text })),
  ];
  return { type: 'user', parent_tool_use_id: null, message: { role: 'user', content } } as SDKUserMessage;
}

type ResultLike = {
  type: string;
  subtype: string;
  structured_output?: unknown;
  errors?: string[];
  duration_ms?: number;
  total_cost_usd?: number;
  usage?: Record<string, number | undefined>;
};

export function mapResult<T>(result: ResultLike, schema: ZodType<T>): ProviderResult<LLMResult<T>> {
  if (result.subtype !== 'success') {
    const text = `${result.subtype}: ${(result.errors ?? []).join('; ')}`;
    return fail(classify(text), `Claude run ended with ${text}`, result);
  }
  if (result.structured_output === undefined) return fail('UPSTREAM', 'Claude run succeeded without structured_output', result);
  const parsed = schema.safeParse(result.structured_output);
  if (!parsed.success) return fail('UPSTREAM', `Claude output failed our schema: ${z.prettifyError(parsed.error)}`, result);
  const u = result.usage ?? {};
  return {
    status: 'done',
    value: {
      value: parsed.data,
      usage: {
        inputTokens: u.input_tokens ?? 0,
        outputTokens: u.output_tokens ?? 0,
        cacheReadTokens: u.cache_read_input_tokens ?? 0,
        cacheCreationTokens: u.cache_creation_input_tokens ?? 0,
      },
    },
    cost: { amountUsd: result.total_cost_usd ?? 0, estimated: true },
    latencyMs: result.duration_ms ?? 0,
  };
}

/** One single-turn, tool-less, schema-constrained call. The only code in AdForge that imports the SDK. */
export class ClaudeAgentProvider implements LLMProvider {
  readonly id = P;
  constructor(private readonly o: ClaudeAgentOptions = {}) {}

  async generate<T>(req: LLMRequest<T>): Promise<ProviderResult<LLMResult<T>>> {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(new Error(`deadline ${req.timeoutMs}ms`)), req.timeoutMs);
    let result: ResultLike | undefined;
    try {
      const prompt = (async function* () {
        yield toUserMessage(req);
      })();
      for await (const m of (this.o.queryImpl ?? query)({ prompt, options: buildOptions(req, abort, this.o) })) {
        if ((m as { type?: string }).type === 'result') result = m as unknown as ResultLike;
      }
    } catch (e) {
      // A single-shot query throws AFTER yielding an error result; prefer the result when we have it.
      if (!result) {
        if (abort.signal.aborted) return fail('TIMEOUT', `Claude call ${req.idempotencyKey} exceeded ${req.timeoutMs}ms`, e);
        const text = (e as Error).message ?? String(e);
        return fail(classify(text), `Claude call ${req.idempotencyKey} failed: ${text}`, e);
      }
    } finally {
      clearTimeout(timer);
    }
    if (!result) return fail(abort.signal.aborted ? 'TIMEOUT' : 'UPSTREAM', `Claude call ${req.idempotencyKey} produced no result message`);
    return mapResult(result, req.schema);
  }
}
