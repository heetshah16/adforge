export type LibraryKind = 'product_view' | 'location' | 'prop' | 'brand_kit' | 'voice';

const PREFIX: Record<LibraryKind, string> = {
  product_view: '@prod_',
  location: '@loc_',
  prop: '@prop_',
  brand_kit: '@brand_',
  voice: '@voice_',
};

/** Base tag (no version), e.g. makeTag('product_view', ['Krishna Hingras', 'Front']) -> '@prod_krishnahingras_front'. */
export function makeTag(kind: LibraryKind, parts: string[]): string {
  const clean = parts.map((p) => p.toLowerCase().replace(/[^a-z0-9]/g, '')).filter((p) => p.length > 0);
  if (clean.length === 0) throw new Error(`makeTag(${kind}): no part survives sanitising`);
  return PREFIX[kind] + clean.join('_');
}

export function parseTag(tag: string): { kind: LibraryKind; parts: string[] } {
  for (const kind of Object.keys(PREFIX) as LibraryKind[]) {
    const prefix = PREFIX[kind];
    if (tag.startsWith(prefix)) return { kind, parts: tag.slice(prefix.length).split('_') };
  }
  throw new Error(`parseTag: unknown tag prefix in ${tag}`);
}

export function formatTag(tag: string, version: number): string {
  return `${tag}_v${version}`;
}

export function nextVersion(existing: number[]): number {
  return existing.length === 0 ? 1 : Math.max(...existing) + 1;
}
