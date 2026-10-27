import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { assertProviderPolicy } from '../providers/policy';

/** env.ts lives at packages/core/src/config/. */
export const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
if (!existsSync(join(REPO_ROOT, 'pnpm-workspace.yaml'))) {
  throw new Error(
    `REPO_ROOT resolved to ${REPO_ROOT}, which is not the AdForge repo root (no pnpm-workspace.yaml). env.ts was likely bundled to a different depth.`,
  );
}

const Effort = z.enum(['low', 'medium', 'high', 'xhigh', 'max']);
const WorkflowName = z.string().regex(/^[a-z0-9-]+$/, 'lowercase letters, digits and dashes only');
const ClaudeModel = z.string().regex(/^[a-z0-9][a-z0-9.-]*$/, 'expected a Claude model id or alias, e.g. claude-opus-5-5');

/**
 * Infrastructure and provider choice. Provider ids are closed lists of what is
 * actually registered — adding a provider adds its id here.
 * LLM calls go through the Claude Agent SDK on the user's subscription (ADR 0009).
 */
export const Env = z
  .object({
    ADFORGE_ENV: z.enum(['dev', 'prod']).default('dev'),
    DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }).optional(),
    INNGEST_SIGNING_KEY: z.string().min(1).optional(),
    INNGEST_EVENT_KEY: z.string().min(1).optional(),

    ADFORGE_DATA_DIR: z
      .string()
      .min(1)
      .default('.data')
      .transform((p) => resolve(REPO_ROOT, p)),
    /** Identifies this GPU worker in `workers` and as the connect instanceId. Required in prod; dev falls back to 'dev-local'. */
    ADFORGE_WORKER_ID: z.string().regex(/^[a-z0-9-]{3,40}$/).optional(),
    ADFORGE_WORKER_PORT: z.coerce.number().int().min(1).max(65535).default(3001),
    ADFORGE_PUBLIC_URL: z.url({ protocol: /^https?$/ }).default('http://127.0.0.1:3001').transform((u) => u.replace(/\/+$/, '')),
    ADFORGE_UI_ORIGIN: z.url({ protocol: /^https?$/ }).default('http://localhost:3000').transform((u) => new URL(u).origin),

    ADFORGE_PROVIDER_STORAGE: z.enum(['local', 'r2']).default('local'),
    R2_ACCOUNT_ID: z.string().min(1).optional(),
    R2_ACCESS_KEY_ID: z.string().min(1).optional(),
    R2_SECRET_ACCESS_KEY: z.string().min(1).optional(),
    R2_BUCKET: z.string().min(1).optional(),
    R2_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
    ADFORGE_MEDIA_TTL_SEC: z.coerce.number().int().min(60).max(3600).default(900),
    ADFORGE_PROVIDER_IMAGE: z.enum(['comfyui']).default('comfyui'),
    ADFORGE_PROVIDER_CUTOUT: z.enum(['comfyui']).default('comfyui'),
    ADFORGE_PROVIDER_VIDEO: z.enum(['comfyui']).default('comfyui'),
    ADFORGE_PROVIDER_LLM: z.enum(['claude-agent-sdk']).default('claude-agent-sdk'),
    ADFORGE_PROVIDER_TTS: z.enum(['chatterbox']).default('chatterbox'),
    ADFORGE_PROVIDER_ALIGNER: z.enum(['whisper']).default('whisper'),
    ADFORGE_VOICE_URL: z.url({ protocol: /^https?$/ }).default('http://127.0.0.1:8190').transform((u) => u.replace(/\/+$/, '')),
    ADFORGE_QWEN_TTS_URL: z.url({ protocol: /^https?$/ }).default('http://127.0.0.1:8191').transform((u) => u.replace(/\/+$/, '')),
    ADFORGE_VISION_URL: z.url({ protocol: /^https?$/ }).default('http://127.0.0.1:8192').transform((u) => u.replace(/\/+$/, '')),

    COMFYUI_URL: z.url({ protocol: /^https?$/ }).default('http://127.0.0.1:8188'),
    ADFORGE_COMFY_WORKFLOW_PLATE: WorkflowName.default('plate-flux-schnell'),
    ADFORGE_COMFY_WORKFLOW_BROLL: WorkflowName.default('broll-wan22-5b'),
    ADFORGE_COMFY_WORKFLOW_CUTOUT: WorkflowName.default('cutout-birefnet'),

    ADFORGE_LLM_STRATEGIST: ClaudeModel.default('claude-sonnet-5-5'),
    ADFORGE_LLM_DIRECTOR: ClaudeModel.default('claude-opus-5-5'),
    ADFORGE_LLM_EFFORT_STRATEGIST: Effort.default('medium'),
    ADFORGE_LLM_EFFORT_DIRECTOR: Effort.default('high'),
    ADFORGE_LLM_VISION: ClaudeModel.default('claude-sonnet-5-5'),
    ADFORGE_LLM_EFFORT_VISION: Effort.default('low'),
  })
  .superRefine((env, ctx) => {
    if (env.ADFORGE_ENV === 'prod' && !env.DATABASE_URL) {
      ctx.addIssue({ code: 'custom', path: ['DATABASE_URL'], message: 'DATABASE_URL is required when ADFORGE_ENV=prod' });
    }
    for (const k of ['INNGEST_SIGNING_KEY', 'INNGEST_EVENT_KEY'] as const) {
      if (env.ADFORGE_ENV === 'prod' && !env[k]) ctx.addIssue({ code: 'custom', path: [k], message: `${k} is required when ADFORGE_ENV=prod` });
    }
    if (env.ADFORGE_ENV === 'prod' && !env.ADFORGE_WORKER_ID) {
      ctx.addIssue({ code: 'custom', path: ['ADFORGE_WORKER_ID'], message: 'ADFORGE_WORKER_ID is required when ADFORGE_ENV=prod' });
    }
    if (env.ADFORGE_ENV === 'prod' && env.ADFORGE_PROVIDER_STORAGE !== 'r2') {
      ctx.addIssue({ code: 'custom', path: ['ADFORGE_PROVIDER_STORAGE'], message: 'must be r2 when ADFORGE_ENV=prod' });
    }
    if (env.ADFORGE_PROVIDER_STORAGE === 'r2') {
      for (const k of ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET'] as const) {
        if (!env[k]) ctx.addIssue({ code: 'custom', path: [k], message: `${k} is required when ADFORGE_PROVIDER_STORAGE=r2` });
      }
    }
  });
export type Env = z.infer<typeof Env>;

/** `FOO=` in a .env file means "unset", not "empty string". */
export function parseEnv(raw: Record<string, string | undefined>): Env {
  const cleaned = Object.fromEntries(Object.entries(raw).filter(([, v]) => v !== undefined && v !== ''));
  const result = Env.safeParse(cleaned);
  if (!result.success) throw new Error(`Invalid environment:\n${z.prettifyError(result.error)}`);
  assertProviderPolicy(result.data);
  return result.data;
}

/** PGlite files and media must not live where OneDrive syncs and locks them. */
export function dataDirWarnings(dataDir: string): string[] {
  const abs = resolve(dataDir);
  return /[\\/]onedrive[\\/ -]/i.test(`${abs}\\`)
    ? [`ADFORGE_DATA_DIR (${abs}) is inside OneDrive — sync will lock PGlite and media files. Use e.g. C:\\adforge-data.`]
    : [];
}
