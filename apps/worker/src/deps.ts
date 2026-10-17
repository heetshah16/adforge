import { join } from 'node:path';
import type { Env } from '@adforge/core/config/env';
import { openDbForEnv } from '@adforge/db/client';
import { seedLocalUser, seedVocabulary } from '@adforge/db/seed/seed';
import type { PipelineDeps } from '@adforge/pipeline';
import { ClaudeAgentProvider } from '@adforge/provider-claude-agent-sdk';
import { createComfyProviders } from '@adforge/provider-comfyui';
import { LocalDiskStorage } from '@adforge/provider-local-storage';
import { createVoiceProviders } from '@adforge/provider-voice-service';
import { HyperframesRenderer } from '@adforge/renderer-hyperframes';

export async function buildDeps(env: Env): Promise<{ deps: PipelineDeps; storage: LocalDiskStorage; close(): Promise<void> }> {
  const { db, close } = await openDbForEnv(env);
  try {
    await seedVocabulary(db);
    const { userId, projectId } = await seedLocalUser(db);
    const storage = new LocalDiskStorage(join(env.ADFORGE_DATA_DIR, 'media'), env.ADFORGE_PUBLIC_URL);
    const comfy = createComfyProviders({
      baseUrl: env.COMFYUI_URL, storage,
      plateWorkflow: env.ADFORGE_COMFY_WORKFLOW_PLATE, cutoutWorkflow: env.ADFORGE_COMFY_WORKFLOW_CUTOUT, brollWorkflow: env.ADFORGE_COMFY_WORKFLOW_BROLL,
    });
    const voice = createVoiceProviders({ baseUrl: env.ADFORGE_VOICE_URL, qwenBaseUrl: env.ADFORGE_QWEN_TTS_URL, storage });
    const deps: PipelineDeps = {
      db, storage, env, userId, projectId,
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      comfy: { image: comfy.image, cutout: comfy.cutout, video: comfy.video, preflight: comfy.preflight, free: comfy.free, systemStats: comfy.systemStats, workflowHashes: comfy.workflowHashes },
      voice: { tts: voice.tts, aligner: voice.aligner, health: voice.health, unload: voice.unload },
      renderer: new HyperframesRenderer({ storage, workDir: join(env.ADFORGE_DATA_DIR, 'render-work') }),
      llm: new ClaudeAgentProvider(),
    };
    return { deps, storage, close };
  } catch (e) {
    await close(); // don't strand the PGlite lock if seeding/wiring fails
    throw e;
  }
}
