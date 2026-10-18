import { and, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { formatTag } from '@adforge/core/library/tags';
import { openDb } from '../src/client';
import { libraryAssets, orgs } from '../src/schema';
import { KRISHNA_BASE_INSTRUCT, seedKrishna } from '../src/seed/brand-krishna';
import { OPERATOR_ORG_ID } from '../src/seed/seed';

describe('seedKrishna', () => {
  it('creates @brand_krishna and @voice_krishna_en in the Operator org, and a re-run adds nothing', async () => {
    const { db, close } = await openDb();
    const first = await seedKrishna(db, { palette: ['#c0392b'], fonts: ['Poppins'], tone: 'warm' });
    expect(first.map((t) => formatTag(t, 1))).toEqual(['@brand_krishna_v1', '@voice_krishna_en_v1']);
    expect(await seedKrishna(db, { palette: ['#000000'] })).toEqual([]);
    const rows = await db.select().from(libraryAssets).where(eq(libraryAssets.orgId, OPERATOR_ORG_ID));
    expect(rows).toHaveLength(2);
    const brand = rows.find((r) => r.kind === 'brand_kit')!;
    expect(brand.meta).toEqual({ palette: ['#c0392b'], fonts: ['Poppins'], tone: 'warm' });
    const voice = rows.find((r) => r.kind === 'voice')!;
    expect(voice).toMatchObject({ status: 'active', meta: { engine: 'qwen', speaker: 'Ryan', baseInstruct: KRISHNA_BASE_INSTRUCT } });
    expect(rows.every((r) => r.descriptor.length > 0)).toBe(true);
    expect(await db.$count(orgs, and(eq(orgs.id, OPERATOR_ORG_ID)))).toBe(1);
    await close();
  });

  it('with no fixture fields, the brand kit still carries palette, fonts and a tone', async () => {
    const { db, close } = await openDb();
    await seedKrishna(db);
    const [b] = await db.select().from(libraryAssets).where(eq(libraryAssets.tag, '@brand_krishna'));
    expect(b!.meta).toMatchObject({ palette: [], fonts: [], tone: expect.any(String) });
    await close();
  });
});
