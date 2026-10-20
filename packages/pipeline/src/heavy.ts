import { createHash } from 'node:crypto';
import { PIPELINE, QwenSpeaker } from '@adforge/core/config/pipeline';
import { TREATMENTS } from '@adforge/core/config/treatments';
import type { DirectorVariant } from '@adforge/core/llm/schemas';
import type { MediaRef, ProviderResult, VoiceBible } from '@adforge/core/providers/types';
import { ttsText } from '@adforge/core/llm/tts-text';
import { canonicalJson, type Recipe } from '@adforge/core/recipe';
import { alignCaptions } from '@adforge/core/spec/align-captions';
import type { VideoSpec } from '@adforge/core/spec/video-spec';
import type { Language } from '@adforge/core/vocab/enums';
import { and, desc, eq } from 'drizzle-orm';
import { formatTag, makeTag } from '@adforge/core/library/tags';
import { libraryAssets } from '@adforge/db/schema';
import { jobScope, recordCall, recordRecipe, refFromKey, saveAsset } from './record';
import type { BrollResult, PipelineDeps, PlateResult, PlateVisionResult, RenderResult, VoiceBeats, VoiceResult } from './types';
import { toWire } from './wire';

async function call<T>(deps: PipelineDeps, jobId: string, kind: string, provider: string, idempotencyKey: string, run: () => Promise<ProviderResult<T>>, model?: string) {
  const r = await run();
  await recordCall(deps.db, {
    jobId, kind, provider, model, idempotencyKey, result: r,
    latencyMs: r.status === 'done' ? r.latencyMs : undefined, costUsd: r.status === 'done' ? r.cost.amountUsd : 0,
  });
  return r;
}
type Scope = { orgId: string; projectId: string };
const keep = async (deps: PipelineDeps, scope: Scope, kind: string, r: ProviderResult<MediaRef>) =>
  r.status === 'done' ? (await saveAsset(deps.db, scope, kind, r.value), r.value) : null;

/** Records how `ref` was made, after the call succeeded and inside the same step; a failed call records nothing. Returns `ref`. */
async function remember<T extends { id: string }>(deps: PipelineDeps, scope: Scope, r: Omit<Recipe, 'orgId'>, ref: T | null): Promise<T | null> {
  if (ref) await recordRecipe(deps.db, { ...r, orgId: scope.orgId }, ref.id);
  return ref;
}
/**
 * A comfy recipe's model is its workflow; its version is that workflow's hash, as the config snapshot records it.
 * ponytail: the weight files a workflow loads by name are not captured; upgrade path: ComfyUI reports model ids via /health, folded into version.
 */
function comfyModel(deps: PipelineDeps, workflow: string): { model: string; version: string } {
  const version = deps.comfy.workflowHashes[workflow];
  if (!version) throw new Error(`no ComfyUI workflow hash for ${workflow}: a recipe without it could hit across workflow changes`);
  return { model: workflow, version };
}
/**
 * TTS and alignment output depend on the whole voice config (engine routing, speaker, instructs, ASR language), as the snapshot records it.
 * ponytail: sidecar weights (Qwen/Chatterbox checkpoint, Whisper size) are not captured; upgrade path: the voice services report model ids via /health, folded into version.
 */
const VOICE_VERSION = createHash('sha256').update(canonicalJson(PIPELINE.voice)).digest('hex');

type BibleLookup = { bible: VoiceBible; tag: string; version: number } | { fallback: string; triedTag: string; warn: boolean };
/**
 * The brand's active English voice bible (`@voice_<brand>_en`) in this org. Never throws: every miss is a `fallback` with its reason.
 * `warn` says a bible was expected: the job named its brand explicitly, or the org has any voice row. A plain miss for a job with
 * neither is the normal no-bible path (silent; still recorded as `config-defaults`). Unusable rows, unmakeable slugs and lookup errors always warn.
 */
async function voiceBible(deps: PipelineDeps, orgId: string, brand: { explicit?: string; fromName?: string }): Promise<BibleLookup> {
  // English must be on Qwen for a bible to apply; otherwise it is unused and must not be attributed.
  if (PIPELINE.voice.engineByLanguage.en !== 'qwen') return { fallback: 'English voice engine is not qwen', triedTag: '(none)', warn: false };
  const name = brand.explicit ?? brand.fromName;
  if (!name) return { fallback: 'job names no brand', triedTag: '(none)', warn: !!brand.explicit };
  let tag: string;
  try { tag = makeTag('voice', [name, 'en']); } catch { return { fallback: `no usable brand slug from "${name}"`, triedTag: `(${name})`, warn: true }; }
  try {
    const [row] = await deps.db.select({ meta: libraryAssets.meta, version: libraryAssets.version }).from(libraryAssets).where(and(
      eq(libraryAssets.orgId, orgId), eq(libraryAssets.tag, tag), eq(libraryAssets.kind, 'voice'), eq(libraryAssets.status, 'active'),
    )).orderBy(desc(libraryAssets.version)).limit(1);
    if (!row) {
      const [any] = brand.explicit ? [true] : await deps.db.select({ id: libraryAssets.id }).from(libraryAssets).where(and(eq(libraryAssets.orgId, orgId), eq(libraryAssets.kind, 'voice'))).limit(1);
      return { fallback: 'no active row', triedTag: tag, warn: !!any };
    }
    const m = row.meta as { engine?: string; speaker?: unknown; baseInstruct?: unknown };
    if (m.engine !== 'qwen') return { fallback: `engine is ${JSON.stringify(m.engine)}, not qwen`, triedTag: tag, warn: true };
    if (typeof m.speaker !== 'string' || typeof m.baseInstruct !== 'string') return { fallback: 'meta lacks speaker/baseInstruct', triedTag: tag, warn: true };
    // Unusable rows must fall back here: the Qwen request caps speaker (enum) and `base + ' ' + beat instruct` (300), and a 400 per beat would fail every beat.
    if (!QwenSpeaker.safeParse(m.speaker).success) return { fallback: `speaker ${JSON.stringify(m.speaker)} is not a Qwen speaker`, triedTag: tag, warn: true };
    const q = PIPELINE.voice.qwen;
    if (m.baseInstruct.length + 1 + Math.max(q.calmInstruct.length, q.expressiveInstruct.length) > 300) return { fallback: 'baseInstruct too long (base + beat instruct exceeds 300 chars)', triedTag: tag, warn: true };
    return { bible: { speaker: m.speaker, baseInstruct: m.baseInstruct }, tag, version: row.version };
  } catch (e) {
    return { fallback: `lookup failed: ${e instanceof Error ? e.message : String(e)}`, triedTag: tag, warn: true };
  }
}

export const HEAVY = {
  async plates(deps: PipelineDeps, p: { jobId: string; variants: DirectorVariant[]; photoKey: string }): Promise<PlateResult> {
    const plates: Record<string, string | null> = {};
    try {
      const scope = await jobScope(deps.db, p.jobId);
      for (const v of p.variants) {
        for (const [b, s] of v.scenes.entries()) {
          const key = `${p.jobId}:plate:${v.variant_no}:${b}`;
          const req = { prompt: `${s.scene}, ${TREATMENTS[v.visual_treatment].platePromptSuffix}`, width: PIPELINE.plate.width, height: PIPELINE.plate.height };
          const r = await call(deps, p.jobId, 'image', deps.comfy.image.id, key, () => deps.comfy.image.generate({ ...req, idempotencyKey: key }));
          const ref = await keep(deps, scope, 'plate', r);
          await remember(deps, scope, { kind: 'plate', provider: deps.comfy.image.id, ...comfyModel(deps, deps.env.ADFORGE_COMFY_WORKFLOW_PLATE), request: req }, ref);
          plates[`${v.variant_no}:${b}`] = ref?.id ?? null;
        }
      }
      const photo = await refFromKey(deps.storage, p.photoKey);
      const c = await call(deps, p.jobId, 'cutout', deps.comfy.cutout.id, `${p.jobId}:cutout`, () =>
        deps.comfy.cutout.cutout({ image: photo, idempotencyKey: `${p.jobId}:cutout` }),
      );
      const cut = await remember(deps, scope, { kind: 'cutout', provider: deps.comfy.cutout.id, ...comfyModel(deps, deps.env.ADFORGE_COMFY_WORKFLOW_CUTOUT), request: { imageKey: photo.id } }, await keep(deps, scope, 'cutout', c));
      return { cutout: cut?.id ?? null, plates };
    } finally {
      await deps.comfy.free().catch(() => {});
    }
  },

  /** Luma grid + depth map per distinct plate, on the vision service; the model is released even on failure. A plate that fails is an `error` entry, never a throw. */
  async plateVision(deps: PipelineDeps, p: { jobId: string; plateKeys: string[] }): Promise<PlateVisionResult> {
    const out: PlateVisionResult = {};
    try {
      const scope = await jobScope(deps.db, p.jobId);
      for (const key of p.plateKeys) {
        try {
          const ref = await refFromKey(deps.storage, key);
          const lKey = `${p.jobId}:luma:${key}`;
          const luma = await call(deps, p.jobId, 'luma', deps.vision.luma.id, lKey, () => deps.vision.luma.grid(ref));
          const dKey = `${p.jobId}:depth:${key}`;
          const depth = await call(deps, p.jobId, 'depth', deps.vision.depth.id, dKey, () => deps.vision.depth.estimate(ref, dKey));
          if (luma.status !== 'done' || depth.status !== 'done') {
            const f = luma.status !== 'done' ? luma : depth;
            out[key] = { error: f.status === 'failed' ? f.error.message : 'pending' };
            continue;
          }
          await saveAsset(deps.db, scope, 'depth', depth.value);
          out[key] = { lumaGrid: luma.value, depthKey: depth.value.id };
        } catch (e) {
          out[key] = { error: e instanceof Error ? e.message : String(e) };
        }
      }
      return out;
    } finally {
      await deps.vision.unload().catch(() => {});
    }
  },

  async broll(deps: PipelineDeps, p: { jobId: string; variants: DirectorVariant[]; plates: Record<string, string | null> }): Promise<BrollResult> {
    const out: BrollResult = {};
    try {
      const scope = await jobScope(deps.db, p.jobId);
      for (const v of p.variants) {
        const beat = v.scenes.findIndex((s, b) => s.product_prominence === 'absent' && p.plates[`${v.variant_no}:${b}`]);
        if (beat < 0) { out[v.variant_no] = null; continue; }
        const key = `${p.jobId}:broll:${v.variant_no}`;
        const req = {
          mode: 'image_to_video', prompt: `${v.scenes[beat]!.scene}, subtle ambient motion, static camera`,
          durationSec: PIPELINE.broll.durationSec, aspectRatio: '9:16', resolution: '720p',
        } as const;
        let made: { ref: MediaRef; imageKey: string } | null = null;
        try {
          const firstFrame = await refFromKey(deps.storage, p.plates[`${v.variant_no}:${beat}`]!);
          let result: ProviderResult<MediaRef> | null = null;
          for (let attempt = 0; attempt < 2; attempt++) {
            const handle = await deps.comfy.video.submit({ ...req, firstFrame, idempotencyKey: key });
            // Deterministic deadline: elapsed is the sum of requested poll waits, not the wall clock.
            let elapsed = 0;
            let r = await deps.comfy.video.poll(handle);
            while (r.status === 'pending' && elapsed < PIPELINE.broll.pollDeadlineMs) {
              const wait = Math.max(handle.pollAfterMs, 1);
              await deps.sleep(wait);
              elapsed += wait;
              r = await deps.comfy.video.poll(handle);
            }
            result = r;
            if (r.status === 'done' || (r.status === 'failed' && !r.retryable)) break;
          }
          const res = result!;
          await recordCall(deps.db, {
            jobId: p.jobId, kind: 'video', provider: deps.comfy.video.id, idempotencyKey: key, result: res,
            latencyMs: res.status === 'done' ? res.latencyMs : undefined, costUsd: res.status === 'done' ? res.cost.amountUsd : 0,
          });
          const ref = await keep(deps, scope, 'broll', res);
          if (ref) made = { ref, imageKey: firstFrame.id };
          out[v.variant_no] = ref ? { beat, key: ref.id, durationSec: ref.durationSec ?? PIPELINE.broll.durationSec } : null;
        } catch (e) {
          // B-roll is never fatal: the beat degrades to its plate.
          out[v.variant_no] = null;
          await recordCall(deps.db, {
            jobId: p.jobId, kind: 'video', provider: deps.comfy.video.id, idempotencyKey: key,
            result: { ok: false, code: 'UNKNOWN', message: e instanceof Error ? e.message : String(e), retryable: false },
          }).catch(() => {});
        }
        // Outside the never-fatal try: a failed recipe write is ours, not the provider's, so the step must retry rather than drop the clip.
        if (made) {
          await remember(deps, scope, {
            kind: 'broll', provider: deps.comfy.video.id, ...comfyModel(deps, deps.env.ADFORGE_COMFY_WORKFLOW_BROLL), request: { ...req, imageKey: made.imageKey },
          }, made.ref);
        }
      }
      return out;
    } finally {
      await deps.comfy.free().catch(() => {});
    }
  },

  async voice(deps: PipelineDeps, p: { jobId: string; language: Language; variants: DirectorVariant[]; brand?: string; nameBrand?: string }): Promise<VoiceResult> {
    const out: VoiceBeats = {};
    try {
      const scope = await jobScope(deps.db, p.jobId);
      const found = p.language === 'en' ? await voiceBible(deps, scope.orgId, { explicit: p.brand, fromName: p.nameBrand }) : undefined;
      const bible = found && 'bible' in found ? found.bible : undefined;
      const voiceUsed = found && 'bible' in found ? formatTag(found.tag, found.version) : 'config-defaults';
      const warning = found && 'fallback' in found && found.warn ? `voice bible ${found.triedTag} not used (${found.fallback}), using config defaults` : undefined;
      // The plates batch freed ComfyUI; confirm VRAM actually dropped before the voice model loads (best-effort, 20 s).
      for (let waited = 0; waited < 20_000; waited += 1000) {
        const st = await deps.comfy.systemStats().catch(() => null);
        if (!st || st.vramUsedBytes < st.vramTotalBytes / 2) break;
        await deps.sleep(1000);
      }
      for (const v of p.variants) {
        for (const [b, s] of v.scenes.entries()) {
          // A missing Hinglish vo_tts (rules should prevent it) fails this beat only — partial success stays first-class.
          let text: string;
          try { text = ttsText(s, p.language); } catch { out[`${v.variant_no}:${b}`] = null; continue; }
          const tKey = `${p.jobId}:tts:${v.variant_no}:${b}`;
          const ttsProvider = deps.voice.tts.idFor?.(p.language) ?? deps.voice.tts.id;
          const req = { text, language: p.language, emotion: s.emotion, ...(bible ? { voiceBible: { ...bible } } : {}) }; // spread: an interface is not a JsonValue
          const t = await call(deps, p.jobId, 'tts', ttsProvider, tKey, () => deps.voice.tts.synthesize({ ...req, idempotencyKey: tKey }), voiceUsed);
          const audio = await remember(deps, scope, {
            kind: 'tts', provider: ttsProvider, model: PIPELINE.voice.engineByLanguage[p.language], version: VOICE_VERSION, request: req,
          }, await keep(deps, scope, 'voice', t));
          if (!audio) { out[`${v.variant_no}:${b}`] = null; continue; }
          const dur = audio.durationSec ?? 0;
          const aKey = `${p.jobId}:align:${v.variant_no}:${b}`;
          const a = await call(deps, p.jobId, 'align', deps.voice.aligner.id, aKey, () =>
            deps.voice.aligner.align({ audio, text, language: p.language, idempotencyKey: aKey }),
          );
          if (a.status === 'done') {
            // Alignment has no media output: its words are stored as JSON, so a recipe hit can skip the aligner too.
            const stored = await deps.storage.put(new TextEncoder().encode(JSON.stringify(a.value)), { mime: 'application/json' });
            await remember(deps, scope, {
              kind: 'align', provider: deps.voice.aligner.id, model: deps.env.ADFORGE_PROVIDER_ALIGNER, version: VOICE_VERSION,
              request: { audioKey: audio.id, text, language: p.language },
            }, stored);
          }
          const words = alignCaptions(s, p.language, a.status === 'done' ? a.value.words : [], dur);
          out[`${v.variant_no}:${b}`] = { key: audio.id, durationSec: dur, words };
        }
      }
      return { beats: out, voiceUsed, ...(warning ? { warning } : {}) };
    } finally {
      await deps.voice.unload().catch(() => {});
    }
  },

  async render(deps: PipelineDeps, p: { jobId: string; variantNo: number; spec: VideoSpec }): Promise<RenderResult> {
    const key = `${p.jobId}:render:${p.variantNo}`;
    try {
      const scope = await jobScope(deps.db, p.jobId);
      const r = await call(deps, p.jobId, 'render', deps.renderer.id, key, () => deps.renderer.render({ spec: p.spec, idempotencyKey: key }));
      const w = toWire(r);
      if (!w.ok) return { error: w.message };
      return { key: w.value.id, assetId: await saveAsset(deps.db, scope, 'render', w.value) };
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) };
    }
  },
} as const;
