import { and, eq } from 'drizzle-orm';
import { TREATMENTS } from '@adforge/core/config/treatments';
import type { DirectorVariant } from '@adforge/core/llm/schemas';
import { compileProject, type DroppedOp, type EditOp, type ProjectBase } from '@adforge/core/project';
import { RecipeGraph } from '@adforge/core/recipe';
import { alignCaptions } from '@adforge/core/spec/align-captions';
import type { BeatAssets } from '@adforge/core/spec/build-spec';
import { ttsText } from '@adforge/core/llm/tts-text';
import type { Language } from '@adforge/core/vocab/enums';
import { jobs, variantRevisions, variants } from '@adforge/db/schema';
import type { Db } from '@adforge/db/client';
import { cachedVoiceLines, voiceBible, type PlateLine, type VoiceLine, type VoiceLineOut } from './heavy';
import type { JobInput, PipelineDeps, StepLike } from './types';

type Scene = DirectorVariant['scenes'][number];
type Loaded = {
  orgId: string; base: ProjectBase; own: EditOp[]; effective: EditOp[]; parentBeats: BeatAssets[];
  language: Language; brand?: string; nameBrand?: string; voiceUsed: string;
};
type Plan =
  | { error: string }
  | { voice: VoiceLine[]; plates: PlateLine[]; dropBroll: number | null; scenes: Record<string, Scene> };

/** Only the worker's owner connection writes status/error; a revision that is no longer pending (done, or failed by onFailure) is never rewritten. */
export async function failRevision(db: Db, revisionId: string, message: string): Promise<void> {
  await db.update(variantRevisions).set({ status: 'failed', error: { message } }).where(and(eq(variantRevisions.id, revisionId), eq(variantRevisions.status, 'pending')));
}

/** The scene as the effective ops leave it: a VO edit drops `vo_tts` (a Devanagari line can't be derived from new text). `setting` is the last scene-edit text. */
function applyFields(base: Scene, ops: EditOp[], beat: number): { scene: Scene; setting?: string; error?: string } {
  let scene: Scene = { ...base };
  let setting: string | undefined;
  for (const o of ops) {
    if (o.op !== 'setField' || o.beat !== beat) continue;
    if (o.path === 'vo') { const { vo_tts: _drop, ...rest } = scene; scene = { ...rest, vo: o.value }; }
    else if (o.path === 'emotion') {
      const e = Number(o.value);
      if (!(e >= 0 && e <= 1) || o.value.trim() === '') return { scene, error: `emotion for beat ${beat} must be a number from 0 to 1, got ${JSON.stringify(o.value)}` };
      scene = { ...scene, emotion: e };
    } else if (o.path === 'scene') setting = o.value;
  }
  return { scene, setting };
}

/**
 * Applies a pending revision's edit ops: regenerates only the assets its own ops invalidate (recipe-cache hits skip the provider),
 * then recompiles the project over the new beats. Deterministic problems fail the revision; anything else throws so Inngest retries.
 */
export async function editVariant(revisionId: string, step: StepLike, deps: PipelineDeps): Promise<{ status: string }> {
  const { db } = deps;
  const ctx = await step.run('load', async (): Promise<{ skip: string } | Loaded> => {
    const [rev] = await db.select().from(variantRevisions).where(eq(variantRevisions.id, revisionId));
    if (!rev) throw new Error(`revision ${revisionId} not found`);
    if (rev.status !== 'pending') return { skip: rev.status };
    const [v] = await db.select({ projectBase: variants.projectBase, jobId: variants.jobId }).from(variants).where(eq(variants.id, rev.variantId));
    if (!v?.projectBase) return { skip: 'no editable project' };
    const [job] = await db.select({ inputSpec: jobs.inputSpec, configSnapshot: jobs.configSnapshot }).from(jobs).where(eq(jobs.id, v.jobId));
    const all = await db.select({ id: variantRevisions.id, parentId: variantRevisions.parentId, ops: variantRevisions.ops }).from(variantRevisions).where(eq(variantRevisions.variantId, rev.variantId));
    const byId = new Map(all.map((r) => [r.id, r]));
    const chain: EditOp[][] = [];
    for (let r: (typeof all)[number] | undefined = byId.get(rev.id); r; r = r.parentId ? byId.get(r.parentId) : undefined) chain.unshift(r.ops as EditOp[]);
    const input = job!.inputSpec as JobInput;
    return {
      orgId: rev.orgId,
      base: v.projectBase as ProjectBase,
      own: rev.ops as EditOp[],
      effective: chain.flat(),
      parentBeats: rev.beats as BeatAssets[],
      language: input.language,
      brand: input.product.brand,
      nameBrand: input.product.name.split(/\s+/)[0],
      voiceUsed: ((job!.configSnapshot ?? {}) as { voice?: string }).voice ?? 'config-defaults',
    };
  });
  if ('skip' in ctx) return { status: ctx.skip };
  const fail = (message: string) => step.run('fail', async () => { await failRevision(db, revisionId, message); return true; }).then(() => ({ status: 'failed' }));

  const plan = await step.run('plan', async (): Promise<Plan> => {
    const brollBeat = ctx.parentBeats.findIndex((b) => b.broll);
    const graph = RecipeGraph.fromVariant(ctx.base.variant, brollBeat < 0 ? null : brollBeat);
    let tags: string[];
    try { tags = graph.invalidated(ctx.own); } catch (e) { return { error: e instanceof Error ? e.message : String(e) }; }
    // The voice bible is the exact row the job used (config_snapshot.voice), so an unchanged line gets the recipe generateAds recorded.
    let bible;
    const m = /^(.+)_v(\d+)$/.exec(ctx.voiceUsed);
    if (ctx.language === 'en' && m) {
      const found = await voiceBible(deps, ctx.orgId, {}, { tag: m[1]!, version: Number(m[2]) });
      if (!('bible' in found)) return { error: `voice bible ${ctx.voiceUsed} is no longer usable (${found.fallback})` };
      bible = found.bible;
    }
    const voice: VoiceLine[] = [];
    const plates: PlateLine[] = [];
    const scenes: Record<string, Scene> = {};
    const suffix = TREATMENTS[ctx.base.variant.visual_treatment].platePromptSuffix;
    for (const tag of tags) {
      const [kind, n] = tag.split(':');
      if (kind !== 'voice' && kind !== 'plate') continue;
      const beat = Number(n);
      const { scene, setting, error } = applyFields(ctx.base.variant.scenes[beat]!, ctx.effective, beat);
      if (error) return { error };
      if (kind === 'voice') {
        let text: string;
        try { text = ttsText(scene, ctx.language as Language); } catch (e) { return { error: e instanceof Error ? e.message : String(e) }; }
        scenes[beat] = scene;
        const regen = ctx.own.some((o) => o.op === 'regenerate' && o.assetTag === tag);
        voice.push({ beat, text, language: ctx.language as Language, emotion: scene.emotion, ...(bible ? { voiceBible: bible } : {}), ...(regen ? { nonce: revisionId } : {}) });
      } else {
        // ponytail: the setting text is appended to the scene text; the real prompt compiler arrives with Director v2 (C3).
        plates.push({ beat, prompt: [scene.scene, setting, suffix].filter(Boolean).join(', ') });
      }
    }
    // C2 does not regenerate b-roll: a new plate on the b-roll beat drops the clip and the beat falls back to the plate.
    return { voice, plates, dropBroll: tags.includes('broll') ? brollBeat : null, scenes };
  });
  if ('error' in plan) return fail(plan.error);

  let voice: Record<string, VoiceLineOut | null> = {};
  if (plan.voice.length) {
    const hits = await step.run('voice-cache', () => cachedVoiceLines(deps, revisionId, plan.voice));
    const misses = plan.voice.filter((l) => !hits[l.beat]);
    voice = { ...hits };
    if (misses.length) Object.assign(voice, await step.heavy('voiceLines', 'heavy:voiceLines', { revisionId, lines: misses }));
  }
  const plateKeys = plan.plates.length ? await step.heavy('plateLines', 'heavy:plateLines', { revisionId, lines: plan.plates }) : {};

  return step.run('compile', async () => {
    const beats: BeatAssets[] = structuredClone(ctx.parentBeats);
    for (const l of plan.voice) {
      const r = voice[l.beat];
      if (!r) throw new Error(`voice for beat ${l.beat} could not be made`); // provider failure: retry
      beats[l.beat]!.voice = { key: r.key, durationSec: r.durationSec };
      beats[l.beat]!.words = alignCaptions(plan.scenes[l.beat]!, l.language, r.words, r.durationSec);
    }
    for (const p of plan.plates) {
      const key = plateKeys[p.beat];
      if (!key) throw new Error(`plate for beat ${p.beat} could not be made`);
      beats[p.beat]!.plate = key;
    }
    if (plan.dropBroll !== null) delete beats[plan.dropBroll]!.broll;
    const { spec, dropped } = compileProject({ base: ctx.base, ops: ctx.effective }, beats);
    await db.update(variantRevisions).set({ beats, spec, status: 'ready', error: dropped.length ? { dropped: dropped satisfies DroppedOp[] } : null })
      .where(and(eq(variantRevisions.id, revisionId), eq(variantRevisions.status, 'pending')));
    return { status: 'ready' };
  });
}

/** Renders a ready revision once: the render's idempotency key is `<revisionId>:render`, and a revision with a render is skipped. */
export async function exportRevision(revisionId: string, step: StepLike, deps: PipelineDeps): Promise<{ status: string }> {
  const { db } = deps;
  const ctx = await step.run('load', async (): Promise<{ skip: string } | { jobId: string; variantNo: number; spec: never }> => {
    const [rev] = await db.select({ status: variantRevisions.status, spec: variantRevisions.spec, renderAssetId: variantRevisions.renderAssetId, variantId: variantRevisions.variantId })
      .from(variantRevisions).where(eq(variantRevisions.id, revisionId));
    if (!rev) throw new Error(`revision ${revisionId} not found`);
    if (rev.status !== 'ready' || !rev.spec) return { skip: `revision is ${rev.status}` };
    if (rev.renderAssetId) return { skip: 'already rendered' };
    const [v] = await db.select({ jobId: variants.jobId, variantNo: variants.variantNo }).from(variants).where(eq(variants.id, rev.variantId));
    return { jobId: v!.jobId, variantNo: v!.variantNo, spec: rev.spec as never };
  });
  if ('skip' in ctx) return { status: ctx.skip };
  const out = await step.heavy('render', 'heavy:render', { jobId: ctx.jobId, variantNo: ctx.variantNo, spec: ctx.spec, revisionId });
  if ('error' in out) throw new Error(`render failed: ${out.error}`); // retried; nothing is recorded on the revision
  await step.run('save', async () => {
    await db.update(variantRevisions).set({ renderAssetId: out.assetId }).where(eq(variantRevisions.id, revisionId));
    return true;
  });
  return { status: 'rendered' };
}
