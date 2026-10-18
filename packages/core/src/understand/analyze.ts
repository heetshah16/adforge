import { PIPELINE } from '../config/pipeline';
import { loadPrompt } from '../llm/prompts';
import type { LlmDeps } from '../llm/strategize';
import { ProviderError, type LLMContent, type LLMResult, type MediaRef, type OcrItem, type ProviderResult, type StorageProvider } from '../providers/types';
import { PlateAnalysis, ProductAnalysis, ProductAnalysisModel, labelTextViolations, wordCount } from './schemas';

const MIMES = ['image/png', 'image/jpeg', 'image/webp'] as const;
type Mime = (typeof MIMES)[number];
export type VisionDeps = LlmDeps & { storage: Pick<StorageProvider, 'read'> };
type ProductResult = ProviderResult<LLMResult<ProductAnalysis>>;

const invalid = (message: string): ProviderResult<never> => ({ status: 'failed', error: new ProviderError('llm', 'INVALID_INPUT', message), retryable: false });
const badMime = (refs: MediaRef[]) => refs.find((r) => !MIMES.includes(r.mime as Mime));

async function imageContent(storage: VisionDeps['storage'], ref: MediaRef): Promise<LLMContent> {
  return { type: 'image', mime: ref.mime as Mime, data: await storage.read(ref.id) };
}

/** OCR is context for understanding only; it varies per product, so it rides in the user message, never the frozen system prompt. */
export function renderOcr(ocr: OcrItem[][]): string {
  const blocks = ocr.map((items, i) => `Photo ${i} OCR text: ${items.length ? items.map((o) => o.text).join(' ') : '(none read)'}`);
  return `OCR text read from each photo, for your understanding only (it may contain misreads; never copy it into the descriptor):\n${blocks.join('\n')}`;
}

/** Everything wrong with a descriptor, as one repair-ready sentence; '' when it is fine. */
function descriptorProblems(d: string): string {
  const n = wordCount(d);
  const leaked = labelTextViolations(d).map((t) => JSON.stringify(t));
  return [
    ...(n < 40 || n > 120 ? [`descriptor is ${n} words, limit 40-120`] : []),
    ...(leaked.length ? [`it contains label text: ${leaked.join(', ')}`] : []),
  ].join('; ');
}

/**
 * The model sees a loose schema; descriptor length and the label-text guard run here, so any violation gets ONE repair pass
 * naming the offending tokens (as direct() does), then fails non-retryable. `calls` is every attempt.
 */
export async function analyzeProduct(
  input: { images: MediaRef[]; ocr: OcrItem[][] },
  deps: VisionDeps,
): Promise<{ result: ProductResult; repairs: number; calls: ProductResult[] }> {
  const bad = badMime(input.images);
  if (bad) return { result: invalid(`unsupported image mime ${bad.mime} (${bad.id})`), repairs: 0, calls: [] };
  const cfg = deps.cfg ?? PIPELINE;
  const system = loadPrompt('vision-product').text;
  const base: LLMContent[] = [...(await Promise.all(input.images.map((r) => imageContent(deps.storage, r)))), { type: 'text', text: renderOcr(input.ocr) }];
  let user = base;
  const calls: ProductResult[] = [];
  for (let attempt = 0; ; attempt++) {
    const r = await deps.llm.generate({
      system, user, schema: ProductAnalysisModel, model: deps.model, effort: deps.effort,
      idempotencyKey: attempt === 0 ? deps.idempotencyKey : `${deps.idempotencyKey}:repair${attempt}`,
      timeoutMs: cfg.llm.timeoutMs,
    });
    calls.push(r);
    if (r.status !== 'done') return { result: r, repairs: attempt, calls };
    const problems = descriptorProblems(r.value.value.descriptor);
    if (!problems) return { result: { ...r, value: { ...r.value, value: ProductAnalysis.parse(r.value.value) } }, repairs: attempt, calls };
    if (attempt >= 1) {
      const error = new ProviderError('llm', 'UPSTREAM', `descriptor still invalid: ${problems}`);
      return { result: { status: 'failed', error, retryable: false }, repairs: attempt, calls };
    }
    user = [...base, { type: 'text', text: `Your descriptor was rejected: ${problems}. Return the full analysis again with a descriptor of about 70 to 90 words (never under 40 or over 120) that contains no label text at all (no quoted words, no ALL-CAPS words, no numbers), describing the label by layout, colour and script style. Previous output:\n${JSON.stringify(r.value.value)}` }];
  }
}

export async function analyzePlate(input: { image: MediaRef }, deps: VisionDeps): Promise<ProviderResult<LLMResult<PlateAnalysis>>> {
  if (badMime([input.image])) return invalid(`unsupported image mime ${input.image.mime} (${input.image.id})`);
  const cfg = deps.cfg ?? PIPELINE;
  return deps.llm.generate({
    system: loadPrompt('vision-plate').text,
    user: [await imageContent(deps.storage, input.image)],
    schema: PlateAnalysis, model: deps.model, effort: deps.effort,
    idempotencyKey: deps.idempotencyKey, timeoutMs: cfg.llm.timeoutMs,
  });
}
