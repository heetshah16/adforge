import { eq } from 'drizzle-orm';
import type { Db } from '../client';
import { archetypes, formats, hookArchetypes, projects, users, vocabFamilies } from '../schema';
import { VOCAB, type VocabSeed } from './vocabulary';

/**
 * Upsert by slug. Content fields and family membership follow the seed file;
 * `status` is set only on insert — re-seeding never revives a retired row.
 * All-or-nothing: any bad reference rolls the whole seed back.
 */
export async function seedVocabulary(db: Db, vocab: VocabSeed = VOCAB): Promise<void> {
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

    for (const { slug, ...rest } of vocab.archetypes) {
      await tx
        .insert(archetypes)
        .values({ slug, ...rest, status: 'active' })
        .onConflictDoUpdate({ target: archetypes.slug, set: rest });
    }
    for (const { slug, family, ...rest } of vocab.formats) {
      const set = { ...rest, familyId: familyId(family, 'format') };
      await tx
        .insert(formats)
        .values({ slug, ...set, status: 'active' })
        .onConflictDoUpdate({ target: formats.slug, set });
    }
    for (const { slug, family, ...rest } of vocab.hooks) {
      const set = { ...rest, familyId: familyId(family, 'hook') };
      await tx
        .insert(hookArchetypes)
        .values({ slug, ...set, status: 'active' })
        .onConflictDoUpdate({ target: hookArchetypes.slug, set });
    }
  });
}

const LOCAL_EMAIL = 'local@adforge.dev';

/** POC stand-in for Supabase Auth: one user, one project. */
export async function seedLocalUser(db: Db): Promise<{ userId: string; projectId: string }> {
  return db.transaction(async (tx) => {
    const [user] = await tx
      .insert(users)
      .values({ email: LOCAL_EMAIL })
      .onConflictDoUpdate({ target: users.email, set: { email: LOCAL_EMAIL } })
      .returning();
    const userId = user!.id;
    const [existing] = await tx.select().from(projects).where(eq(projects.userId, userId)).limit(1);
    const project = existing ?? (await tx.insert(projects).values({ userId, name: 'Local' }).returning())[0]!;
    return { userId, projectId: project.id };
  });
}
