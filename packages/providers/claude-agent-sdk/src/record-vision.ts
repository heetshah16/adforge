// Usage: tsx src/record-vision.ts <eval-product-dir>... [--plate <image>]
// Needs the vision service on ADFORGE_VISION_URL (OCR via the Task 3 vision provider) and the local Claude login. Saves analysis JSON only — never image bytes.
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, extname, join, resolve } from 'node:path';
import { REPO_ROOT, parseEnv } from '@adforge/core/config/env';
import type { MediaRef } from '@adforge/core/providers/types';
import { analyzePlate, analyzeProduct, type VisionDeps } from '@adforge/core/understand/analyze';
import { createVisionProviders } from '@adforge/provider-vision-service';
import { ClaudeAgentProvider } from './adapter';

const env = parseEnv(process.env);
const MIME = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' } as const;
const args = process.argv.slice(2);
const plateAt = args.indexOf('--plate');
const plate = plateAt >= 0 ? args.splice(plateAt, 2)[1] : undefined;
const out = (n: string, v: unknown) => writeFileSync(new URL(`../fixtures/${n}.live.json`, import.meta.url), JSON.stringify(v, null, 2) + '\n');

// MediaRef.id is the file path here; no storage service is involved.
const ref = (path: string): MediaRef => ({ id: path, url: `file:///${path}`, mime: MIME[extname(path).toLowerCase() as keyof typeof MIME], sha256: '0'.repeat(64), bytes: 0 });
const deps = (key: string): VisionDeps => ({
  llm: new ClaudeAgentProvider(), model: env.ADFORGE_LLM_VISION, effort: env.ADFORGE_LLM_EFFORT_VISION, idempotencyKey: key,
  storage: { read: async (p) => new Uint8Array(readFileSync(p)) },
});
const storage = {
  id: 'file', read: async (p: string) => new Uint8Array(readFileSync(p)),
  put: async () => { throw new Error('record-vision: storage.put is not supported'); }, urlFor: (k: string) => `file:///${k}`,
};
const vision = createVisionProviders({ baseUrl: env.ADFORGE_VISION_URL, storage });
const ocrOf = async (path: string) => {
  const r = await vision.ocr.read(ref(path));
  if (r.status !== 'done') throw new Error(`OCR failed for ${path}: ${r.status === 'failed' ? r.error.message : r.status}`);
  return r.value;
};

for (const dir of args.map((a) => resolve(REPO_ROOT, a))) {
  const slug = basename(dir);
  const files = readdirSync(dir).filter((f) => extname(f).toLowerCase() in MIME).sort().map((f) => join(dir, f));
  const ocr = [];
  for (const f of files) ocr.push(await ocrOf(f));
  const { result, repairs, calls } = await analyzeProduct({ images: files.map(ref), ocr }, deps(`record-vision:${slug}`));
  if (result.status !== 'done') throw new Error(`${slug}: ${result.status === 'failed' ? result.error.message : result.status}`);
  const usage = calls.map((c) => (c.status === 'done' ? c.value.usage : null));
  console.log(slug, 'repairs', repairs, JSON.stringify(usage));
  out(`vision-product.${slug}`, { photos: files.map((f) => basename(f)), ocrText: ocr.map((o) => o.map((i) => i.text)), repairs, usage, analysis: result.value.value });
}
if (plate) {
  const r = await analyzePlate({ image: ref(resolve(plate)) }, deps('record-vision:plate'));
  if (r.status !== 'done') throw new Error(`plate: ${r.status === 'failed' ? r.error.message : r.status}`);
  console.log('plate', JSON.stringify(r.value.usage));
  out('vision-plate', { usage: r.value.usage, analysis: r.value.value });
}
