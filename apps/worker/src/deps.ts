import { join } from 'node:path';
import type { Env } from '@adforge/core/config/env';
import type { StorageProvider } from '@adforge/core/providers/types';
import { openDbForEnv } from '@adforge/db/client';
import { seedOperator, seedVocabulary } from '@adforge/db/seed/seed';
import type { PipelineDeps } from '@adforge/pipeline';
import { ClaudeAgentProvider } from '@adforge/provider-claude-agent-sdk';
import { createComfyProviders } from '@adforge/provider-comfyui';
import { CachedStorage, LocalDiskStorage } from '@adforge/provider-local-storage';
import { R2Storage } from '@adforge/provider-r2';
import { createVisionProviders } from '@adforge/provider-vision-service';
import { createVoiceProviders } from '@adforge/provider-voice-service';
import { HyperframesRenderer } from '@adforge/renderer-hyperframes';

/** `operator` is only for the dev HTTP route's new jobs; the pipeline reads org and project from each job row. */
export async function buildDeps(env: Env): Promise<{ deps: PipelineDeps; storage: StorageProvider; operator: Awaited<ReturnType<typeof seedOperator>>; close(): Promise<void> }> {
  const { db, close } = await openDbForEnv(env);
  try {
    await seedVocabulary(db);
    const operator = await seedOperator(db);
    const storage = mediaStore(env);
    const comfy = createComfyProviders({
      baseUrl: env.COMFYUI_URL, storage,
      plateWorkflow: env.ADFORGE_COMFY_WORKFLOW_PLATE, cutoutWorkflow: env.ADFORGE_COMFY_WORKFLOW_CUTOUT, brollWorkflow: env.ADFORGE_COMFY_WORKFLOW_BROLL,
    });
    const voice = createVoiceProviders({ baseUrl: env.ADFORGE_VOICE_URL, qwenBaseUrl: env.ADFORGE_QWEN_TTS_URL, storage });
    const vision = createVisionProviders({ baseUrl: env.ADFORGE_VISION_URL, storage });
    const deps: PipelineDeps = {
      db, storage, env,
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      comfy: { image: comfy.image, cutout: comfy.cutout, video: comfy.video, preflight: comfy.preflight, free: comfy.free, systemStats: comfy.systemStats, workflowHashes: comfy.workflowHashes },
      voice: { tts: voice.tts, aligner: voice.aligner, health: voice.health, unload: voice.unload },
      vision: { ocr: vision.ocr, depth: vision.depth, luma: vision.luma, unload: vision.unload },
      renderer: new HyperframesRenderer({ storage, workDir: join(env.ADFORGE_DATA_DIR, 'render-work') }),
      llm: new ClaudeAgentProvider(),
    };
    return { deps, storage, operator, close };
  } catch (e) {
    await close(); // don't strand the PGlite lock if seeding/wiring fails
    throw e;
  }
}

/** local: content on disk. r2: R2 behind a read-through disk cache (the GPU worker's copy). */
function mediaStore(env: Env): StorageProvider {
  if (env.ADFORGE_PROVIDER_STORAGE === 'local') return new LocalDiskStorage(join(env.ADFORGE_DATA_DIR, 'media'), env.ADFORGE_PUBLIC_URL);
  // parseEnv guarantees the R2 vars when the provider is r2.
  const r2 = new R2Storage({
    accountId: env.R2_ACCOUNT_ID!,
    accessKeyId: env.R2_ACCESS_KEY_ID!,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY!,
    bucket: env.R2_BUCKET!,
    publicUrl: env.ADFORGE_PUBLIC_URL,
    timeoutMs: env.R2_TIMEOUT_MS,
  });
  return new CachedStorage(r2, join(env.ADFORGE_DATA_DIR, 'media-cache'));
}
