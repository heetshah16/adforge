import type { Env } from '@adforge/core/config/env';
import { PIPELINE } from '@adforge/core/config/pipeline';
import { TREATMENTS } from '@adforge/core/config/treatments';
import { loadPrompt } from '@adforge/core/llm/prompts';

/** What this job actually ran with (ADR 0006). Allow-listed fields only — never secrets. */
export function buildConfigSnapshot(o: { env: Env; workflowHashes: Record<string, string> }): Record<string, unknown> {
  const e = o.env;
  return {
    pipeline: PIPELINE,
    treatments: TREATMENTS,
    providers: {
      storage: e.ADFORGE_PROVIDER_STORAGE, image: e.ADFORGE_PROVIDER_IMAGE, cutout: e.ADFORGE_PROVIDER_CUTOUT,
      video: e.ADFORGE_PROVIDER_VIDEO, tts: e.ADFORGE_PROVIDER_TTS, aligner: e.ADFORGE_PROVIDER_ALIGNER, llm: e.ADFORGE_PROVIDER_LLM,
    },
    models: {
      strategist: e.ADFORGE_LLM_STRATEGIST, director: e.ADFORGE_LLM_DIRECTOR,
      strategistEffort: e.ADFORGE_LLM_EFFORT_STRATEGIST, directorEffort: e.ADFORGE_LLM_EFFORT_DIRECTOR,
    },
    comfyWorkflows: {
      plate: e.ADFORGE_COMFY_WORKFLOW_PLATE, cutout: e.ADFORGE_COMFY_WORKFLOW_CUTOUT, broll: e.ADFORGE_COMFY_WORKFLOW_BROLL, hashes: o.workflowHashes,
    },
    prompts: { strategist: loadPrompt('strategist').sha256, director: loadPrompt('director').sha256 },
  };
}
