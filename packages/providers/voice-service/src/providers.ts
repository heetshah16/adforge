import { z } from 'zod';
import {
  ProviderError,
  type CaptionAligner,
  type StorageProvider,
  type TTSProvider,
} from '@adforge/core/providers/types';
import { PIPELINE, type PipelineConfig } from '@adforge/core/config/pipeline';
import { Language } from '@adforge/core/vocab/enums';
import { VoiceClient } from './client';
import { QwenClient, createQwenTTS } from './qwen';
import { TtsReq, asFailed } from './tts-common';
import { asrLanguage, voiceParams } from './params';

const AlignReq = z.object({ audio: z.object({ id: z.string().min(1) }).passthrough(), text: z.string(), language: Language, idempotencyKey: z.string().min(1) });

export type RoutedTTSProvider = TTSProvider & { /** Id of the engine that serves this language ('chatterbox' | 'qwen-tts') — use for provider_calls attribution. */ idFor(l: Language): string };

export function createVoiceProviders(o: { baseUrl: string; qwenBaseUrl?: string; cfg?: PipelineConfig; storage: StorageProvider; fetchImpl?: typeof fetch; timeoutMs?: number }) {
  const cfg = o.cfg ?? PIPELINE;
  const client = new VoiceClient(o.baseUrl, o.fetchImpl, o.timeoutMs ?? cfg.voice.requestTimeoutMs);
  const qwenClient = o.qwenBaseUrl ? new QwenClient(o.qwenBaseUrl, o.fetchImpl, o.timeoutMs ?? cfg.voice.requestTimeoutMs) : undefined;

  const chatterbox: TTSProvider = {
    id: 'chatterbox',
    async synthesize(req) {
      const parsed = TtsReq.safeParse(req);
      if (!parsed.success) return { status: 'failed', error: new ProviderError('chatterbox', 'INVALID_INPUT', z.prettifyError(parsed.error)), retryable: false };
      const started = Date.now();
      try {
        const { bytes, durationSec } = await client.synthesize(voiceParams(req.text, req.language, req.emotion, cfg));
        const ref = await o.storage.put(bytes, { mime: 'audio/wav', durationSec });
        return { status: 'done', value: ref, cost: { amountUsd: 0, estimated: false }, latencyMs: Date.now() - started };
      } catch (e) {
        return asFailed(e);
      }
    },
  };

  const qwen = qwenClient ? createQwenTTS({ client: qwenClient, storage: o.storage, cfg }) : undefined;

  /** Routes each request to cfg.voice.engineByLanguage[language]. id is deterministic per config: 'chatterbox' while every language is chatterbox (the default). */
  const engines = cfg.voice.engineByLanguage;
  const tts: RoutedTTSProvider = {
    idFor: (l) => (engines[l] === 'qwen' ? 'qwen-tts' : 'chatterbox'),
    id: Object.values(engines).every((e) => e === 'chatterbox') ? 'chatterbox' : `routed(${Object.entries(engines).map(([l, e]) => `${l}=${e}`).join(',')})`,
    async synthesize(req) {
      const lang = Language.safeParse(req?.language);
      if (!lang.success) return chatterbox.synthesize(req); // its Zod check reports the invalid language
      if (engines[lang.data] !== 'qwen') return chatterbox.synthesize(req);
      if (!qwen) return { status: 'failed', error: new ProviderError('qwen-tts', 'INVALID_INPUT', `engineByLanguage.${lang.data} is 'qwen' but no qwenBaseUrl was configured`), retryable: false };
      return qwen.synthesize(req);
    },
  };

  const aligner: CaptionAligner = {
    id: 'whisper',
    async align(req) {
      const parsed = AlignReq.safeParse(req);
      if (!parsed.success) return { status: 'failed', error: new ProviderError('whisper', 'INVALID_INPUT', z.prettifyError(parsed.error)), retryable: false };
      const started = Date.now();
      try {
        const r = await client.align(await o.storage.read(req.audio.id), asrLanguage(req.language));
        return {
          status: 'done',
          value: { words: r.words.map((w) => ({ text: w.text, startSec: w.start, endSec: w.end })) },
          cost: { amountUsd: 0, estimated: false },
          latencyMs: Date.now() - started,
        };
      } catch (e) {
        return asFailed(e);
      }
    },
  };

  return {
    tts,
    aligner,
    /** Chatterbox health, plus `qwen` when a qwenBaseUrl is configured (null if unreachable). ok/sm120 also require qwen when any language routes to it. */
    health: async () => {
      const base = await client.health();
      if (!qwenClient) return base;
      const usesQwen = Object.values(engines).includes('qwen');
      if (!usesQwen) return base;
      const q = await qwenClient.ttsHealth().catch((e) => { console.warn(`voice-qwen health failed: ${(e as Error)?.message ?? e}`); return null; });
      return { ...base, ok: base.ok && (!usesQwen || q?.ok === true), sm120: base.sm120 && (!usesQwen || q?.sm120 === true), qwen: q };
    },
    /** Unloads both engines; the Qwen unload is best-effort. */
    unload: async () => {
      const usesQwen = Object.values(engines).includes('qwen');
      const [r, q] = await Promise.allSettled([client.unload(), usesQwen ? qwenClient?.unload() : undefined]);
      if (q.status === 'rejected') console.warn(`voice-qwen unload failed (best-effort): ${(q.reason as Error)?.message ?? q.reason}`);
      if (r.status === 'rejected') throw r.reason;
      return r.value;
    },
  };
}
