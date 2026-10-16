import { z } from 'zod';
import { ProviderError, type StorageProvider, type TTSProvider } from '@adforge/core/providers/types';
import { PIPELINE, type PipelineConfig } from '@adforge/core/config/pipeline';
import { VoiceClient } from './client';
import { asFailed, TtsReq } from './tts-common';

export type QwenBody = { text: string; speaker: string; instruct: string };

const QwenHealth = z.object({ ok: z.boolean(), device: z.string(), cuda: z.boolean(), sm120: z.boolean(), loaded: z.object({ tts: z.boolean() }), allocated_mb: z.number() });

/** Same transport as VoiceClient (deadline, classified reads, status mapping); only /health differs. */
export class QwenClient extends VoiceClient {
  ttsHealth() {
    return this.json('/health', QwenHealth);
  }
}

/** Director emotion (0..1) -> Qwen speaker + style instruction. Pure. */
export function qwenParams(text: string, emotion: number, cfg: PipelineConfig = PIPELINE): QwenBody {
  const q = cfg.voice.qwen;
  return { text, speaker: q.speaker, instruct: emotion > q.instructExpressiveAbove ? q.expressiveInstruct : q.calmInstruct };
}

export function createQwenTTS(o: { client: QwenClient; storage: StorageProvider; cfg?: PipelineConfig }): TTSProvider {
  return {
    id: 'qwen-tts',
    async synthesize(req) {
      const parsed = TtsReq.safeParse(req);
      if (!parsed.success) return { status: 'failed', error: new ProviderError('qwen-tts', 'INVALID_INPUT', z.prettifyError(parsed.error)), retryable: false };
      if (req.language !== 'en') return { status: 'failed', error: new ProviderError('qwen-tts', 'INVALID_INPUT', `qwen-tts is English only, got "${req.language}"`), retryable: false };
      const started = Date.now();
      try {
        const { bytes, durationSec } = await o.client.synthesize(qwenParams(req.text, req.emotion, o.cfg));
        const ref = await o.storage.put(bytes, { mime: 'audio/wav', durationSec });
        return { status: 'done', value: ref, cost: { amountUsd: 0, estimated: false }, latencyMs: Date.now() - started };
      } catch (e) {
        return asFailed(e);
      }
    },
  };
}
