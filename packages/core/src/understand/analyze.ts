import { PIPELINE } from '../config/pipeline';
import { loadPrompt } from '../llm/prompts';
import type { LlmDeps } from '../llm/strategize';
import { ProviderError, type LLMContent, type LLMResult, type MediaRef, type OcrItem, type ProviderResult, type StorageProvider } from '../providers/types';
import { PlateAnalysis, ProductAnalysis, unreadQuotes } from './schemas';

type Mime = 'image/png' | 'image/jpeg' | 'image/webp';
export type VisionDeps = LlmDeps & { storage: Pick<StorageProvider, 'read'> };
type ProductResult = ProviderResult<LLMResult<ProductAnalysis>>;

async function imageContent(storage: VisionDeps['storage'], ref: MediaRef): Promise<LLMContent> {
  return { type: 'image', mime: ref.mime as Mime, data: await storage.read(ref.id) };
}

/** OCR is ground truth and varies per product, so it rides in the user message, never the frozen system prompt. */
export function renderOcr(ocr: OcrItem[][]): string {
  const blocks = ocr.map((items, i) => `Photo ${i} OCR text: ${items.length ? items.map((o) => o.text).join(' ') : '(none read)'}`);
  return `OCR text read from each photo (ground truth for printed words):\n${blocks.join('\n')}`;
}

/**
 * The model sees the plain schema; the OCR-quote guard runs here so a violation gets one repair
 * pass naming the offending strings (as direct() does), then fails. `calls` is every attempt.
 */
export async function analyzeProduct(
  input: { images: MediaRef[]; ocr: OcrItem[][] },
  deps: VisionDeps,
): Promise<{ result: ProductResult; repairs: number; calls: ProductResult[] }> {
  const cfg = deps.cfg ?? PIPELINE;
  const system = loadPrompt('vision-product').text;
  const base: LLMContent[] = [...(await Promise.all(input.images.map((r) => imageContent(deps.storage, r)))), { type: 'text', text: renderOcr(input.ocr) }];
  let user = base;
  const calls: ProductResult[] = [];
  for (let attempt = 0; ; attempt++) {
    const r = await deps.llm.generate({
      system, user, schema: ProductAnalysis, model: deps.model, effort: deps.effort,
      idempotencyKey: attempt === 0 ? deps.idempotencyKey : `${deps.idempotencyKey}:repair${attempt}`,
      timeoutMs: cfg.llm.timeoutMs,
    });
    calls.push(r);
    if (r.status !== 'done') return { result: r, repairs: attempt, calls };
    const bad = unreadQuotes(r.value.value.descriptor, input.ocr).map((b) => JSON.stringify(b)).join(', ');
    if (!bad) return { result: r, repairs: attempt, calls };
    if (attempt >= 1) {
      const error = new ProviderError('llm', 'UPSTREAM', `descriptor still quotes text OCR did not return: ${bad}`);
      return { result: { status: 'failed', error, retryable: false }, repairs: attempt, calls };
    }
    user = [...base, { type: 'text', text: `Your descriptor quoted text the OCR did not return: ${bad}. Return the full analysis again with a descriptor that quotes only words from the OCR text and describes any other label area by position, colour and style. Previous output:\n${JSON.stringify(r.value.value)}` }];
  }
}

export async function analyzePlate(input: { image: MediaRef }, deps: VisionDeps): Promise<ProviderResult<LLMResult<PlateAnalysis>>> {
  const cfg = deps.cfg ?? PIPELINE;
  return deps.llm.generate({
    system: loadPrompt('vision-plate').text,
    user: [await imageContent(deps.storage, input.image)],
    schema: PlateAnalysis, model: deps.model, effort: deps.effort,
    idempotencyKey: deps.idempotencyKey, timeoutMs: cfg.llm.timeoutMs,
  });
}
