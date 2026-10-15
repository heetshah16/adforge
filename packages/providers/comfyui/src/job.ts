import {
  ProviderError,
  isRetryable,
  type MediaRef,
  type ProviderErrorCode,
  type ProviderResult,
  type StorageProvider,
} from '@adforge/core/providers/types';
import { FileRef, promptIdFor, type ComfyClient, type HistoryEntry } from './client';
import { nodeIdByTitle, type ApiWorkflow } from './patch';

const P = 'comfyui';

export interface OutputSpec {
  title: 'out:image' | 'out:video';
  mime: 'image/png' | 'video/mp4';
  width?: number;
  height?: number;
  durationSec?: (entry: HistoryEntry) => number | undefined;
}

export function toFailed(e: unknown): ProviderResult<never> {
  if (e instanceof ProviderError) return { status: 'failed', error: e, retryable: isRetryable(e.code) };
  throw e;
}

function failed(code: ProviderErrorCode, message: string, raw?: unknown): ProviderResult<never> {
  return toFailed(new ProviderError(P, code, message, raw));
}

/** Reuse a finished-OK or in-flight job for this key; requeue (same id) only when there is none or the last run failed. */
export async function submitOnce(client: ComfyClient, workflow: ApiWorkflow, idempotencyKey: string): Promise<string> {
  const promptId = promptIdFor(idempotencyKey);
  let entry = await client.history(promptId);
  if (!entry) {
    if (await client.isQueued(promptId)) return promptId;
    entry = await client.history(promptId); // finished between the two calls
    if (!entry) {
      await client.queuePrompt(workflow, promptId);
      return promptId;
    }
  }
  if (entry.status?.status_str === 'success') return promptId;
  // The key's previous run failed: clear it so the rerun's result is the one collect() reads.
  await client.deleteHistory(promptId);
  await client.queuePrompt(workflow, promptId);
  return promptId;
}

/** One poll: pending while queued, done once the output is in AdForge storage, failed otherwise. Never throws ProviderError. */
export async function collect(
  client: ComfyClient,
  storage: StorageProvider,
  workflow: ApiWorkflow,
  promptId: string,
  output: OutputSpec,
): Promise<ProviderResult<MediaRef>> {
  try {
    let entry = await client.history(promptId);
    if (!entry) {
      if (await client.isQueued(promptId)) {
        return { status: 'pending', handle: { provider: P, externalId: promptId, pollAfterMs: 2000 } };
      }
      // It may have finished between the two calls; only a second miss means it is truly lost.
      entry = await client.history(promptId);
      if (!entry) {
        return failed(
          'UPSTREAM',
          `ComfyUI job ${promptId} is neither queued nor in history (server restarted?); resubmit with the same idempotency key`,
        );
      }
    }

    const messages = entry.status?.messages ?? [];
    const error = messages.find(([type]) => type === 'execution_error')?.[1];
    if (error) {
      return failed(
        'UPSTREAM',
        `ComfyUI ${String(error.node_type ?? 'node')} ${String(error.node_id ?? '')} failed: ${String(error.exception_message ?? 'unknown error')}`,
        error,
      );
    }
    if (messages.some(([type]) => type === 'execution_interrupted')) {
      return { status: 'failed', error: new ProviderError(P, 'UPSTREAM', `ComfyUI job ${promptId} was interrupted`), retryable: false };
    }
    if (entry.status?.status_str !== 'success') {
      return failed('UPSTREAM', `ComfyUI job ${promptId} ended with status ${entry.status?.status_str ?? 'unknown'}`);
    }

    const file = firstFile(entry, nodeIdByTitle(workflow, output.title));
    if (!file) return failed('UPSTREAM', `ComfyUI job ${promptId} produced no file on ${output.title}`);
    const bytes = await client.view(file);
    const dims = output.mime === 'image/png' ? pngSize(bytes) : { width: output.width, height: output.height };
    const ref = await storage.put(bytes, { mime: output.mime, ...dims, durationSec: output.durationSec?.(entry) });
    return { status: 'done', value: ref, cost: { amountUsd: 0, estimated: false }, latencyMs: executionMs(messages) };
  } catch (e) {
    return toFailed(e);
  }
}

export async function waitFor(
  poll: () => Promise<ProviderResult<MediaRef>>,
  opts: { timeoutMs: number; intervalMs: number; sleep?: (ms: number) => Promise<void> },
): Promise<ProviderResult<MediaRef>> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const deadline = Date.now() + opts.timeoutMs;
  for (;;) {
    const r = await poll();
    if (r.status !== 'pending') return r;
    if (Date.now() >= deadline) {
      return failed('TIMEOUT', `ComfyUI job ${r.handle.externalId} still running after ${opts.timeoutMs}ms`);
    }
    await sleep(opts.intervalMs);
  }
}

/** Reads width/height from the PNG IHDR chunk. */
export function pngSize(bytes: Uint8Array): { width: number; height: number } {
  const sig = [137, 80, 78, 71, 13, 10, 26, 10];
  if (bytes.length < 24 || sig.some((b, i) => bytes[i] !== b)) {
    throw new ProviderError(P, 'UPSTREAM', 'ComfyUI output is not a PNG');
  }
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: v.getUint32(16), height: v.getUint32(20) };
}

/** Video save nodes also report under `images` (with `animated: [true]`), so take the first file-shaped entry. */
function firstFile(entry: HistoryEntry, nodeId: string): FileRef | undefined {
  for (const value of Object.values(entry.outputs[nodeId] ?? {})) {
    if (!Array.isArray(value)) continue;
    for (const item of value) {
      const parsed = FileRef.safeParse(item);
      if (parsed.success) return parsed.data;
    }
  }
  return undefined;
}

/** GPU execution time from the history's own timestamps (excludes queue wait). */
function executionMs(messages: [string, Record<string, unknown>][]): number {
  const at = (type: string) => messages.find(([t]) => t === type)?.[1].timestamp;
  const start = at('execution_start');
  const end = at('execution_success');
  return typeof start === 'number' && typeof end === 'number' ? end - start : 0;
}
