import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { StorageKey } from '@adforge/core/spec/video-spec';
import { makeTag, nextVersion } from '@adforge/core/library/tags';
import type { Db } from '../client';
import { libraryAssets } from '../schema';
import { seedOperator } from './seed';

/** The locked text every Krishna English voice-over starts from. Changing it is a new voice version, not an edit. */
export const KRISHNA_BASE_INSTRUCT = 'Warm, trustworthy Gujarati family-brand voice; clear and unhurried.';

/** What a scraped product.json may carry for the brand; every field is optional and validated at the read boundary. */
export interface BrandFixture { palette?: string[]; fonts?: string[]; tone?: string; logoKey?: string }

const FIELDS = {
  palette: z.array(z.string().regex(/^#[0-9a-fA-F]{6}$/)).min(1),
  fonts: z.array(z.string().regex(/^[A-Za-z0-9 -]{1,60}$/)).min(1).max(6),
  tone: z.string().trim().min(1).max(300),
  logoKey: StorageKey,
} as const;

/**
 * Reads the (gitignored) scraped fixtures at seed time and takes the first VALID value found for each brand field.
 * An invalid field is dropped with a warning, never persisted. Never written back.
 */
export function readBrandFixture(dir: string, warn: (m: string) => void = console.warn): BrandFixture {
  const out: Record<string, unknown> = {};
  let names: string[] = [];
  try { names = readdirSync(dir).filter((n) => n.startsWith('krishna')).sort(); } catch { return out; }
  for (const n of names) {
    let j: Record<string, unknown>;
    try { j = JSON.parse(readFileSync(join(dir, n, 'product.json'), 'utf8')); } catch { continue; }
    const b = { ...j, ...((j.brand && typeof j.brand === 'object' ? j.brand : {}) as Record<string, unknown>) };
    for (const [f, schema] of Object.entries(FIELDS)) {
      if (out[f] !== undefined || b[f] === undefined) continue;
      const r = schema.safeParse(b[f]);
      if (r.success) out[f] = r.data;
      else warn(`brand fixture ${n}: dropped invalid "${f}" (${z.prettifyError(r.error).split(String.fromCharCode(10))[0]})`);
    }
  }
  return out;
}

/**
 * `@voice_krishna_en` always; `@brand_krishna` only when the source gives palette or fonts (no hollow kit: otherwise a warning and
 * no kit, and an earlier EMPTY active kit is superseded). Idempotent: a tag with an active row is left alone, so a re-run adds nothing.
 * Returns the tags this run created.
 */
export async function seedKrishna(db: Db, fixture: BrandFixture = {}, warn: (m: string) => void = console.warn): Promise<string[]> {
  const { orgId, projectId } = await seedOperator(db);
  const hasKit = !!(fixture.palette?.length || fixture.fonts?.length);
  const kitTag = makeTag('brand_kit', ['krishna']);
  const rows = [
    ...(hasKit ? [{
      tag: kitTag, kind: 'brand_kit' as const,
      descriptor: 'Krishna Hing brand kit: the family brand colours and fonts.',
      meta: { palette: fixture.palette ?? [], fonts: fixture.fonts ?? [], ...(fixture.tone ? { tone: fixture.tone } : {}), ...(fixture.logoKey ? { logoKey: fixture.logoKey } : {}) },
    }] : []),
    {
      tag: makeTag('voice', ['krishna', 'en']), kind: 'voice' as const,
      descriptor: 'Krishna English voice-over: Ryan, warm, trustworthy and unhurried.',
      meta: { engine: 'qwen', speaker: 'Ryan', baseInstruct: KRISHNA_BASE_INSTRUCT },
    },
  ];
  if (!hasKit) warn(`no palette or fonts in the brand source: ${kitTag} not seeded (add them to a krishna product.json "brand" object)`);
  return db.transaction(async (tx) => {
    const created: string[] = [];
    const empty = (m: unknown) => { const k = m as { palette?: unknown[]; fonts?: unknown[] }; return !k.palette?.length && !k.fonts?.length; };
    // A hollow kit left by an earlier run steps aside, so no empty active kit remains.
    const [kit] = await tx.select().from(libraryAssets).where(and(eq(libraryAssets.orgId, orgId), eq(libraryAssets.tag, kitTag), eq(libraryAssets.status, 'active'))).limit(1);
    if (kit && empty(kit.meta)) {
      await tx.update(libraryAssets).set({ status: 'superseded' }).where(eq(libraryAssets.id, kit.id));
      warn(`superseded the empty active ${kitTag} v${kit.version}`);
    }
    for (const r of rows) {
      const [have] = await tx.select({ id: libraryAssets.id }).from(libraryAssets)
        .where(and(eq(libraryAssets.orgId, orgId), eq(libraryAssets.tag, r.tag), eq(libraryAssets.status, 'active'))).limit(1);
      if (have) continue;
      const prev = await tx.select({ v: libraryAssets.version }).from(libraryAssets).where(and(eq(libraryAssets.orgId, orgId), eq(libraryAssets.tag, r.tag)));
      await tx.insert(libraryAssets).values({ orgId, projectId, ...r, version: nextVersion(prev.map((x) => x.v)) });
      created.push(r.tag);
    }
    return created;
  });
}
