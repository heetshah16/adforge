import { z } from 'zod';
import {
  ProviderError,
  isRetryable,
  type DepthProvider,
  type LumaProvider,
  type MediaRef,
  type OcrProvider,
  type ProviderResult,
  type StorageProvider,
} from '@adforge/core/providers/types';
import { VisionClient } from './client';

const P = 'vision-service';
const Ref = z.object({ id: z.string().min(1) }).passthrough();
const DepthReq = z.object({ image: Ref, key: z.string().min(1) });
const OcrReq = z.object({ image: Ref, langs: z.array(z.enum(['en', 'hi'])).min(1) });
const LumaReq = z.object({ image: Ref, n: z.number().int().min(2).max(32) });

/** Every failure becomes a ProviderResult. Non-provider errors (storage read/put) are UPSTREAM and retryable. */
const asFailed = (e: unknown): ProviderResult<never> => {
  const error = e instanceof ProviderError ? e : new ProviderError(P, 'UPSTREAM', `vision adapter failed: ${(e as Error | undefined)?.message ?? String(e)}`, e);
  return { status: 'failed', error, retryable: isRetryable(error.code) };
};
const LOCAL = { amountUsd: 0, estimated: false };

export function createVisionProviders(o: { baseUrl: string; storage: StorageProvider; fetchImpl?: typeof fetch; timeoutMs?: number }) {
  const client = new VisionClient(o.baseUrl, o.fetchImpl, o.timeoutMs);

  /** Validate, read the image bytes through storage, run `fn`, wrap the outcome. */
  async function run<T>(parsed: { success: true; data: { image: { id: string } } } | { success: false; error: z.ZodError }, fn: (bytes: Uint8Array) => Promise<T>): Promise<ProviderResult<T>> {
    if (!parsed.success) return { status: 'failed', error: new ProviderError(P, 'INVALID_INPUT', z.prettifyError(parsed.error)), retryable: false };
    const started = Date.now();
    try {
      const value = await fn(await o.storage.read(parsed.data.image.id));
      return { status: 'done', value, cost: LOCAL, latencyMs: Date.now() - started };
    } catch (e) {
      return asFailed(e);
    }
  }

  const depth: DepthProvider = {
    id: 'depth-anything-v2-small',
    estimate: (image: MediaRef, key: string) =>
      run(DepthReq.safeParse({ image, key }), async (bytes) => {
        const d = await client.depth(bytes);
        return o.storage.put(d.bytes, { mime: 'image/png', width: d.width, height: d.height });
      }),
  };
  const ocr: OcrProvider = {
    id: 'easyocr',
    read: (image, langs = ['en', 'hi']) => run(OcrReq.safeParse({ image, langs }), (bytes) => client.ocr(bytes, langs)),
  };
  const luma: LumaProvider = {
    id: 'luma-grid',
    grid: (image, n = 8) => run(LumaReq.safeParse({ image, n }), (bytes) => client.luma(bytes, n)),
  };

  return { depth, ocr, luma, health: () => client.health(), unload: () => client.unload() };
}
