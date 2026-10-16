import { z } from 'zod';
import {
  ProviderError,
  isRetryable,
  type CaptionAligner,
  type ProviderResult,
  type StorageProvider,
  type TTSProvider,
} from '@adforge/core/providers/types';
import { PIPELINE } from '@adforge/core/config/pipeline';
import { Language } from '@adforge/core/vocab/enums';
import { VoiceClient } from './client';
import { asrLanguage, voiceParams } from './params';

const TtsReq = z.object({ text: z.string().min(1).max(500), language: Language, emotion: z.number().min(0).max(1), idempotencyKey: z.string().min(1) });
const AlignReq = z.object({ audio: z.object({ id: z.string().min(1) }).passthrough(), text: z.string(), language: Language, idempotencyKey: z.string().min(1) });

/** Every failure becomes a ProviderResult. Non-provider errors (storage read/put) are UPSTREAM and retryable. */
const asFailed = (e: unknown): ProviderResult<never> => {
  const error = e instanceof ProviderError ? e : new ProviderError('voice-service', 'UPSTREAM', `voice adapter failed: ${(e as Error | undefined)?.message ?? String(e)}`, e);
  return { status: 'failed', error, retryable: isRetryable(error.code) };
};

export function createVoiceProviders(o: { baseUrl: string; storage: StorageProvider; fetchImpl?: typeof fetch; timeoutMs?: number }) {
  const client = new VoiceClient(o.baseUrl, o.fetchImpl, o.timeoutMs ?? PIPELINE.voice.requestTimeoutMs);

  const tts: TTSProvider = {
    id: 'chatterbox',
    async synthesize(req) {
      const parsed = TtsReq.safeParse(req);
      if (!parsed.success) return { status: 'failed', error: new ProviderError('chatterbox', 'INVALID_INPUT', z.prettifyError(parsed.error)), retryable: false };
      const started = Date.now();
      try {
        const { bytes, durationSec } = await client.synthesize(voiceParams(req.text, req.language, req.emotion));
        const ref = await o.storage.put(bytes, { mime: 'audio/wav', durationSec });
        return { status: 'done', value: ref, cost: { amountUsd: 0, estimated: false }, latencyMs: Date.now() - started };
      } catch (e) {
        return asFailed(e);
      }
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

  return { tts, aligner, health: () => client.health(), unload: () => client.unload() };
}
