import { z } from 'zod';
import { ProviderError } from '@adforge/core/providers/types';

const P = 'vision-service';
const MAX_DETAIL = 500;
/** Deterministic client errors: resending the same request cannot succeed. */
const INVALID_STATUS = new Set([400, 404, 413, 422]);
export const CALL_TIMEOUT_MS = 120_000;
/** Until one request has succeeded the service may still be downloading/loading weights. */
export const LOAD_TIMEOUT_MS = 900_000;

const Health = z.object({ ok: z.boolean(), device: z.string(), cuda: z.boolean(), loaded: z.object({ depth: z.boolean(), ocr: z.boolean() }), allocated_mb: z.number() });
const Ocr = z.object({ items: z.array(z.object({ text: z.string(), box: z.tuple([z.number(), z.number(), z.number(), z.number()]), conf: z.number() })) });
const Luma = z.object({ grid: z.array(z.array(z.number())) });
const Unloaded = z.object({ unloaded: z.array(z.string()) });
const Dim = z.coerce.number().int().positive();

/** A timed-out or aborted signal is TIMEOUT, anything else UPSTREAM. */
function classify(e: unknown, what: string, timeoutMs: number): ProviderError {
  const name = (e as Error | undefined)?.name;
  if (name === 'TimeoutError' || name === 'AbortError') return new ProviderError(P, 'TIMEOUT', `vision service ${what} timed out after ${timeoutMs}ms`, e);
  return new ProviderError(P, 'UPSTREAM', `vision service ${what} failed: ${(e as Error | undefined)?.message ?? String(e)}`, e);
}

export class VisionClient {
  private readonly baseUrl: string;
  private warm = false;
  /** timeoutMs overrides both budgets (tests); otherwise 900 s until the first success, 120 s after. */
  constructor(baseUrl: string, private readonly fetchImpl: typeof fetch = fetch, private readonly timeoutMs?: number) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
  }

  #budget = () => this.timeoutMs ?? (this.warm ? CALL_TIMEOUT_MS : LOAD_TIMEOUT_MS);

  /** Every body read goes through here, so a stall or reset is classified, never leaked raw. */
  async #read<T>(path: string, ms: number, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof ProviderError) throw e;
      throw classify(e, path, ms);
    }
  }

  /** The signal covers headers and body, so callers read the body via #read. */
  async #request(path: string, init?: RequestInit): Promise<{ res: Response; ms: number }> {
    const what = `${init?.method ?? 'GET'} ${path}`;
    const ms = this.#budget();
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}${path}`, { ...init, signal: AbortSignal.timeout(ms) });
    } catch (e) {
      throw classify(e, `${what} (${this.baseUrl})`, ms);
    }
    if (!res.ok) {
      const detail = (await this.#read(what, ms, () => res.text())).slice(0, MAX_DETAIL);
      if (INVALID_STATUS.has(res.status)) throw new ProviderError(P, 'INVALID_INPUT', `vision service rejected ${what} (HTTP ${res.status}): ${detail}`);
      throw new ProviderError(P, 'UPSTREAM', `${what} -> HTTP ${res.status}: ${detail}`);
    }
    return { res, ms };
  }

  async #json<T>(path: string, schema: z.ZodType<T>, init?: RequestInit): Promise<T> {
    const { res, ms } = await this.#request(path, init);
    const body = await this.#read(path, ms, () => res.json());
    const parsed = schema.safeParse(body);
    if (!parsed.success) throw new ProviderError(P, 'UPSTREAM', `unexpected ${path} response: ${z.prettifyError(parsed.error)}`);
    this.warm = true;
    return parsed.data;
  }

  #form(image: Uint8Array, fields: Record<string, string>) {
    const form = new FormData();
    form.append('image', new Blob([new Uint8Array(image)]), 'image');
    for (const [k, v] of Object.entries(fields)) form.append(k, v);
    return { method: 'POST', body: form } as const;
  }

  health() {
    return this.#json('/health', Health);
  }

  async depth(image: Uint8Array): Promise<{ bytes: Uint8Array; width: number; height: number }> {
    const { res, ms } = await this.#request('/depth', this.#form(image, {}));
    const dims = z.object({ w: Dim, h: Dim, near: z.literal('high') }).safeParse({ w: res.headers.get('x-width'), h: res.headers.get('x-height'), near: res.headers.get('x-depth-near') });
    if (!dims.success) throw new ProviderError(P, 'UPSTREAM', `unexpected /depth headers: ${z.prettifyError(dims.error)}`);
    const bytes = new Uint8Array(await this.#read('/depth', ms, () => res.arrayBuffer()));
    this.warm = true;
    return { bytes, width: dims.data.w, height: dims.data.h };
  }

  async ocr(image: Uint8Array, langs: string[]) {
    return (await this.#json('/ocr', Ocr, this.#form(image, { langs: langs.join(',') }))).items;
  }

  async luma(image: Uint8Array, grid: number) {
    return (await this.#json('/luma', Luma, this.#form(image, { grid: String(grid) }))).grid;
  }

  unload() {
    return this.#json('/unload', Unloaded, { method: 'POST' });
  }
}
