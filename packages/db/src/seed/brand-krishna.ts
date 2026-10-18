import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { and, eq } from 'drizzle-orm';
import { makeTag } from '@adforge/core/library/tags';
import type { Db } from '../client';
import { libraryAssets } from '../schema';
import { seedOperator } from './seed';

/** The locked text every Krishna English voice-over starts from. Changing it is a new voice version, not an edit. */
export const KRISHNA_BASE_INSTRUCT = 'Warm, trustworthy Gujarati family-brand voice; clear and unhurried.';
const DEFAULT_TONE = 'Warm, trustworthy, heritage family kitchen brand since 1925.';

/** What a scraped product.json may carry for the brand; every field is optional (today's fixtures have none of palette, fonts, tone or logo). */
export interface BrandFixture { palette?: string[]; fonts?: string[]; tone?: string; logoKey?: string }

/** Reads the (gitignored) scraped fixtures at seed time and takes the first value found for each brand field. Never written back. */
export function readBrandFixture(dir: string): BrandFixture {
  const out: BrandFixture = {};
  let names: string[] = [];
  try { names = readdirSync(dir).filter((n) => n.startsWith('krishna')).sort(); } catch { return out; }
  for (const n of names) {
    let j: Record<string, unknown>;
    try { j = JSON.parse(readFileSync(join(dir, n, 'product.json'), 'utf8')); } catch { continue; }
    const b = { ...j, ...((j.brand && typeof j.brand === 'object' ? j.brand : {}) as Record<string, unknown>) };
    const strs = (v: unknown) => (Array.isArray(v) && v.every((x) => typeof x === 'string') && v.length ? (v as string[]) : undefined);
    out.palette ??= strs(b.palette);
    out.fonts ??= strs(b.fonts);
    out.tone ??= typeof b.tone === 'string' ? b.tone : undefined;
    out.logoKey ??= typeof b.logoKey === 'string' ? b.logoKey : undefined;
  }
  return out;
}

/**
 * `@brand_krishna` (brand_kit) and `@voice_krishna_en` (voice) in the Operator org. Idempotent: a tag that already has an active
 * row is left alone (no new version), so a re-run adds nothing. Returns the tags this run created.
 */
export async function seedKrishna(db: Db, fixture: BrandFixture = {}): Promise<string[]> {
  const { orgId, projectId } = await seedOperator(db);
  const rows = [
    {
      tag: makeTag('brand_kit', ['krishna']), kind: 'brand_kit' as const,
      descriptor: 'Krishna Hing brand kit: warm, trustworthy heritage family-kitchen look.',
      meta: { palette: fixture.palette ?? [], fonts: fixture.fonts ?? [], tone: fixture.tone ?? DEFAULT_TONE, ...(fixture.logoKey ? { logoKey: fixture.logoKey } : {}) },
    },
    {
      tag: makeTag('voice', ['krishna', 'en']), kind: 'voice' as const,
      descriptor: 'Krishna English voice-over: Ryan, warm, trustworthy and unhurried.',
      meta: { engine: 'qwen', speaker: 'Ryan', baseInstruct: KRISHNA_BASE_INSTRUCT },
    },
  ];
  return db.transaction(async (tx) => {
    const created: string[] = [];
    for (const r of rows) {
      const [have] = await tx.select({ id: libraryAssets.id }).from(libraryAssets)
        .where(and(eq(libraryAssets.orgId, orgId), eq(libraryAssets.tag, r.tag), eq(libraryAssets.status, 'active'))).limit(1);
      if (have) continue;
      await tx.insert(libraryAssets).values({ orgId, projectId, ...r, version: 1 });
      created.push(r.tag);
    }
    return created;
  });
}
