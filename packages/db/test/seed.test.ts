import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { openDb } from '../src/client';
import { archetypes, formats, hookArchetypes, projects, users, vocabFamilies } from '../src/schema';
import { seedLocalUser, seedVocabulary } from '../src/seed/seed';
import { VOCAB, type VocabSeed } from '../src/seed/vocabulary';

const clone = (): VocabSeed => structuredClone(VOCAB);

describe('seedVocabulary', () => {
  it('seeds 7 archetypes, 8 formats, 7 hooks, 9 families — all active', async () => {
    const { db, close } = await openDb();
    await seedVocabulary(db);
    expect(await db.$count(archetypes)).toBe(7);
    expect(await db.$count(formats)).toBe(8);
    expect(await db.$count(hookArchetypes)).toBe(7);
    expect(await db.$count(vocabFamilies)).toBe(9);
    expect(await db.$count(hookArchetypes, eq(hookArchetypes.status, 'active'))).toBe(7);
    await close();
  });

  it('inserts a new seed entry as proposed when it has no status', async () => {
    const { db, close } = await openDb();
    const vocab = clone();
    vocab.hooks.push({ slug: 'test_new_hook', family: 'tension', name: 'T', shape: 's', skeleton: 'k', fitsArchetypes: [] });
    await seedVocabulary(db, vocab);
    const [row] = await db.select().from(hookArchetypes).where(eq(hookArchetypes.slug, 'test_new_hook'));
    expect(row!.status).toBe('proposed');
    await close();
  });

  it('rejects a duplicate slug within one seed', async () => {
    const { db, close } = await openDb();
    const vocab = clone();
    vocab.hooks.push({ ...vocab.hooks[0]! });
    await expect(seedVocabulary(db, vocab)).rejects.toThrow(/Duplicate hook slug "pattern_break"/);
    await close();
  });

  it('is idempotent', async () => {
    const { db, close } = await openDb();
    await seedVocabulary(db);
    await seedVocabulary(db);
    expect(await db.$count(formats)).toBe(8);
    await close();
  });

  it('applies a family regroup on re-seed but never un-retires a row', async () => {
    const { db, close } = await openDb();
    await seedVocabulary(db);
    await db.update(hookArchetypes).set({ status: 'retired' }).where(eq(hookArchetypes.slug, 'confession'));

    const vocab = clone();
    vocab.hooks.find((h) => h.slug === 'direct_call')!.family = 'tension';
    await seedVocabulary(db, vocab);

    const [tension] = await db.select().from(vocabFamilies).where(eq(vocabFamilies.slug, 'tension'));
    const [directCall] = await db.select().from(hookArchetypes).where(eq(hookArchetypes.slug, 'direct_call'));
    const [confession] = await db.select().from(hookArchetypes).where(eq(hookArchetypes.slug, 'confession'));
    expect(directCall?.familyId).toBe(tension?.id);
    expect(confession?.status).toBe('retired');
    await close();
  });

  it('fails the whole seed when a hook points at a format family', async () => {
    const { db, close } = await openDb();
    const vocab = clone();
    vocab.hooks[0]!.family = 'narrative_arc';
    await expect(seedVocabulary(db, vocab)).rejects.toThrow(/narrative_arc.*format.*hook/);
    expect(await db.$count(vocabFamilies)).toBe(0); // rolled back
    await close();
  });
});

describe('seedLocalUser', () => {
  it('creates one user and one project, idempotently', async () => {
    const { db, close } = await openDb();
    const a = await seedLocalUser(db);
    const b = await seedLocalUser(db);
    expect(b).toEqual(a);
    expect(await db.$count(users)).toBe(1);
    expect(await db.$count(projects)).toBe(1);
    await close();
  });
});
