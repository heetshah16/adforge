import type { DirectorVariant } from '../llm/schemas';
import type { EditOp } from '../project/types';

/** `plate:<beat>`, `cutout`, `broll`, `voice:<beat>`, `align:<beat>`. */
export type AssetTag = string;

/**
 * Which generated assets an edit invalidates. Edges: `voice:b → align:b` (alignment reads the audio) and
 * `plate:b → broll` for the b-roll beat (its first frame is that plate). Callers turn tags into recipe keys by building the new recipe.
 */
export class RecipeGraph {
  private constructor(private readonly beats: number, private readonly brollBeat: number) {}

  /**
   * The b-roll beat is the first product-absent beat, as heavy.ts chooses it.
   * ponytail: heavy.ts skips an absent beat whose plate failed; the graph cannot see that, so then the edge points at the wrong beat.
   */
  static fromVariant(v: DirectorVariant): RecipeGraph {
    return new RecipeGraph(v.scenes.length, v.scenes.findIndex((s) => s.product_prominence === 'absent'));
  }

  private edges(tag: AssetTag): AssetTag[] {
    const m = /^(plate|voice):(\d+)$/.exec(tag);
    if (!m) return [];
    if (m[1] === 'voice') return [`align:${m[2]}`];
    return Number(m[2]) === this.brollBeat ? ['broll'] : [];
  }

  /** Transitive downstream tags, sorted. */
  dependents(tag: AssetTag): AssetTag[] {
    const out = new Set<AssetTag>();
    const visit = (t: AssetTag) => { for (const d of this.edges(t)) if (!out.has(d)) { out.add(d); visit(d); } };
    visit(tag);
    return [...out].sort();
  }

  /** The sorted tags whose recipes change. Free ops invalidate nothing; an op on a beat the variant lacks is dropped (compileProject lists it). */
  invalidated(ops: EditOp[]): AssetTag[] {
    const roots: AssetTag[] = [];
    for (const op of ops) {
      if (op.op === 'setField') {
        if (op.path === 'format') throw new Error('structural edits arrive with Director v2');
        if (op.beat < this.beats) roots.push(`${op.path === 'scene' ? 'plate' : 'voice'}:${op.beat}`);
      } else if (op.op === 'regenerate') {
        if (Number(op.assetTag.split(':')[1]) < this.beats) roots.push(op.assetTag);
      }
    }
    return [...new Set(roots.flatMap((r) => [r, ...this.dependents(r)]))].sort();
  }
}
