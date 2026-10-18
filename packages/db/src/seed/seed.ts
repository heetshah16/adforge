import { and, eq } from 'drizzle-orm';
import type { Db } from '../client';
import { archetypes, formats, hookArchetypes, memberships, orgs, projects, users, vocabFamilies } from '../schema';
import { VOCAB, type VocabSeed } from './vocabulary';

/**
 * Upsert by slug. Content fields and family membership follow the seed file;
 * `status` is set only on insert (default `proposed`) — re-seeding never revives a retired row.
 * All-or-nothing: any bad reference rolls the whole seed back.
 */
export async function seedVocabulary(db: Db, vocab: VocabSeed = VOCAB): Promise<void> {
  for (const [kind, list] of [
    ['family', vocab.families],
    ['archetype', vocab.archetypes],
    ['format', vocab.formats],
    ['hook', vocab.hooks],
  ] as const) {
    const seen = new Set<string>();
    for (const { slug } of list) {
      if (seen.has(slug)) throw new Error(`Duplicate ${kind} slug "${slug}" in vocabulary seed`);
      seen.add(slug);
    }
  }
  await db.transaction(async (tx) => {
    for (const f of vocab.families) {
      await tx
        .insert(vocabFamilies)
        .values(f)
        .onConflictDoUpdate({ target: vocabFamilies.slug, set: { name: f.name } });
    }
    const fams = await tx.select().from(vocabFamilies);
    const familyId = (slug: string, kind: 'format' | 'hook'): string => {
      const fam = fams.find((f) => f.slug === slug);
      if (!fam) throw new Error(`Unknown family "${slug}"`);
      if (fam.kind !== kind) throw new Error(`Family "${slug}" is a ${fam.kind} family, used by a ${kind}`);
      return fam.id;
    };

    for (const { slug, status, ...rest } of vocab.archetypes) {
      await tx
        .insert(archetypes)
        .values({ slug, ...rest, status: status ?? 'proposed' })
        .onConflictDoUpdate({ target: archetypes.slug, set: rest });
    }
    for (const { slug, family, status, ...rest } of vocab.formats) {
      const set = { ...rest, familyId: familyId(family, 'format') };
      await tx
        .insert(formats)
        .values({ slug, ...set, status: status ?? 'proposed' })
        .onConflictDoUpdate({ target: formats.slug, set });
    }
    for (const { slug, family, status, ...rest } of vocab.hooks) {
      const set = { ...rest, familyId: familyId(family, 'hook') };
      await tx
        .insert(hookArchetypes)
        .values({ slug, ...set, status: status ?? 'proposed' })
        .onConflictDoUpdate({ target: hookArchetypes.slug, set });
    }
  });
}

const LOCAL_EMAIL = 'local@adforge.dev';
/** Fixed so the tenancy backfill migration (0004) and this seed agree on one org. Never change it. */
export const OPERATOR_ORG_ID = '00000000-0000-4000-8000-000000000001';

/** The operator's own org, a local user (its owner) and a project — for dev scripts and the worker's dev route. */
export async function seedOperator(db: Db): Promise<{ orgId: string; userId: string; projectId: string }> {
  return db.transaction(async (tx) => {
    const orgId = OPERATOR_ORG_ID;
    await tx.insert(orgs).values({ id: orgId, name: 'Operator' }).onConflictDoNothing();
    const [user] = await tx
      .insert(users)
      .values({ email: LOCAL_EMAIL })
      .onConflictDoUpdate({ target: users.email, set: { email: LOCAL_EMAIL } })
      .returning();
    const userId = user!.id;
    await tx.insert(memberships).values({ orgId, userId, role: 'owner' }).onConflictDoNothing();
    const [existing] = await tx.select().from(projects).where(and(eq(projects.orgId, orgId), eq(projects.userId, userId))).limit(1);
    const project = existing ?? (await tx.insert(projects).values({ orgId, userId, name: 'Local' }).returning())[0]!;
    return { orgId, userId, projectId: project.id };
  });
}
