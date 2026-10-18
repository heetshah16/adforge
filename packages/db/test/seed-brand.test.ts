import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { formatTag } from '@adforge/core/library/tags';
import { openDb } from '../src/client';
import { libraryAssets } from '../src/schema';
import { KRISHNA_BASE_INSTRUCT, readBrandFixture, seedKrishna } from '../src/seed/brand-krishna';
import { OPERATOR_ORG_ID, seedOperator } from '../src/seed/seed';

const KEY = `ab/${'a'.repeat(64)}.png`;
const fixtureDir = (brand: Record<string, unknown>) => {
  const d = mkdtempSync(join(tmpdir(), 'brand-'));
  mkdirSync(join(d, 'krishna-x'));
  writeFileSync(join(d, 'krishna-x', 'product.json'), JSON.stringify({ name: 'x', brand }));
  return d;
};

describe('seedKrishna', () => {
  it('creates @brand_krishna (source data) and @voice_krishna_en in the Operator org; a re-run adds nothing', async () => {
    const { db, close } = await openDb();
    const first = await seedKrishna(db, { palette: ['#c0392b'], fonts: ['Poppins'], tone: 'warm' });
    expect(first.map((t) => formatTag(t, 1))).toEqual(['@brand_krishna_v1', '@voice_krishna_en_v1']);
    expect(await seedKrishna(db, { palette: ['#000000'] })).toEqual([]);
    const rows = await db.select().from(libraryAssets).where(eq(libraryAssets.orgId, OPERATOR_ORG_ID));
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.kind === 'brand_kit')!.meta).toEqual({ palette: ['#c0392b'], fonts: ['Poppins'], tone: 'warm' });
    expect(rows.find((r) => r.kind === 'voice')).toMatchObject({ status: 'active', meta: { engine: 'qwen', speaker: 'Ryan', baseInstruct: KRISHNA_BASE_INSTRUCT } });
    expect(rows.every((r) => r.descriptor.length > 0)).toBe(true);
    await close();
  });

  it('no palette or fonts: warns, seeds the voice only, and invents no tone', async () => {
    const { db, close } = await openDb();
    const warns: string[] = [];
    expect(await seedKrishna(db, { tone: 'ignored without data' }, (m) => warns.push(m))).toEqual(['@voice_krishna_en']);
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain('@brand_krishna not seeded');
    expect(await db.select().from(libraryAssets).where(eq(libraryAssets.tag, '@brand_krishna'))).toEqual([]);
    await close();
  });

  it('an earlier EMPTY active kit is superseded; a later real kit becomes v2', async () => {
    const { db, close } = await openDb();
    const op = await seedOperator(db);
    await db.insert(libraryAssets).values({ ...op, tag: '@brand_krishna', version: 1, kind: 'brand_kit', descriptor: 'hollow', meta: { palette: [], fonts: [], tone: 'x' } });
    const warns: string[] = [];
    await seedKrishna(db, {}, (m) => warns.push(m));
    const [v1] = await db.select().from(libraryAssets).where(eq(libraryAssets.tag, '@brand_krishna'));
    expect(v1!.status).toBe('superseded');
    await seedKrishna(db, { fonts: ['Poppins'] }, () => {});
    const kits = await db.select().from(libraryAssets).where(eq(libraryAssets.tag, '@brand_krishna'));
    expect(kits.map((k) => [k.version, k.status]).sort()).toEqual([[1, 'superseded'], [2, 'active']]);
    await close();
  });
});

describe('readBrandFixture', () => {
  it('keeps valid fields', () => {
    const f = readBrandFixture(fixtureDir({ palette: ['#AABBCC'], fonts: ['Noto Sans-1', 'Poppins'], tone: 'warm', logoKey: KEY }), () => {});
    expect(f).toEqual({ palette: ['#AABBCC'], fonts: ['Noto Sans-1', 'Poppins'], tone: 'warm', logoKey: KEY });
  });
  it.each([
    ['palette', ['red']],
    ['palette', ['#12345']],
    ['fonts', ['<script>']],
    ['fonts', ['a;b']],
    ['fonts', ["Bob's"]],
    ['fonts', ["x'; background:url(//evil)"]],
    ['fonts', ['x'.repeat(61)]],
    ['fonts', ['a', 'b', 'c', 'd', 'e', 'f', 'g']],
    ['tone', 'x'.repeat(301)],
    ['logoKey', '../etc/passwd'],
    ['logoKey', '/ab/x.png'],
    ['logoKey', 'ab' + String.fromCharCode(92) + 'a'.repeat(64) + '.png'],
    ['logoKey', `https://x.com/${KEY}`],
    ['logoKey', 'ab/../' + 'a'.repeat(64) + '.png'],
  ])('drops invalid %s %j with a warning', (field, value) => {
    const warns: string[] = [];
    const f = readBrandFixture(fixtureDir({ [field]: value }), (m) => warns.push(m));
    expect(f).toEqual({});
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain(`"${field}"`);
  });
});
