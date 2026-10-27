import './load-env';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { and, eq } from 'drizzle-orm';
import { PIPELINE } from '@adforge/core/config/pipeline';
import { REPO_ROOT, parseEnv } from '@adforge/core/config/env';
import type { OcrItem } from '@adforge/core/providers/types';
import { analyzePlate, descriptorProblems } from '@adforge/core/understand/analyze';
import { libraryAssets, products } from '@adforge/db/schema';
import { EVENTS, inngest, recordCall, saveAsset, visionConfig } from '@adforge/pipeline';
import { buildDeps } from './deps';

/**
 * C1 end to end: one eval photo -> product + upload -> adforge/product.ingest through the running Inngest dev server
 * (needs worker, Inngest dev, ComfyUI and vision up) -> prints the library row; then one freshly generated plate goes through
 * luma + depth + analyzePlate directly (the same building blocks generateAds uses; cheaper than a full job).
 */
const env = parseEnv(process.env);
const { deps, storage, operator, close } = await buildDeps(env);
const { db } = deps;
const t0 = Date.now();
const mins = () => `${((Date.now() - t0) / 60_000).toFixed(1)}m`;
const checks: [string, boolean, string][] = [];
const check = (name: string, ok: boolean, note = '') => { checks.push([name, ok, note]); console.log(`  ${ok ? 'PASS' : 'FAIL'} ${name}${note ? ` — ${note}` : ''}`); };

try {
  // 1. product + one upload
  const photo = readFileSync(join(REPO_ROOT, 'fixtures', 'eval-products', 'krishna-hing-ras', '1-tins.jpg'));
  const ref = await storage.put(photo, { mime: 'image/jpeg' });
  const assetId = await saveAsset(db, operator, 'upload', ref);
  const name = `Krishna Hing e2e ${new Date().toISOString().slice(0, 16).replace(/\D/g, '')}`;
  const [product] = await db.insert(products).values({ orgId: operator.orgId, projectId: operator.projectId, name }).returning();
  console.log(`product ${product!.id} "${name}", upload asset ${assetId}`);

  // 2. ingest through Inngest dev
  await inngest.send({ name: EVENTS.productIngest, data: { productId: product!.id, photoAssetIds: [assetId] } });
  console.log('adforge/product.ingest sent — Inngest UI: http://127.0.0.1:8288');
  const deadline = Date.now() + 25 * 60_000;
  let rows: (typeof libraryAssets.$inferSelect)[] = [];
  while (!rows.length && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 5000));
    rows = await db.select().from(libraryAssets).where(and(eq(libraryAssets.orgId, operator.orgId), eq(libraryAssets.productId, product!.id)));
  }
  console.log(`[${mins()}] ingest ${rows.length ? 'wrote' : 'TIMED OUT, no'} library rows`);
  const row = rows[0];
  if (!row) throw new Error('no library rows — check the Inngest UI');
  const m = row.meta as Record<string, unknown> & { anchor?: boolean; cutoutKey?: string; ocr?: OcrItem[]; viewpoint?: unknown; palette?: string[] };
  const ocrText = (m.ocr ?? []).map((o) => o.text).join(' | ');
  console.log(`\ntags: ${rows.map((r) => `${r.tag} v${r.version}`).join(', ')}\nanchor: ${m.anchor}\ncutoutKey: ${m.cutoutKey}\nOCR: ${ocrText}\nviewpoint: ${JSON.stringify(m.viewpoint)}\npalette: ${JSON.stringify(m.palette)}\ndescriptor (${row.descriptor.split(/\s+/).length} words): ${row.descriptor}`);
  check('anchor tag', m.anchor === true && !!row.tag, row.tag);
  check('cutout key', typeof m.cutoutKey === 'string' && m.cutoutKey.length > 0);
  check('OCR text has brand words', /krishna|hing|asafoetida|asafetida/i.test(ocrText), `read: ${ocrText.slice(0, 200)}`);
  check('viewpoint', !!m.viewpoint);
  check('palette', Array.isArray(m.palette) && m.palette.length > 0);
  check('descriptor has no label text', row.descriptor.length > 0 && descriptorProblems(row.descriptor) === '', descriptorProblems(row.descriptor));

  // 3. one plate -> luma + depth -> PlateAnalysis
  const cfg = visionConfig(env);
  const pk = `e2e-library:plate:${product!.id}`;
  const img = await deps.comfy.image.generate({ prompt: 'a wooden kitchen counter by a window, warm morning light, empty surface, photorealistic', width: PIPELINE.plate.width, height: PIPELINE.plate.height, idempotencyKey: pk });
  await deps.comfy.free().catch(() => {});
  if (img.status !== 'done') throw new Error(`plate generation ${img.status}`);
  const plate = img.value;
  await saveAsset(db, operator, 'plate', plate);
  console.log(`\n[${mins()}] plate ${plate.id}`);
  const luma = await deps.vision.luma.grid(plate);
  const depth = await deps.vision.depth.estimate(plate, `${pk}:depth`);
  await deps.vision.unload().catch(() => {});
  if (luma.status !== 'done' || depth.status !== 'done') throw new Error(`vision luma ${luma.status} depth ${depth.status}`);
  const flat = luma.value.flat();
  const lumaSummary = { n: `${luma.value.length}x${luma.value[0]?.length}`, min: Math.min(...flat), max: Math.max(...flat), mean: +(flat.reduce((a, b) => a + b, 0) / flat.length).toFixed(1) };
  const pa = await analyzePlate({ image: plate }, { llm: deps.llm, model: cfg.model, effort: cfg.effort, idempotencyKey: pk, storage });
  await recordCall(db, { orgId: operator.orgId, kind: 'llm', provider: deps.llm.id, model: cfg.model, idempotencyKey: pk, result: pa, costUsd: pa.status === 'done' ? pa.cost.amountUsd : 0 });
  console.log(`PlateAnalysis: ${pa.status === 'done' ? JSON.stringify(pa.value.value) : JSON.stringify(pa)}\nluma: ${JSON.stringify(lumaSummary)}\ndepthKey: ${depth.value.id}`);
  check('plate analysis', pa.status === 'done');
  check('luma', Number.isFinite(lumaSummary.mean), JSON.stringify(lumaSummary));
  check('depth key', /^[\w:./-]+$/.test(depth.value.id), depth.value.id);
} catch (e) {
  check('run completed', false, e instanceof Error ? e.message : String(e));
} finally {
  await close();
}
console.log(`\n${checks.every((c) => c[1]) ? 'PASS' : 'FAIL'} in ${mins()}`);
process.exit(checks.length && checks.every((c) => c[1]) ? 0 : 1);
