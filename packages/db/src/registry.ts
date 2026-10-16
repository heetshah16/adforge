import { asc, eq } from 'drizzle-orm';
import type { FormatEntry, HookEntry, Registry, RegistryEntry } from '@adforge/core/vocab/registry';
import type { Db } from './client';
import { archetypes, formats, hookArchetypes, vocabFamilies } from './schema';

/** All statuses, sorted by slug. Filtering (active / experimental) is the caller's job. */
export async function loadRegistry(db: Db): Promise<Registry> {
  const a = await db
    .select({
      slug: archetypes.slug,
      name: archetypes.name,
      family: vocabFamilies.slug,
      status: archetypes.status,
      definition: archetypes.definition,
    })
    .from(archetypes)
    .leftJoin(vocabFamilies, eq(archetypes.familyId, vocabFamilies.id))
    .orderBy(asc(archetypes.slug));

  const f = await db
    .select({
      slug: formats.slug,
      name: formats.name,
      family: vocabFamilies.slug,
      status: formats.status,
      fitsArchetypes: formats.fitsArchetypes,
      definition: formats.definition,
      beats: formats.beats,
    })
    .from(formats)
    .innerJoin(vocabFamilies, eq(formats.familyId, vocabFamilies.id))
    .orderBy(asc(formats.slug));

  const h = await db
    .select({
      slug: hookArchetypes.slug,
      name: hookArchetypes.name,
      family: vocabFamilies.slug,
      status: hookArchetypes.status,
      fitsArchetypes: hookArchetypes.fitsArchetypes,
      shape: hookArchetypes.shape,
      skeleton: hookArchetypes.skeleton,
    })
    .from(hookArchetypes)
    .innerJoin(vocabFamilies, eq(hookArchetypes.familyId, vocabFamilies.id))
    .orderBy(asc(hookArchetypes.slug));

  return {
    archetypes: a.map((x): RegistryEntry => ({ ...x, family: x.family ?? null, fitsArchetypes: [] })),
    formats: f.map((x): FormatEntry => ({ ...x })),
    hooks: h.map((x): HookEntry => ({ ...x, definition: x.shape })),
  };
}
