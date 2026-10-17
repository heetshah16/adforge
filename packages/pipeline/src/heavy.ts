import { PIPELINE } from '@adforge/core/config/pipeline';
import { TREATMENTS } from '@adforge/core/config/treatments';
import type { DirectorVariant } from '@adforge/core/llm/schemas';
import type { MediaRef, ProviderResult } from '@adforge/core/providers/types';
import { ttsText } from '@adforge/core/llm/tts-text';
import { alignCaptions } from '@adforge/core/spec/align-captions';
import type { VideoSpec } from '@adforge/core/spec/video-spec';
import type { Language } from '@adforge/core/vocab/enums';
import { recordCall, refFromKey, saveAsset } from './record';
import type { BrollResult, PipelineDeps, PlateResult, RenderResult, VoiceResult } from './types';
import { toWire } from './wire';

async function call<T>(deps: PipelineDeps, jobId: string, kind: string, provider: string, idempotencyKey: string, run: () => Promise<ProviderResult<T>>) {
  const r = await run();
  await recordCall(deps.db, {
    jobId, kind, provider, idempotencyKey, result: r,
    latencyMs: r.status === 'done' ? r.latencyMs : undefined, costUsd: r.status === 'done' ? r.cost.amountUsd : 0,
  });
  return r;
}
const keep = async (deps: PipelineDeps, kind: string, r: ProviderResult<MediaRef>) =>
  r.status === 'done' ? (await saveAsset(deps.db, deps.projectId, kind, r.value), r.value) : null;

export const HEAVY = {
  async plates(deps: PipelineDeps, p: { jobId: string; variants: DirectorVariant[]; photoKey: string }): Promise<PlateResult> {
    const plates: Record<string, string | null> = {};
    try {
      for (const v of p.variants) {
        for (const [b, s] of v.scenes.entries()) {
          const key = `${p.jobId}:plate:${v.variant_no}:${b}`;
          const r = await call(deps, p.jobId, 'image', deps.comfy.image.id, key, () =>
            deps.comfy.image.generate({ prompt: `${s.scene}, ${TREATMENTS[v.visual_treatment].platePromptSuffix}`, width: PIPELINE.plate.width, height: PIPELINE.plate.height, idempotencyKey: key }),
          );
          plates[`${v.variant_no}:${b}`] = (await keep(deps, 'plate', r))?.id ?? null;
        }
      }
      const photo = await refFromKey(deps.storage, p.photoKey);
      const c = await call(deps, p.jobId, 'cutout', deps.comfy.cutout.id, `${p.jobId}:cutout`, () =>
        deps.comfy.cutout.cutout({ image: photo, idempotencyKey: `${p.jobId}:cutout` }),
      );
      return { cutout: (await keep(deps, 'cutout', c))?.id ?? null, plates };
    } finally {
      await deps.comfy.free().catch(() => {});
    }
  },

  async broll(deps: PipelineDeps, p: { jobId: string; variants: DirectorVariant[]; plates: Record<string, string | null> }): Promise<BrollResult> {
    const out: BrollResult = {};
    try {
      for (const v of p.variants) {
        const beat = v.scenes.findIndex((s, b) => s.product_prominence === 'absent' && p.plates[`${v.variant_no}:${b}`]);
        if (beat < 0) { out[v.variant_no] = null; continue; }
        const key = `${p.jobId}:broll:${v.variant_no}`;
        try {
          const firstFrame = await refFromKey(deps.storage, p.plates[`${v.variant_no}:${beat}`]!);
          let result: ProviderResult<MediaRef> | null = null;
          for (let attempt = 0; attempt < 2; attempt++) {
            const handle = await deps.comfy.video.submit({
              mode: 'image_to_video', prompt: `${v.scenes[beat]!.scene}, subtle ambient motion, static camera`, firstFrame,
              durationSec: PIPELINE.broll.durationSec, aspectRatio: '9:16', resolution: '720p', idempotencyKey: key,
            });
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
          const ref = await keep(deps, 'broll', res);
          out[v.variant_no] = ref ? { beat, key: ref.id, durationSec: ref.durationSec ?? PIPELINE.broll.durationSec } : null;
        } catch (e) {
          // B-roll is never fatal: the beat degrades to its plate.
          out[v.variant_no] = null;
          await recordCall(deps.db, {
            jobId: p.jobId, kind: 'video', provider: deps.comfy.video.id, idempotencyKey: key,
            result: { ok: false, code: 'UNKNOWN', message: e instanceof Error ? e.message : String(e), retryable: false },
          }).catch(() => {});
        }
      }
      return out;
    } finally {
      await deps.comfy.free().catch(() => {});
    }
  },

  async voice(deps: PipelineDeps, p: { jobId: string; language: Language; variants: DirectorVariant[] }): Promise<VoiceResult> {
    const out: VoiceResult = {};
    try {
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
          const t = await call(deps, p.jobId, 'tts', deps.voice.tts.idFor?.(p.language) ?? deps.voice.tts.id, tKey, () =>
            deps.voice.tts.synthesize({ text, language: p.language, emotion: s.emotion, idempotencyKey: tKey }),
          );
          const audio = await keep(deps, 'voice', t);
          if (!audio) { out[`${v.variant_no}:${b}`] = null; continue; }
          const dur = audio.durationSec ?? 0;
          const aKey = `${p.jobId}:align:${v.variant_no}:${b}`;
          const a = await call(deps, p.jobId, 'align', deps.voice.aligner.id, aKey, () =>
            deps.voice.aligner.align({ audio, text, language: p.language, idempotencyKey: aKey }),
          );
          const words = alignCaptions(s, p.language, a.status === 'done' ? a.value.words : [], dur);
          out[`${v.variant_no}:${b}`] = { key: audio.id, durationSec: dur, words };
        }
      }
      return out;
    } finally {
      await deps.voice.unload().catch(() => {});
    }
  },

  async render(deps: PipelineDeps, p: { jobId: string; variantNo: number; spec: VideoSpec }): Promise<RenderResult> {
    const key = `${p.jobId}:render:${p.variantNo}`;
    try {
      const r = await call(deps, p.jobId, 'render', deps.renderer.id, key, () => deps.renderer.render({ spec: p.spec, idempotencyKey: key }));
      const w = toWire(r);
      if (!w.ok) return { error: w.message };
      return { key: w.value.id, assetId: await saveAsset(deps.db, deps.projectId, 'render', w.value) };
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) };
    }
  },
} as const;
