import { describe, expect, it } from 'vitest';
import { formatTag, makeTag, nextVersion, parseTag } from '../src/library/tags';

describe('makeTag', () => {
  it('prefixes by kind and joins sanitised parts with underscores', () => {
    expect(makeTag('product_view', ['KrishnaHingras', 'Front'])).toBe('@prod_krishnahingras_front');
    expect(makeTag('location', ['Studio A'])).toBe('@loc_studioa');
    expect(makeTag('prop', ['pouch'])).toBe('@prop_pouch');
    expect(makeTag('brand_kit', ['acme'])).toBe('@brand_acme');
    expect(makeTag('voice', ['warm-1'])).toBe('@voice_warm1');
  });

  it('strips everything outside a-z and 0-9, and drops parts left empty', () => {
    expect(makeTag('prop', ['  Ünïcode! ', '--', 'Tea_Tin'])).toBe('@prop_ncode_teatin');
  });

  it('throws when no part survives sanitising', () => {
    expect(() => makeTag('prop', ['!!!'])).toThrow();
  });
});

describe('parseTag', () => {
  it('round-trips makeTag for every kind', () => {
    const cases = [
      ['product_view', ['krishnahingras', 'front']],
      ['location', ['studio']],
      ['prop', ['pouch']],
      ['brand_kit', ['acme']],
      ['voice', ['warm', 'one']],
    ] as const;
    for (const [kind, parts] of cases) {
      expect(parseTag(makeTag(kind, [...parts]))).toEqual({ kind, parts: [...parts] });
    }
  });

  it('throws on an unknown prefix', () => {
    expect(() => parseTag('@widget_x')).toThrow();
  });
});

describe('formatTag', () => {
  it('appends _v<version> to the base tag', () => {
    expect(formatTag('@prod_krishnahingras_front', 1)).toBe('@prod_krishnahingras_front_v1');
    expect(formatTag('@prod_krishnahingras_front', 12)).toBe('@prod_krishnahingras_front_v12');
  });
});

describe('nextVersion', () => {
  it('starts at 1 when there are no versions', () => {
    expect(nextVersion([])).toBe(1);
  });

  it('is max + 1, not count + 1', () => {
    expect(nextVersion([1, 2, 5])).toBe(6);
    expect(nextVersion([3, 1])).toBe(4);
  });
});
