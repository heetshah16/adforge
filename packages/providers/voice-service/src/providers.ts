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
  const tts: TTSProvider = {
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
    /** Chatterbox health, plus `qwen` when a qwenBaseUrl is configured (null if unreachable). */
    health: async () => ({ ...(await client.health()), ...(qwenClient ? { qwen: await qwenClient.ttsHealth().catch(() => null) } : {}) }),
    /** Unloads both engines; the Qwen unload is best-effort. */
    unload: async () => {
      const r = await client.unload();
      if (qwenClient) await qwenClient.unload().catch(() => undefined);
      return r;
    },
  };
}
