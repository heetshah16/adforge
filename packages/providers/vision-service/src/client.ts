import { z } from 'zod';
import { ProviderError } from '@adforge/core/providers/types';
import { fetchWithDeadline, readClassified } from '@adforge/core/providers/http';

const P = 'vision-service';
const LABEL = 'vision service';
export const CALL_TIMEOUT_MS = 120_000;
/** Until a model's first success the service may still be downloading/loading its weights. */
export const LOAD_TIMEOUT_MS = 900_000;

const Health = z.object({ ok: z.boolean(), device: z.string(), cuda: z.boolean(), loaded: z.object({ depth: z.boolean(), ocr: z.boolean() }), allocated_mb: z.number() });
const Ocr = z.object({ items: z.array(z.object({ text: z.string(), box: z.tuple([z.number(), z.number(), z.number(), z.number()]), conf: z.number() })) });
const Luma = z.object({ grid: z.array(z.array(z.number())) });
const Unloaded = z.object({ unloaded: z.array(z.string()) });
const Dim = z.coerce.number().int().positive();

type Model = 'depth' | 'ocr';

export class VisionClient {
  private readonly baseUrl: string;
  /** Models that have answered once (their weights are loaded); cleared by unload(). /luma, /health and /unload load no model. */
  private readonly warm = new Set<Model>();
  /** timeoutMs overrides both budgets (tests); otherwise 900 s until that model's first success, 120 s after. */
  constructor(baseUrl: string, private readonly fetchImpl: typeof fetch = fetch, private readonly timeoutMs?: number) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
  }

  #budget = (model?: Model) => this.timeoutMs ?? (model && !this.warm.has(model) ? LOAD_TIMEOUT_MS : CALL_TIMEOUT_MS);

  async #request(path: string, init?: RequestInit, model?: Model): Promise<{ res: Response; ms: number }> {
    const ms = this.#budget(model);
    const res = await fetchWithDeadline({ provider: P, label: LABEL, fetchImpl: this.fetchImpl, url: `${this.baseUrl}${path}`, init, timeoutMs: ms });
    return { res, ms };
  }

  async #json<T>(path: string, schema: z.ZodType<T>, init?: RequestInit, model?: Model): Promise<T> {
    const { res, ms } = await this.#request(path, init, model);
    const body = await readClassified(P, LABEL, path, ms, () => res.json());
    const parsed = schema.safeParse(body);
    if (!parsed.success) throw new ProviderError(P, 'UPSTREAM', `unexpected ${path} response: ${z.prettifyError(parsed.error)}`);
    if (model) this.warm.add(model);
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
    const { res, ms } = await this.#request('/depth', this.#form(image, {}), 'depth');
    const dims = z.object({ w: Dim, h: Dim, near: z.literal('high') }).safeParse({ w: res.headers.get('x-width'), h: res.headers.get('x-height'), near: res.headers.get('x-depth-near') });
    if (!dims.success) throw new ProviderError(P, 'UPSTREAM', `unexpected /depth headers: ${z.prettifyError(dims.error)}`);
    const bytes = new Uint8Array(await readClassified(P, LABEL, '/depth', ms, () => res.arrayBuffer()));
    this.warm.add('depth');
    return { bytes, width: dims.data.w, height: dims.data.h };
  }

  async ocr(image: Uint8Array, langs: string[]) {
    return (await this.#json('/ocr', Ocr, this.#form(image, { langs: langs.join(',') }), 'ocr')).items;
  }

  async luma(image: Uint8Array, grid: number) {
    return (await this.#json('/luma', Luma, this.#form(image, { grid: String(grid) }))).grid;
  }

  async unload() {
    const r = await this.#json('/unload', Unloaded, { method: 'POST' });
    this.warm.clear();
    return r;
  }
}
