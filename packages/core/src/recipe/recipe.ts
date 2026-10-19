import { createHash } from 'node:crypto';

export type JsonValue = string | number | boolean | null | JsonValue[] | { [k: string]: JsonValue | undefined };
export type RecipeKind = 'plate' | 'cutout' | 'broll' | 'tts' | 'align';

/**
 * How an asset was made: the provider request actually sent, minus `idempotencyKey`, with media inputs by storage key.
 * `orgId` is inside, so the same request in two orgs is two recipes and a cache hit never crosses orgs.
 */
export interface Recipe {
  kind: RecipeKind;
  provider: string;
  model: string;
  /** The ComfyUI workflow hash for comfy kinds; a hash of the voice config for tts and align. */
  version: string;
  request: JsonValue;
  seed?: number;
  orgId: string;
}

/** Sorted keys at every depth, no whitespace; undefined object members are dropped, as JSON.stringify does. */
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map((x) => (x === undefined ? 'null' : canonicalJson(x))).join(',')}]`;
  if (v !== null && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).sort().filter((k) => o[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(',')}}`;
  }
  return JSON.stringify(v);
}

export const recipeKey = (r: Recipe): string => createHash('sha256').update(canonicalJson(r)).digest('hex');
