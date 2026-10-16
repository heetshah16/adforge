import { createHash } from 'node:crypto';
import { z } from 'zod';
import { ProviderError } from '@adforge/core/providers/types';
import type { ApiWorkflow } from './patch';

const P = 'comfyui';

export const FileRef = z.object({ filename: z.string().min(1), subfolder: z.string(), type: z.string() });
export type FileRef = z.infer<typeof FileRef>;

const HistoryEntry = z.object({
  prompt: z.array(z.unknown()),
  outputs: z.record(z.string(), z.record(z.string(), z.unknown())),
  status: z
    .object({
      status_str: z.enum(['success', 'error']),
      completed: z.boolean(),
      messages: z.array(z.tuple([z.string(), z.record(z.string(), z.unknown())])),
    })
    .nullable(),
});
export type HistoryEntry = z.infer<typeof HistoryEntry>;

const PromptRejected = z.object({
  error: z.object({ type: z.string(), message: z.string() }),
  node_errors: z.record(
    z.string(),
    z.object({
      class_type: z.string().optional(),
      errors: z.array(z.object({ message: z.string(), details: z.string().optional() })),
    }),
  ),
});
type PromptRejected = z.infer<typeof PromptRejected>;

const Uploaded = z.object({ name: z.string().min(1) });
const Queue = z.object({ queue_running: z.array(z.array(z.unknown())), queue_pending: z.array(z.array(z.unknown())) });

export type Fetch = typeof fetch;

/** Thin HTTP client. Every response it reads is schema-checked; transport and shape failures are UPSTREAM. */
export class ComfyClient {
  private readonly baseUrl: string;

  constructor(
    baseUrl: string,
    private readonly fetchImpl: Fetch = fetch,
    private readonly timeoutMs = 30_000,
  ) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
  }

  async #request(path: string, init?: RequestInit): Promise<Response> {
    try {
      const timeout = AbortSignal.timeout(this.timeoutMs);
      const signal = init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
      return await this.fetchImpl(`${this.baseUrl}${path}`, { ...init, signal });
    } catch (e) {
      const why = (e as Error).name === 'TimeoutError' ? `timed out after ${this.timeoutMs}ms` : (e as Error).message;
      throw new ProviderError(P, 'UPSTREAM', `ComfyUI unreachable at ${this.baseUrl}: ${why}`, e);
    }
  }

  /** The timeout stays armed while the body streams, so it can surface from a body read; don't mislabel it. */
  #bodyError(e: unknown, what: string, fallback: string): ProviderError {
    const msg =
      (e as Error).name === 'TimeoutError'
        ? `ComfyUI at ${this.baseUrl} timed out after ${this.timeoutMs}ms reading ${what}`
        : fallback;
    return new ProviderError(P, 'UPSTREAM', msg, e);
  }

  async #json<T>(path: string, schema: z.ZodType<T>, init?: RequestInit): Promise<T> {
    const res = await this.#request(path, init);
    if (!res.ok) throw new ProviderError(P, 'UPSTREAM', `${init?.method ?? 'GET'} ${path} -> HTTP ${res.status}`);
    let body: unknown;
    try {
      body = await res.json();
    } catch (e) {
      throw this.#bodyError(e, path, `Non-JSON ${path} response`);
    }
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      throw new ProviderError(P, 'UPSTREAM', `Unexpected ${path} response: ${z.prettifyError(parsed.error)}`);
    }
    return parsed.data;
  }

  systemStats(): Promise<unknown> {
    return this.#json('/system_stats', z.unknown());
  }

  /** Returns the stored filename, which may differ from `filename` on a name clash. */
  async uploadImage(bytes: Uint8Array, filename: string): Promise<string> {
    const form = new FormData();
    form.append('image', new Blob([new Uint8Array(bytes)]), filename);
    form.append('overwrite', 'true');
    return (await this.#json('/upload/image', Uploaded, { method: 'POST', body: form })).name;
  }

  async queuePrompt(workflow: ApiWorkflow, promptId: string): Promise<void> {
    const res = await this.#request('/prompt', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: workflow, prompt_id: promptId }),
    });
    if (res.ok) return;
    const body: unknown = await res.json().catch(() => null);
    const rejected = PromptRejected.safeParse(body);
    if (res.status === 400 && rejected.success) {
      throw new ProviderError(P, 'INVALID_INPUT', describeRejection(workflow, rejected.data), body);
    }
    throw new ProviderError(P, 'UPSTREAM', `POST /prompt -> HTTP ${res.status}`, body);
  }

  /** Removes a stale entry so a rerun under the same prompt id is the one `history` reports. Empty 200 body. */
  async deleteHistory(promptId: string): Promise<void> {
    const res = await this.#request('/history', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ delete: [promptId] }),
    });
    if (!res.ok) throw new ProviderError(P, 'UPSTREAM', `POST /history -> HTTP ${res.status}`);
  }

  async history(promptId: string): Promise<HistoryEntry | null> {
    const all = await this.#json(`/history/${promptId}`, z.record(z.string(), HistoryEntry));
    return all[promptId] ?? null;
  }

  /** `pending` = waiting behind other jobs; `running` = executing now (ComfyUI runs one at a time). */
  async queueState(promptId: string): Promise<'running' | 'pending' | 'absent'> {
    const q = await this.#json('/queue', Queue);
    const has = (items: unknown[][]) => items.some((item) => item[1] === promptId);
    return has(q.queue_running) ? 'running' : has(q.queue_pending) ? 'pending' : 'absent';
  }

  async isQueued(promptId: string): Promise<boolean> {
    return (await this.queueState(promptId)) !== 'absent';
  }

  async view(file: FileRef): Promise<Uint8Array> {
    const q = new URLSearchParams({ filename: file.filename, subfolder: file.subfolder, type: file.type });
    const res = await this.#request(`/view?${q}`);
    if (!res.ok) throw new ProviderError(P, 'UPSTREAM', `GET /view ${file.filename} -> HTTP ${res.status}`);
    try {
      return new Uint8Array(await res.arrayBuffer());
    } catch (e) {
      throw this.#bodyError(e, `/view ${file.filename}`, `GET /view ${file.filename}: body read failed`);
    }
  }
}

/** Names each rejected node by its title, e.g. "unet (UNETLoader): Value not in list - unet_name: 'x' not in []". */
export function describeRejection(workflow: ApiWorkflow, r: PromptRejected): string {
  const nodes = Object.entries(r.node_errors).map(([id, e]) => {
    const title = workflow[id]?._meta?.title ?? id;
    const cls = e.class_type ?? workflow[id]?.class_type ?? 'unknown';
    const msgs = e.errors.map((x) => [x.message, x.details].filter(Boolean).join(' - ')).join('; ');
    return `${title} (${cls}): ${msgs}`;
  });
  return `ComfyUI rejected the workflow (${r.error.type}): ${nodes.join(' | ') || r.error.message}`;
}

/** Deterministic canonical UUID per idempotency key, so a retry finds its own job instead of queueing another. */
export function promptIdFor(idempotencyKey: string): string {
  const h = createHash('sha256').update(`adforge:${idempotencyKey}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}
