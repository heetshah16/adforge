import { createHash } from 'node:crypto';
import { and, desc, eq, inArray, like, ne, or, sql } from 'drizzle-orm';
import { NonRetriableError } from 'inngest';
import { z } from 'zod';
import { makeTag, nextVersion, parseTag } from '@adforge/core/library/tags';
import { ProviderError, type MediaRef, type OcrItem, type ProviderResult } from '@adforge/core/providers/types';
import { IMAGE_MIMES, analyzeProduct, descriptorProblems } from '@adforge/core/understand/analyze';
import type { ProductAnalysis } from '@adforge/core/understand/schemas';
import type { Db } from '@adforge/db/client';
import { assets, libraryAssets, products } from '@adforge/db/schema';
import { recordCall, saveAsset } from './record';
import { visionConfig } from './snapshot';
import type { PipelineDeps } from './types';
import { toWire, type WireResult } from './wire';

/** `adforge/product.ingest`: the photos are named in the event (the product's own upload assets, 1-5, in display order). */
export const IngestEvent = z.object({ productId: z.uuid(), photoAssetIds: z.array(z.uuid()).min(1).max(5) });
/** Inngest's step plus the run id (it scopes the paid LLM keys, so a later run's calls are recorded, not folded into an earlier run's rows). */
export interface IngestStep { runId: string; run<T>(id: string, fn: () => Promise<T>): Promise<T> }
type Tag = { tag: string; version: number; anchor: boolean };
export interface IngestResult { status: 'ingested' | 'skipped'; tags: Tag[]; analysis: ReturnType<typeof visionConfig> }

/** Retryable failures throw for Inngest to retry the step; the rest fail the run now. Either way no library row exists yet. */
function fail(what: string, key: string, w: WireResult<unknown>): never {
  const msg = w.ok ? `${what} failed [${key}]` : `${what} failed: ${w.code} ${w.message} [${key}]`;
  throw w.ok || w.retryable ? new Error(msg) : new NonRetriableError(msg);
}

/** One recorded provider call. A provider that throws instead of returning a result is still recorded, as a retryable failure. */
async function call<T>(deps: PipelineDeps, orgId: string, kind: string, provider: string, key: string, run: () => Promise<ProviderResult<T>>): Promise<T> {
  const r = await run().catch((e): ProviderResult<T> => ({ status: 'failed', error: new ProviderError(provider, 'UNKNOWN', e instanceof Error ? e.message : String(e)), retryable: true }));
  await recordCall(deps.db, {
    orgId, kind, provider, idempotencyKey: key, result: r,
    latencyMs: r.status === 'done' ? r.latencyMs : undefined, costUsd: r.status === 'done' ? r.cost.amountUsd : 0,
  });
  return r.status === 'done' ? r.value : fail(kind, key, toWire(r));
}

/** Active rows of this exact ingest (same org, product and photo set); a descriptor edit keeps the key, so it still counts. */
async function ingested(db: Db, orgId: string, productId: string, ingestKey: string): Promise<Tag[]> {
  const rows = await db.select({ tag: libraryAssets.tag, version: libraryAssets.version, meta: libraryAssets.meta }).from(libraryAssets).where(and(
    eq(libraryAssets.orgId, orgId), eq(libraryAssets.productId, productId), eq(libraryAssets.status, 'active'),
    sql`${libraryAssets.meta}->>'ingestKey' = ${ingestKey}`,
  ));
  return rows.map((r) => ({ tag: r.tag, version: r.version, anchor: (r.meta as { anchor?: boolean }).anchor === true }));
}

const idPrefix = (id: string) => id.replace(/-/g, '').slice(0, 8);
/**
 * A product keeps the slug of its first ingest (a rename never moves its tags). On that first ingest: makeTag keeps only
 * [a-z0-9], so a Devanagari-only name falls back to `p<id prefix>`; the first product to claim a slug in an org keeps it, and a
 * later product whose name sanitises to the same slug gets its id prefix appended.
 */
async function productSlug(db: Db, orgId: string, p: { id: string; name: string }): Promise<string> {
  const [own] = await db.select({ tag: libraryAssets.tag }).from(libraryAssets).where(and(
    eq(libraryAssets.orgId, orgId), eq(libraryAssets.kind, 'product_view'), eq(libraryAssets.productId, p.id),
  )).limit(1);
  if (own) return parseTag(own.tag).parts[0]!;
  const base = p.name.toLowerCase().replace(/[^a-z0-9]/g, '') || `p${idPrefix(p.id)}`;
  const [taken] = await db.select({ id: libraryAssets.id }).from(libraryAssets).where(and(
    eq(libraryAssets.orgId, orgId), eq(libraryAssets.kind, 'product_view'), ne(libraryAssets.productId, p.id),
    or(eq(libraryAssets.tag, makeTag('product_view', [base])), like(libraryAssets.tag, `@prod\\_${base}\\_%`)),
  )).limit(1);
  return taken ? `${base}${idPrefix(p.id)}` : base;
}

/** The camera's position as tag parts: the first visible face, plus the azimuth/elevation bucket when it says something new. */
export function viewParts(a: Pick<ProductAnalysis, 'viewpoint' | 'visibleFaces'>): string[] {
  const { azimuthDeg: az, elevationDeg: el } = a.viewpoint;
  const side = az < 0 ? 'left' : 'right';
  const abs = Math.abs(az);
  const bucket = el >= 60 ? 'top' : el <= -60 ? 'bottom' : abs <= 22.5 ? 'front' : abs <= 67.5 ? `three-quarter-${side}` : abs <= 135 ? side : 'back';
  const face = a.visibleFaces[0]!;
  return face === bucket ? [face] : [face, bucket];
}

/**
 * GPU phases run back to back and release their model even on failure (cutouts → comfy.free, OCR → vision.unload), then the
 * LLM, then ONE transaction writes every library row — so a failure anywhere leaves no partial library rows.
 */
export async function ingestProduct(data: unknown, step: IngestStep, deps: PipelineDeps): Promise<IngestResult> {
  const parsed = IngestEvent.safeParse(data);
  if (!parsed.success) throw new NonRetriableError(`bad product.ingest payload: ${z.prettifyError(parsed.error)}`);
  const ev = parsed.data;
  const { db } = deps;
  const cfg = visionConfig(deps.env);

  const ctx = await step.run('load', async () => {
    const [p] = await db.select().from(products).where(eq(products.id, ev.productId));
    if (!p) throw new NonRetriableError(`product ${ev.productId} not found`);
    const ids = [...new Set(ev.photoAssetIds)];
    const found = await db.select().from(assets).where(inArray(assets.id, ids));
    const byId = new Map(found.map((a) => [a.id, a]));
    const bad = ids.filter((id) => byId.get(id)?.orgId !== p.orgId || byId.get(id)?.kind !== 'upload');
    if (bad.length) throw new NonRetriableError(`asset(s) ${bad.join(', ')} not an upload of this product's org`);
    const odd = found.filter((a) => !(IMAGE_MIMES as readonly string[]).includes(a.mime));
    if (odd.length) throw new NonRetriableError(`asset(s) ${odd.map((a) => `${a.id} (${a.mime})`).join(', ')} not an analysable image (${IMAGE_MIMES.join(', ')})`);
    const photos = ids.map((id) => {
      const a = byId.get(id)!;
      const ref: MediaRef = { id: a.storageKey, url: deps.storage.urlFor(a.storageKey), mime: a.mime, sha256: a.sha256, bytes: a.bytes, width: a.width ?? undefined, height: a.height ?? undefined };
      return { assetId: a.id, ref };
    });
    // Every key is namespaced by org + product; the ingest key adds the (order-free) photo set.
    const ns = `ingest:${p.orgId}:${p.id}`;
    const ingestKey = `${ns}:${createHash('sha256').update(photos.map((x) => x.ref.sha256).sort().join(',')).digest('hex').slice(0, 32)}`;
    return { product: { id: p.id, name: p.name, orgId: p.orgId, projectId: p.projectId }, photos, ns, ingestKey, existing: await ingested(db, p.orgId, p.id, ingestKey) };
  });
  if (ctx.existing.length) return { status: 'skipped', tags: ctx.existing, analysis: cfg };
  const { orgId, projectId } = ctx.product;

  const cutouts = await step.run('cutouts', async () => {
    try {
      const keys: string[] = [];
      for (const ph of ctx.photos) {
        const key = `${ctx.ns}:cutout:${ph.ref.sha256}`;
        const ref = await call(deps, orgId, 'cutout', deps.comfy.cutout.id, key, () => deps.comfy.cutout.cutout({ image: ph.ref, idempotencyKey: key }));
        await saveAsset(db, { orgId, projectId }, 'cutout', ref);
        keys.push(ref.id);
      }
      return keys;
    } finally {
      await deps.comfy.free().catch(() => {});
    }
  });

  const ocr = await step.run('ocr', async () => {
    try {
      const out: OcrItem[][] = [];
      for (const ph of ctx.photos) out.push(await call(deps, orgId, 'ocr', deps.vision.ocr.id, `${ctx.ns}:ocr:${ph.ref.sha256}`, () => deps.vision.ocr.read(ph.ref)));
      return out;
    } finally {
      await deps.vision.unload().catch(() => {});
    }
  });

  // One step per analysis, so Inngest memoizes each paid call and the joint result (the anchor) is a stable input to the rest.
  // The joint call over every photo picks the anchor and carries the product-level fields (shape, material, finish, palette);
  // each other photo's own call contributes only its view: viewpoint, faces, light and descriptor.
  const analyze = async (idx: number[], key: string): Promise<ProductAnalysis> => {
    const a = await analyzeProduct(
      { images: idx.map((i) => ctx.photos[i]!.ref), ocr: idx.map((i) => ocr[i]!) },
      { llm: deps.llm, model: cfg.model, effort: cfg.effort, idempotencyKey: key, storage: deps.storage },
    ).catch((e): Awaited<ReturnType<typeof analyzeProduct>> => ({
      result: { status: 'failed', error: new ProviderError(deps.llm.id, 'UNKNOWN', e instanceof Error ? e.message : String(e)), retryable: true }, repairs: 0, calls: [],
    }));
    // One row per attempt; the last attempt carries the outcome (a valid call whose descriptor still fails the guard is a failure).
    const attempts = a.calls.length ? a.calls : [a.result];
    for (const [n, c] of attempts.entries()) {
      await recordCall(db, {
        orgId, kind: 'llm', provider: deps.llm.id, model: cfg.model, idempotencyKey: n ? `${key}:repair${n}` : key,
        result: n === attempts.length - 1 ? a.result : c,
        latencyMs: c.status === 'done' ? c.latencyMs : undefined, costUsd: c.status === 'done' ? c.cost.amountUsd : 0,
      });
    }
    return a.result.status === 'done' ? a.result.value.value : fail('analysis', key, toWire(a.result));
  };
  const llmKey = `${ctx.ingestKey}:${step.runId}:analysis`;
  const all = ctx.photos.map((_, i) => i);
  const joint = await step.run('analyze:joint', async () => {
    const j = await analyze(all, llmKey);
    if (j.bestPhotoIndex >= all.length) throw new NonRetriableError(`analysis picked photo ${j.bestPhotoIndex} of ${all.length}`);
    return j;
  });
  const best = joint.bestPhotoIndex;
  const views: ProductAnalysis[] = [];
  for (const i of all) {
    if (i === best) { views.push(joint); continue; }
    const sha = ctx.photos[i]!.ref.sha256;
    const v = await step.run(`analyze:${sha}`, () => analyze([i], `${llmKey}:${sha}`));
    views.push({ ...joint, viewpoint: v.viewpoint, visibleFaces: v.visibleFaces, lightDirection: v.lightDirection, descriptor: v.descriptor });
  }
  const analyzed = { best, views };

  const written = await step.run('write', () =>
    db.transaction(async (tx) => {
      const again = await ingested(tx, orgId, ctx.product.id, ctx.ingestKey);
      if (again.length) return { status: 'skipped' as const, tags: again };
      const slug = await productSlug(tx, orgId, ctx.product);
      const seen = new Map<string, number>();
      const tags = analyzed.views.map((v) => {
        const parts = [slug, ...viewParts(v)];
        const t = makeTag('product_view', parts);
        const n = (seen.get(t) ?? 0) + 1;
        seen.set(t, n);
        return n > 1 ? makeTag('product_view', [...parts, String(n)]) : t;
      });
      // An ingest defines the product's current view set: earlier views of this product (or holders of these tags) step aside.
      await tx.update(libraryAssets).set({ status: 'superseded' }).where(and(
        eq(libraryAssets.orgId, orgId), eq(libraryAssets.kind, 'product_view'), eq(libraryAssets.status, 'active'),
        or(eq(libraryAssets.productId, ctx.product.id), inArray(libraryAssets.tag, tags)),
      ));
      const out: Tag[] = [];
      for (const [i, tag] of tags.entries()) {
        const prev = await tx.select({ v: libraryAssets.version }).from(libraryAssets).where(and(eq(libraryAssets.orgId, orgId), eq(libraryAssets.tag, tag)));
        const version = nextVersion(prev.map((r) => r.v));
        const { descriptor, bestPhotoIndex: _best, ...view } = analyzed.views[i]!;
        const anchor = i === analyzed.best;
        await tx.insert(libraryAssets).values({
          orgId, projectId, productId: ctx.product.id, tag, version, kind: 'product_view', descriptor, storageKey: ctx.photos[i]!.ref.id,
          meta: {
            ...view, anchor, sourceAssetId: ctx.photos[i]!.assetId, cutoutKey: cutouts[i]!, ocr: ocr[i]!,
            analysisModel: cfg.model, analysisPrompt: cfg.prompts.visionProduct, ingestKey: ctx.ingestKey,
          },
        });
        out.push({ tag, version, anchor });
      }
      return { status: 'ingested' as const, tags: out };
    }),
  );
  return { ...written, analysis: cfg };
}

/** A descriptor edit is a new state of the ACTIVE row: version n+1 (active, same meta and pixels), the previous one superseded, one transaction. */
export async function updateDescriptor(db: Db, o: { orgId: string; tag: string; descriptor: string }): Promise<number> {
  const problems = descriptorProblems(o.descriptor);
  if (problems) throw new Error(`descriptor refused: ${problems}`);
  return db.transaction(async (tx) => {
    const one = and(eq(libraryAssets.orgId, o.orgId), eq(libraryAssets.tag, o.tag));
    // Only the current state is editable: a superseded view (its product was re-ingested) is never revived.
    const [cur] = await tx.select().from(libraryAssets).where(and(one, eq(libraryAssets.status, 'active'))).orderBy(desc(libraryAssets.version)).limit(1);
    if (!cur) throw new Error(`library tag ${o.tag} has no active version in org ${o.orgId}`);
    const [top] = await tx.select({ v: libraryAssets.version }).from(libraryAssets).where(one).orderBy(desc(libraryAssets.version)).limit(1);
    const version = top!.v + 1;
    const { id: _id, createdAt: _at, ...copy } = cur;
    await tx.update(libraryAssets).set({ status: 'superseded' }).where(and(one, eq(libraryAssets.status, 'active')));
    await tx.insert(libraryAssets).values({ ...copy, version, status: 'active', descriptor: o.descriptor });
    return version;
  });
}
