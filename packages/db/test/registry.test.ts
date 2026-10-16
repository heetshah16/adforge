import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { openDb } from '../src/client';
import { loadRegistry } from '../src/registry';
import { hookArchetypes } from '../src/schema';
import { seedVocabulary } from '../src/seed/seed';

describe('loadRegistry', () => {
  it('loads the seeded vocabulary with family slugs, sorted by slug', async () => {
    const { db, close } = await openDb();
    try {
      await seedVocabulary(db);
      const r = await loadRegistry(db);
      expect(r.archetypes).toHaveLength(7);
      expect(r.formats).toHaveLength(8);
      expect(r.hooks).toHaveLength(7);
      expect(r.formats.map((f) => f.slug)).toEqual([...r.formats.map((f) => f.slug)].sort());
      expect(r.hooks.find((h) => h.slug === 'confession')).toMatchObject({ family: 'contrarian', status: 'active' });
      expect(r.hooks.find((h) => h.slug === 'objection_lead')).toMatchObject({ family: 'objection', status: 'active' });
      expect(r.formats.find((f) => f.slug === 'listicle_3')).toMatchObject({ family: 'rational', fitsArchetypes: [] });
      expect(r.formats.find((f) => f.slug === 'problem_solution')?.beats).toEqual(['pain', 'agitate', 'reveal', 'relief']);
      expect(r.archetypes.find((a) => a.slug === 'remedy')).toMatchObject({ family: null, status: 'active' });
    } finally {
      await close();
    }
  });

  it('still returns retired entries so historical slugs resolve', async () => {
    const { db, close } = await openDb();
    try {
      await seedVocabulary(db);
      await db.update(hookArchetypes).set({ status: 'retired' }).where(eq(hookArchetypes.slug, 'confession'));
      const r = await loadRegistry(db);
      expect(r.hooks.find((h) => h.slug === 'confession')?.status).toBe('retired');
    } finally {
      await close();
    }
  });
});
