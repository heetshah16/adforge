import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseEnv } from '@adforge/core/config/env';
import { loadPrompt } from '@adforge/core/llm/prompts';
import type { DirectorOutput } from '@adforge/core/llm/schemas';
import { ProviderError, type MediaRef, type OcrItem, type ProviderResult, type TTSRequest } from '@adforge/core/providers/types';
import { jobs } from '@adforge/db/schema';
import { openDb } from '@adforge/db/client';
import { seedOperator, seedVocabulary } from '@adforge/db/seed/seed';
import sharp from 'sharp';
import { LocalDiskStorage } from '@adforge/provider-local-storage';
import type { PipelineDeps } from '../src/types';

/** A tiny decodable PNG, distinct per (a, b): uploads are re-decoded by the normalize step, so fake bytes no longer pass. */
export const realPng = (a: number, b = 0) =>
  sharp({ create: { width: 8, height: 8, channels: 3, background: { r: (a * 37) % 256, g: (b * 53) % 256, b: 90 } } }).png().toBuffer().then((x) => new Uint8Array(x));

export const anchor = (): DirectorOutput => {
  const t = loadPrompt('director').text;
  return JSON.parse(t.slice(t.indexOf('```json') + 7, t.lastIndexOf('```')));
};
export const BRIEF = {
  product: { name: 'Sattvik Oil', one_liner: 'oil', price_signal: 'premium', price_note: '3x' },
  archetype_primary: 'trust', archetype_secondary: 'indulgence', // makes all three anchor formats shortlist-eligible
  audience: 'a', core_objection: 'b', differentiators: ['no hexane'], rationale: 'Bought as a trust purchase.', confidence: 'high',
};

export const PLATE = { cameraHeight: 'table', tiltDeg: -5, horizonY: 0.4, supportSurface: { box: [0.1, 0.6, 0.8, 0.3] }, light: { azimuthDeg: 30, colorTempK: 5000 }, freeZones: [[0.1, 0.1, 0.3, 0.2]] };
const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 3, 0, 0, 0, 5, 64]);
const fail = (code: ProviderError['code'], retryable: boolean): ProviderResult<never> => ({ status: 'failed', error: new ProviderError('fake', code, `fake ${code}`), retryable });

export interface FakeControls {
  failRender?: number[];      // variantNos whose render fails
  failBroll?: boolean;        // every b-roll poll fails (retryable)
  director?: unknown[];       // canned Director outputs (default: anchor)
  voiceSm120?: boolean;
  comfyDown?: boolean;
  ocr?: OcrItem[];            // what every OCR read returns (default: one label line)
  plateAnalysisFails?: boolean; // every plate-analysis LLM call fails (non-retryable)
  plateTransient?: number;    // the first N plate-analysis LLM calls fail retryably
  depthDown?: boolean;        // every depth estimate fails
  visionDown?: boolean;       // every OCR read fails (retryable UPSTREAM)
}

export async function makeDeps(ctl: FakeControls = {}) {
  const { db, close } = await openDb();
  await seedVocabulary(db);
  const op = await seedOperator(db);
  const storage = new LocalDiskStorage(join(mkdtempSync(join(tmpdir(), 'adforge-pipe-')), 'media'), 'http://localhost:3000');
  const calls = { image: 0, cutout: 0, videoSubmit: 0, videoPoll: 0, tts: 0, align: 0, render: 0, llm: 0, free: 0, unload: 0, ocr: 0, visionUnload: 0, luma: 0, depth: 0, plateLlm: 0 };
  let n = 0;
  const put = async (mime: string, extra: Partial<MediaRef> = {}) =>
    ({ ...(await storage.put(new Uint8Array([...PNG, n++]), { mime })), ...extra });
  const done = <T>(value: T): ProviderResult<T> => ({ status: 'done', value, cost: { amountUsd: 0, estimated: false }, latencyMs: 1 });
  const ttsReqs: TTSRequest[] = [];
  const director = ctl.director ?? [anchor()];

  const deps: PipelineDeps = {
    db, storage,
    env: parseEnv({}),
    sleep: async () => {},
    comfy: {
      workflowHashes: { 'plate-flux-schnell': 'p'.repeat(64) },
      preflight: async () => { if (ctl.comfyDown) throw new ProviderError('comfyui', 'UPSTREAM', 'ComfyUI unreachable'); },
      free: async () => { calls.free++; },
      systemStats: async () => ({ vramUsedBytes: 0, vramTotalBytes: 16e9 }),
      image: { id: 'fake', generate: async () => { calls.image++; return done(await put('image/png', { width: 768, height: 1344 })); } },
      cutout: { id: 'fake', cutout: async () => { calls.cutout++; return done(await put('image/png')); } },
      video: {
        id: 'fake',
        capabilities: { modes: ['image_to_video'], maxDurationSec: 5, resolutions: ['720p'], typicalLatencyMs: 1 },
        submit: async (r) => { calls.videoSubmit++; return { provider: 'fake', externalId: r.idempotencyKey, pollAfterMs: 1 }; },
        poll: async () => { calls.videoPoll++; return ctl.failBroll ? fail('UPSTREAM', true) : done(await put('video/mp4', { durationSec: 121 / 24 })); },
      },
    },
    voice: {
      health: async () => ({ ok: true, sm120: ctl.voiceSm120 ?? true }),
      unload: async () => { calls.unload++; return { unloaded: [] }; },
      tts: { id: 'fake', synthesize: async (r) => { calls.tts++; ttsReqs.push(r); return done(await put('audio/wav', { durationSec: 3 })); } },
      aligner: { id: 'fake', align: async () => { calls.align++; return done({ words: [{ text: 'w', startSec: 0.1, endSec: 0.4 }] }); } },
    },
    vision: {
      ocr: { id: 'fake-ocr', read: async () => { calls.ocr++; return ctl.visionDown ? fail('UPSTREAM', true) : done(ctl.ocr ?? [{ text: 'KRISHNA HING RAS', box: [0.1, 0.1, 0.5, 0.1], conf: 0.9 }]); } },
      luma: { id: 'fake-luma', grid: async () => { calls.luma++; return done([[10, 20], [30, 40]]); } },
      depth: { id: 'fake-depth', estimate: async () => { calls.depth++; return ctl.depthDown ? fail('UPSTREAM', true) : done(await put('image/png')); } },
      unload: async () => { calls.visionUnload++; return { unloaded: [] }; },
    },
    renderer: {
      id: 'fake',
      render: async (req) => {
        calls.render++;
        const v = Number(req.idempotencyKey.split(':').pop());
        return ctl.failRender?.includes(v) ? fail('UPSTREAM', false) : done(await put('video/mp4', { durationSec: req.spec.durationInFrames / 30 }));
      },
    },
    llm: {
      id: 'fake',
      async generate(req) {
        if (req.system === loadPrompt('vision-plate').text) {
          calls.plateLlm++;
          if (ctl.plateAnalysisFails) return fail('INVALID_INPUT', false);
          if (calls.plateLlm <= (ctl.plateTransient ?? 0)) return fail('UPSTREAM', true);
          const value = req.schema.parse(PLATE);
          return { status: 'done', value: { value, usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0 } }, cost: { amountUsd: 0.02, estimated: true }, latencyMs: 1 };
        }
        calls.llm++;
        const value = req.schema.parse(calls.llm === 1 ? BRIEF : director.shift() ?? anchor());
        return { status: 'done', value: { value, usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0 } }, cost: { amountUsd: 0.01, estimated: true }, latencyMs: 1 };
      },
    },
  };
  return { deps, calls, close, op, ttsReqs };
}

/** A real jobs row in the Operator org (provider_calls.jobId is a foreign key; the job row scopes every write). */
export async function jobRow(deps: PipelineDeps): Promise<string> {
  const [j] = await deps.db.insert(jobs).values({ ...(await seedOperator(deps.db)), inputSpec: {} }).returning();
  return j!.id;
}
