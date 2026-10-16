# P4: Vocabulary Shortlist + Diversity Assertion — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:**
- The deterministic **shortlist** narrows the registry to formats and hooks that fit a product's archetype pair, plus one reserved experimental slot.
- **`assertVariantDiversity`** enforces distance, not distinctness: distinct hook **families** and ≥2 format **families**.
- **`offShortlist`** rejects slugs the Director was never offered.

**Architecture:**
- **Pure logic in `packages/core/src/vocab/`:** the `Registry` type, `shortlist()`, `assertVariantDiversity()` and `offShortlist()`.
- **`packages/db`** loads the `Registry` from the seeded tables (`loadRegistry`), joining family slugs.
- **No LLM and no network.** The results are reproducible and explainable.

**Tech Stack:** TypeScript 7, Zod 4 (none needed here), Drizzle 0.45 + PGlite 0.5.8, Vitest 5.

**Spec:** [spec](../specs/2026-10-15-adforge-local-poc-design.md) §5.1, §6 (shortlist, direct); architecture.md §5.1–5.2, §6 "The shortlist". **Roadmap:** the P4 section.

## Global Constraints

- **`slug` is the attribution key; family is the diversity unit.** Distinct slugs spread over too few families must fail. That is the near-synonym case the rule exists for.
- **The shortlist is deterministic:** the same brief and registry always give the same output, with ties broken by slug. It makes no LLM call.
- Only `active` entries fill the ranked lists. **At most one** `experimental` entry goes in the reserved slot. **`proposed` and `retired` are never offered.**
- `fitsArchetypes = []` means "fits any archetype".
- Numbers come from `PIPELINE.shortlist` (`formats: 8`, `hooks: 10`, `reserveExperimentalSlot: true`) and `PIPELINE.diversity` (`minHookFamilies: 3`, `minFormatFamilies: 2`). Nothing is hardcoded.
- **Liveness:** the e2e script opens the real PGlite dir, which is lock-guarded. It must close the database in `finally`, so a crash never leaves a held lock.
- `pnpm test` (typecheck first) before every commit; functional tests per task; **one end-to-end check** at the end (`pnpm e2e:shortlist`).
- Commits: `git -c user.name=heetshah16 -c user.email=shahheet85@gmail.com commit ...` with a `Co-Authored-By:` trailer naming the authoring model.

## Review Focus

1. **Three near-synonym hooks** (distinct slugs, 2 families) must fail with a message naming the shared family. → Task 2 test.
2. **An archetype pair whose fitting formats all share one family** must still get a shortlist that makes ≥2 format families possible. Otherwise the Director can never pass the rule. → Task 3 test (the family top-up).
3. **Retired or proposed entries** must never be offered, even if they would score highest. → Task 3 test.
4. **A slug the registry doesn't know** (a typo, or an LLM inventing one) is a violation, not a crash. → Task 2 test.
5. **The e2e script crashing mid-run** must not leave the database lock held. → Task 4 (`finally { close() }`, plus a lock check in the report).

---

## File Structure

```
packages/core/src/vocab/registry.ts      Registry / RegistryEntry types, familyOf()
packages/core/src/vocab/diversity.ts     Violation, assertVariantDiversity(), offShortlist()
packages/core/src/vocab/shortlist.ts     Ranked, Shortlist, shortlist()
packages/core/test/diversity.test.ts
packages/core/test/shortlist.test.ts
packages/core/test/vocab-fixture.ts      the seeded 7/8/7 registry as plain data (test fixture)
packages/db/src/registry.ts              loadRegistry(db)
packages/db/test/registry.test.ts
packages/db/src/e2e-shortlist.ts         pnpm e2e:shortlist
```

---

### Task 1: `Registry` type (core) + `loadRegistry` (db)

**Files:**
- Create: `packages/core/src/vocab/registry.ts`
- Create: `packages/db/src/registry.ts`
- Test: `packages/db/test/registry.test.ts`

**Interfaces:**
- Produces (`@adforge/core/vocab/registry`):
  - `type VocabStatus = 'proposed' | 'experimental' | 'active' | 'retired'`
  - `interface RegistryEntry { slug; name; family: string | null; status: VocabStatus; fitsArchetypes: string[]; definition: string }`
  - `interface FormatEntry extends RegistryEntry { beats: string[] }`
  - `interface HookEntry extends RegistryEntry { shape: string; skeleton: string }`
  - `interface Registry { archetypes: RegistryEntry[]; formats: FormatEntry[]; hooks: HookEntry[] }`
  - `familyOf(entries, slug): string | null | undefined`: `undefined` for an unknown slug, `null` for no family.
- Produces (`@adforge/db/registry`): `loadRegistry(db: Db): Promise<Registry>`. It returns **all** statuses (historical slugs stay resolvable); callers filter. Entries are sorted by slug.

- [ ] **Step 1: Write the core types**

`packages/core/src/vocab/registry.ts`:
```ts
/** The adaptive vocabulary as plain data. Loaded from the DB once per job; every function over it is pure. */
export type VocabStatus = 'proposed' | 'experimental' | 'active' | 'retired';

export interface RegistryEntry {
  slug: string;
  name: string;
  /** Family slug — the attribution/diversity unit. null when the entry has none (archetypes, for now). */
  family: string | null;
  status: VocabStatus;
  /** [] means "fits any archetype". */
  fitsArchetypes: string[];
  definition: string;
}
export interface FormatEntry extends RegistryEntry {
  beats: string[];
}
export interface HookEntry extends RegistryEntry {
  shape: string;
  skeleton: string;
}
export interface Registry {
  archetypes: RegistryEntry[];
  formats: FormatEntry[];
  hooks: HookEntry[];
}

/** undefined = unknown slug; null = known, no family. */
export function familyOf(entries: readonly RegistryEntry[], slug: string): string | null | undefined {
  const e = entries.find((x) => x.slug === slug);
  return e === undefined ? undefined : e.family;
}
```

- [ ] **Step 2: Write the failing db test**

`packages/db/test/registry.test.ts`:
```ts
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
```

- [ ] **Step 3: Run to verify failure**

Run: `pnpm --filter @adforge/db test`
Expected: FAIL. `../src/registry` cannot be resolved.

- [ ] **Step 4: Implement `loadRegistry`**

`packages/db/src/registry.ts`:
```ts
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
```

- [ ] **Step 5: Run tests, then commit**

Run: `pnpm --filter @adforge/db test`, then `pnpm test`
Expected: all PASS.

```bash
git add packages/core/src/vocab/registry.ts packages/db
git commit -m "feat(vocab): Registry type and loadRegistry with family slugs"
```

---

### Task 2: `assertVariantDiversity` + `offShortlist`

**Files:**
- Create: `packages/core/test/vocab-fixture.ts`
- Create: `packages/core/src/vocab/diversity.ts`
- Test: `packages/core/test/diversity.test.ts`

**Interfaces:**
- Consumes: `Registry`, `familyOf` (Task 1); `PIPELINE` (`@adforge/core/config/pipeline`).
- Produces (`@adforge/core/vocab/diversity`):
  - `type Violation = { rule: 'unknown_slug' | 'hook_family' | 'format_family' | 'off_shortlist'; message: string }`
  - `assertVariantDiversity(variants: { hookSlug: string; formatSlug: string }[], registry: Registry, cfg = PIPELINE.diversity): Violation[]`. An empty result means pass. It is pure, and each message names the offending slugs and families, so the repair prompt can quote it verbatim.
  - `offShortlist(variants, shortlist: { formats: string[]; hooks: string[] }): Violation[]`
- Produces (test fixture): `REGISTRY: Registry`, the seeded 7/8/7 vocabulary as plain data, mirroring `packages/db/src/seed/vocabulary.ts`.

- [ ] **Step 1: Write the fixture**

`packages/core/test/vocab-fixture.ts`:
```ts
import type { FormatEntry, HookEntry, Registry, RegistryEntry } from '../src/vocab/registry';

const arch = (slug: string): RegistryEntry => ({ slug, name: slug, family: null, status: 'active', fitsArchetypes: [], definition: slug });
const fmt = (slug: string, family: string, fits: string[], beats = ['a', 'b', 'c', 'd']): FormatEntry => ({
  slug, name: slug, family, status: 'active', fitsArchetypes: fits, definition: slug, beats,
});
const hook = (slug: string, family: string): HookEntry => ({
  slug, name: slug, family, status: 'active', fitsArchetypes: [], definition: slug, shape: slug, skeleton: slug,
});

/** Mirrors packages/db/src/seed/vocabulary.ts (families per spec §5.1). */
export const REGISTRY: Registry = {
  archetypes: ['gifting', 'identity', 'indulgence', 'remedy', 'trust', 'upgrade', 'utility'].map(arch),
  formats: [
    fmt('before_after', 'narrative_arc', ['remedy', 'upgrade']),
    fmt('listicle_3', 'rational', []),
    fmt('objection_kill', 'persuasion', ['trust', 'utility']),
    fmt('problem_solution', 'narrative_arc', ['remedy', 'utility', 'trust']),
    fmt('sensory_tease', 'sensory', ['indulgence']),
    fmt('spec_flex', 'rational', ['upgrade', 'utility']),
    fmt('styling_moment', 'sensory', ['identity', 'gifting']),
    fmt('ugc_testimonial', 'social_proof', ['remedy', 'trust', 'indulgence']),
  ],
  hooks: [
    hook('confession', 'contrarian'),
    hook('curiosity_gap', 'tension'),
    hook('demonstration', 'evidence'),
    hook('direct_call', 'targeting'),
    hook('objection_lead', 'tension'),
    hook('pattern_break', 'contrarian'),
    hook('stat_shock', 'evidence'),
  ],
};

export const clone = (): Registry => structuredClone(REGISTRY);
```

- [ ] **Step 2: Write the failing test**

`packages/core/test/diversity.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { assertVariantDiversity, offShortlist } from '../src/vocab/diversity';
import { REGISTRY } from './vocab-fixture';

const v = (hookSlug: string, formatSlug: string) => ({ hookSlug, formatSlug });

describe('assertVariantDiversity', () => {
  it('passes three hook families and two format families', () => {
    expect(
      assertVariantDiversity(
        [v('pattern_break', 'problem_solution'), v('stat_shock', 'ugc_testimonial'), v('curiosity_gap', 'problem_solution')],
        REGISTRY,
      ),
    ).toEqual([]);
  });

  it('fails three distinct hook slugs that span only two families (near-synonyms), naming the family', () => {
    const out = assertVariantDiversity(
      [v('pattern_break', 'problem_solution'), v('confession', 'ugc_testimonial'), v('stat_shock', 'objection_kill')],
      REGISTRY,
    );
    expect(out.map((x) => x.rule)).toEqual(['hook_family']);
    expect(out[0]!.message).toContain('contrarian');
    expect(out[0]!.message).toContain('pattern_break');
    expect(out[0]!.message).toContain('confession');
  });

  it('fails when every format is in one family, even with distinct format slugs', () => {
    const out = assertVariantDiversity(
      [v('pattern_break', 'problem_solution'), v('stat_shock', 'before_after'), v('curiosity_gap', 'problem_solution')],
      REGISTRY,
    );
    expect(out.map((x) => x.rule)).toEqual(['format_family']);
    expect(out[0]!.message).toContain('narrative_arc');
  });

  it('reports unknown slugs instead of throwing', () => {
    const out = assertVariantDiversity(
      [v('pattern_brake', 'problem_solution'), v('stat_shock', 'ugc_testimonial'), v('curiosity_gap', 'telenovela')],
      REGISTRY,
    );
    expect(out.filter((x) => x.rule === 'unknown_slug').map((x) => x.message).join()).toMatch(/pattern_brake.*telenovela|telenovela.*pattern_brake/s);
  });

  it('honours configured minimums', () => {
    const two = [v('pattern_break', 'problem_solution'), v('stat_shock', 'before_after')];
    expect(assertVariantDiversity(two, REGISTRY, { minHookFamilies: 2, minFormatFamilies: 1, repairPasses: 1 })).toEqual([]);
  });
});

describe('offShortlist', () => {
  it('flags slugs the Director was not offered', () => {
    const out = offShortlist([v('pattern_break', 'sensory_tease')], { formats: ['problem_solution'], hooks: ['pattern_break'] });
    expect(out).toEqual([{ rule: 'off_shortlist', message: 'format "sensory_tease" was not on the shortlist' }]);
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `pnpm --filter @adforge/core test`
Expected: FAIL. `../src/vocab/diversity` cannot be resolved.

- [ ] **Step 4: Implement**

`packages/core/src/vocab/diversity.ts`:
```ts
import { PIPELINE, type PipelineConfig } from '../config/pipeline';
import { familyOf, type Registry } from './registry';

export interface Violation {
  rule: 'unknown_slug' | 'hook_family' | 'format_family' | 'off_shortlist';
  message: string;
}
type Pick = { hookSlug: string; formatSlug: string };

function familyGroups(slugs: string[], entries: Registry['hooks'] | Registry['formats']) {
  const groups = new Map<string, string[]>();
  for (const slug of slugs) {
    const fam = familyOf(entries, slug);
    if (!fam) continue; // unknown slugs are reported separately
    groups.set(fam, [...(groups.get(fam) ?? []), slug]);
  }
  return groups;
}

/**
 * Distance, not distinctness: hooks must come from distinct families (at least minHookFamilies),
 * formats from at least minFormatFamilies families. Messages are written to be quoted in the repair prompt.
 */
export function assertVariantDiversity(
  variants: Pick[],
  registry: Registry,
  cfg: PipelineConfig['diversity'] = PIPELINE.diversity,
): Violation[] {
  const out: Violation[] = [];
  for (const { hookSlug, formatSlug } of variants) {
    if (familyOf(registry.hooks, hookSlug) === undefined) out.push({ rule: 'unknown_slug', message: `hook "${hookSlug}" is not in the vocabulary` });
    if (familyOf(registry.formats, formatSlug) === undefined) out.push({ rule: 'unknown_slug', message: `format "${formatSlug}" is not in the vocabulary` });
  }

  const hooks = familyGroups(variants.map((x) => x.hookSlug), registry.hooks);
  const shared = [...hooks].filter(([, slugs]) => slugs.length > 1);
  if (shared.length > 0 || hooks.size < Math.min(cfg.minHookFamilies, variants.length)) {
    const detail = shared.map(([fam, slugs]) => `${slugs.map((s) => `"${s}"`).join(' and ')} share hook family "${fam}"`).join('; ');
    out.push({
      rule: 'hook_family',
      message: `hooks must come from ${cfg.minHookFamilies} different families, found ${hooks.size}${detail ? `: ${detail}` : ''}`,
    });
  }

  const formats = familyGroups(variants.map((x) => x.formatSlug), registry.formats);
  if (formats.size < cfg.minFormatFamilies) {
    out.push({
      rule: 'format_family',
      message: `formats must span at least ${cfg.minFormatFamilies} families, found ${formats.size}: ${[...formats.keys()].map((f) => `"${f}"`).join(', ')}`,
    });
  }
  return out;
}

export function offShortlist(variants: Pick[], shortlist: { formats: string[]; hooks: string[] }): Violation[] {
  const out: Violation[] = [];
  for (const { hookSlug, formatSlug } of variants) {
    if (!shortlist.hooks.includes(hookSlug)) out.push({ rule: 'off_shortlist', message: `hook "${hookSlug}" was not on the shortlist` });
    if (!shortlist.formats.includes(formatSlug)) out.push({ rule: 'off_shortlist', message: `format "${formatSlug}" was not on the shortlist` });
  }
  return out;
}
```

- [ ] **Step 5: Run tests, then commit**

Run: `pnpm --filter @adforge/core test`, then `pnpm test`
Expected: all PASS.

```bash
git add packages/core
git commit -m "feat(vocab): family-level diversity assertion and shortlist membership check"
```

---

### Task 3: `shortlist()`

**Files:**
- Create: `packages/core/src/vocab/shortlist.ts`
- Test: `packages/core/test/shortlist.test.ts`

**Interfaces:**
- Consumes: `Registry`, `RegistryEntry` (Task 1); `PIPELINE.shortlist`, `PIPELINE.diversity`.
- Produces (`@adforge/core/vocab/shortlist`):
  - `interface Ranked { slug: string; family: string | null; score: number; reason: string }`
  - `interface Shortlist { formats: Ranked[]; hooks: Ranked[]; experimental: (Ranked & { kind: 'format' | 'hook' }) | null }`
  - `shortlist(brief: { archetypePrimary: string; archetypeSecondary: string }, registry: Registry, cfg = PIPELINE.shortlist, diversity = PIPELINE.diversity): Shortlist`
- **Scoring:** +2 if the entry fits the primary archetype, +1 if it fits the secondary, 0.5 if `fitsArchetypes` is `[]` (fits any), otherwise 0. The function:
  - keeps only `active` entries with a score above 0;
  - sorts by score descending, then slug ascending;
  - caps at `cfg.formats` / `cfg.hooks`;
  - **tops up for families:** if the ranked list spans fewer than `minFormatFamilies` (formats) or `minHookFamilies` (hooks) families, it appends the best-scoring active entry from each missing family (slug order, reason `added for family diversity`) until the minimum is met or no families remain. The cap may be exceeded by those top-ups.
  - **Experimental slot** (when `cfg.reserveExperimentalSlot`): the highest-scoring `experimental` entry across formats and hooks, with ties going to the format, then slug order. `null` if there is none.

- [ ] **Step 1: Write the failing test**

`packages/core/test/shortlist.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { shortlist } from '../src/vocab/shortlist';
import { REGISTRY, clone } from './vocab-fixture';

const brief = (archetypePrimary: string, archetypeSecondary: string) => ({ archetypePrimary, archetypeSecondary });

describe('shortlist', () => {
  it('ranks formats by fit to the archetype pair, ties by slug, with reasons', () => {
    const s = shortlist(brief('remedy', 'trust'), REGISTRY);
    expect(s.formats.map((f) => [f.slug, f.score])).toEqual([
      ['problem_solution', 3],
      ['ugc_testimonial', 3],
      ['before_after', 2],
      ['objection_kill', 1],
      ['listicle_3', 0.5],
    ]);
    expect(s.formats[0]!.reason).toBe('fits primary "remedy" and secondary "trust"');
    expect(s.formats.at(-1)!.reason).toBe('fits any archetype');
  });

  it('is deterministic', () => {
    expect(shortlist(brief('indulgence', 'identity'), REGISTRY)).toEqual(shortlist(brief('indulgence', 'identity'), REGISTRY));
  });

  it('gives visibly different menus to different archetype pairs', () => {
    const a = shortlist(brief('remedy', 'trust'), REGISTRY).formats.map((f) => f.slug);
    const b = shortlist(brief('indulgence', 'identity'), REGISTRY).formats.map((f) => f.slug);
    expect(a).not.toEqual(b);
    expect(b[0]).toBe('sensory_tease');
  });

  it('offers every hook family so 3 distinct hook families are always reachable', () => {
    const s = shortlist(brief('utility', 'upgrade'), REGISTRY);
    expect(new Set(s.hooks.map((h) => h.family)).size).toBeGreaterThanOrEqual(3);
  });

  it('tops up formats from another family when every fitting format shares one', () => {
    const r = clone();
    for (const f of r.formats) f.fitsArchetypes = f.family === 'narrative_arc' ? ['remedy'] : ['gifting'];
    const s = shortlist(brief('remedy', 'remedy'), r);
    const families = new Set(s.formats.map((f) => f.family));
    expect(families.size).toBeGreaterThanOrEqual(2);
    expect(s.formats.find((f) => f.family !== 'narrative_arc')!.reason).toBe('added for family diversity');
  });

  it('never offers retired or proposed entries, and reserves one experimental slot', () => {
    const r = clone();
    r.formats.find((f) => f.slug === 'problem_solution')!.status = 'retired';
    r.formats.find((f) => f.slug === 'ugc_testimonial')!.status = 'proposed';
    r.hooks.find((h) => h.slug === 'stat_shock')!.status = 'experimental';
    const s = shortlist(brief('remedy', 'trust'), r);
    const slugs = s.formats.map((f) => f.slug);
    expect(slugs).not.toContain('problem_solution');
    expect(slugs).not.toContain('ugc_testimonial');
    expect(s.hooks.map((h) => h.slug)).not.toContain('stat_shock');
    expect(s.experimental).toMatchObject({ kind: 'hook', slug: 'stat_shock' });
  });

  it('leaves the experimental slot empty when there is no experimental entry', () => {
    expect(shortlist(brief('remedy', 'trust'), REGISTRY).experimental).toBeNull();
  });

  it('respects the configured caps', () => {
    const s = shortlist(brief('remedy', 'trust'), REGISTRY, { formats: 2, hooks: 3, reserveExperimentalSlot: true });
    expect(s.formats.length).toBeGreaterThanOrEqual(2); // may exceed only via family top-up
    expect(new Set(s.formats.map((f) => f.family)).size).toBeGreaterThanOrEqual(2);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @adforge/core test`
Expected: FAIL. `../src/vocab/shortlist` cannot be resolved.

- [ ] **Step 3: Implement**

`packages/core/src/vocab/shortlist.ts`:
```ts
import { PIPELINE, type PipelineConfig } from '../config/pipeline';
import type { Registry, RegistryEntry } from './registry';

export interface Ranked {
  slug: string;
  family: string | null;
  score: number;
  reason: string;
}
export interface Shortlist {
  formats: Ranked[];
  hooks: Ranked[];
  experimental: (Ranked & { kind: 'format' | 'hook' }) | null;
}
type Brief = { archetypePrimary: string; archetypeSecondary: string };

function rank(e: RegistryEntry, b: Brief): Ranked {
  if (e.fitsArchetypes.length === 0) return { slug: e.slug, family: e.family, score: 0.5, reason: 'fits any archetype' };
  const p = e.fitsArchetypes.includes(b.archetypePrimary);
  const s = b.archetypeSecondary !== b.archetypePrimary && e.fitsArchetypes.includes(b.archetypeSecondary);
  const score = (p ? 2 : 0) + (s ? 1 : 0);
  const reason =
    p && s
      ? `fits primary "${b.archetypePrimary}" and secondary "${b.archetypeSecondary}"`
      : p
        ? `fits primary "${b.archetypePrimary}"`
        : s
          ? `fits secondary "${b.archetypeSecondary}"`
          : 'no archetype fit';
  return { slug: e.slug, family: e.family, score, reason };
}

const byScoreThenSlug = (a: Ranked, b: Ranked) => b.score - a.score || a.slug.localeCompare(b.slug);

function rankKind(entries: readonly RegistryEntry[], b: Brief, cap: number, minFamilies: number): Ranked[] {
  const all = entries.filter((e) => e.status === 'active').map((e) => rank(e, b)).sort(byScoreThenSlug);
  const picked = all.filter((r) => r.score > 0).slice(0, cap);
  const families = new Set(picked.map((r) => r.family));
  for (const candidate of all) {
    if (families.size >= minFamilies) break;
    if (families.has(candidate.family) || picked.includes(candidate)) continue;
    picked.push({ ...candidate, reason: 'added for family diversity' });
    families.add(candidate.family);
  }
  return picked;
}

/** Deterministic, explainable narrowing of the registry for one product (spec §6). No LLM. */
export function shortlist(
  brief: Brief,
  registry: Registry,
  cfg: PipelineConfig['shortlist'] = PIPELINE.shortlist,
  diversity: PipelineConfig['diversity'] = PIPELINE.diversity,
): Shortlist {
  const formats = rankKind(registry.formats, brief, cfg.formats, diversity.minFormatFamilies);
  const hooks = rankKind(registry.hooks, brief, cfg.hooks, diversity.minHookFamilies);

  let experimental: Shortlist['experimental'] = null;
  if (cfg.reserveExperimentalSlot) {
    const candidates = [
      ...registry.formats.filter((e) => e.status === 'experimental').map((e) => ({ ...rank(e, brief), kind: 'format' as const })),
      ...registry.hooks.filter((e) => e.status === 'experimental').map((e) => ({ ...rank(e, brief), kind: 'hook' as const })),
    ].sort((a, b) => b.score - a.score || (a.kind === b.kind ? 0 : a.kind === 'format' ? -1 : 1) || a.slug.localeCompare(b.slug));
    experimental = candidates[0] ?? null;
  }
  return { formats, hooks, experimental };
}
```

- [ ] **Step 4: Run tests, then commit**

Run: `pnpm --filter @adforge/core test`, then `pnpm test`
Expected: all PASS. The first test's exact ranking is the spec of the scoring. If it differs, the scoring is wrong; fix the code, not the expectation.

```bash
git add packages/core
git commit -m "feat(vocab): deterministic shortlist with family top-up and reserved experimental slot"
```

---

### Task 4: End-to-end shortlist check

**Files:**
- Create: `packages/db/src/e2e-shortlist.ts`
- Modify: `packages/db/package.json` (script `"e2e:shortlist": "tsx src/e2e-shortlist.ts"`), root `package.json` (`"e2e:shortlist": "pnpm --filter @adforge/db e2e:shortlist"`)

**Interfaces:**
- Consumes: `openDb`, `loadRegistry`; core `shortlist`, `assertVariantDiversity`; `parseEnv`, `REPO_ROOT`.

- [ ] **Step 1: Write the script**

`packages/db/src/e2e-shortlist.ts`:
```ts
import { join } from 'node:path';
import { REPO_ROOT, parseEnv } from '@adforge/core/config/env';
import { assertVariantDiversity } from '@adforge/core/vocab/diversity';
import { shortlist } from '@adforge/core/vocab/shortlist';
import { openDb } from './client';
import { loadRegistry } from './registry';

try {
  process.loadEnvFile(join(REPO_ROOT, '.env'));
} catch (e) {
  if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
}
const env = parseEnv(process.env);
const { db, close } = await openDb(env.ADFORGE_DATA_DIR);
let ok = true;
try {
  const registry = await loadRegistry(db);
  for (const [p, s] of [['remedy', 'trust'], ['indulgence', 'identity'], ['utility', 'upgrade']] as const) {
    const list = shortlist({ archetypePrimary: p, archetypeSecondary: s }, registry);
    console.log(`\n${p} + ${s}`);
    console.log('  formats:', list.formats.map((f) => `${f.slug}(${f.family},${f.score})`).join(' '));
    console.log('  hooks:  ', list.hooks.map((h) => `${h.slug}(${h.family})`).join(' '));
    console.log('  experimental:', list.experimental?.slug ?? '—');
  }
  const pass = assertVariantDiversity(
    [
      { hookSlug: 'pattern_break', formatSlug: 'problem_solution' },
      { hookSlug: 'stat_shock', formatSlug: 'ugc_testimonial' },
      { hookSlug: 'curiosity_gap', formatSlug: 'objection_kill' },
    ],
    registry,
  );
  const fail = assertVariantDiversity(
    [
      { hookSlug: 'pattern_break', formatSlug: 'problem_solution' },
      { hookSlug: 'confession', formatSlug: 'before_after' },
      { hookSlug: 'stat_shock', formatSlug: 'problem_solution' },
    ],
    registry,
  );
  console.log('\npassing trio violations:', pass);
  console.log('failing trio violations:', fail.map((v) => v.message));
  ok = pass.length === 0 && fail.some((v) => v.rule === 'hook_family') && fail.some((v) => v.rule === 'format_family');
} finally {
  await close();
}
console.log(ok ? '\nSHORTLIST E2E OK' : '\nSHORTLIST E2E FAILED');
process.exit(ok ? 0 : 1);
```

- [ ] **Step 2: Run the end-to-end check (the plan's only one)**

Prerequisite: nothing else has the data dir open (the web app isn't running yet; it arrives in P7).
Run: `pnpm e2e:shortlist`
Expected:
- three visibly different format menus (remedy+trust leads with `problem_solution` / `ugc_testimonial`; indulgence+identity leads with `sensory_tease` / `styling_moment`);
- the passing trio has `[]` violations;
- the failing trio names the shared `contrarian` hook family and the single `narrative_arc` format family;
- `SHORTLIST E2E OK`.

Then confirm the lock was released: `Test-Path C:/adforge-data/.adforge.lock` → `False`.

- [ ] **Step 3: Commit**

```bash
git add packages/db package.json
git commit -m "feat(vocab): e2e shortlist + diversity check against the seeded database"
```

**P4 exit check:** `pnpm test` is green; `pnpm e2e:shortlist` prints `SHORTLIST E2E OK` and leaves no lock behind.
