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
