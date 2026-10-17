import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { assertProviderPolicy } from "../providers/policy";

/** env.ts lives at packages/core/src/config/. */
export const REPO_ROOT = fileURLToPath(
  new URL("../../../../", import.meta.url),
);
if (!existsSync(join(REPO_ROOT, "pnpm-workspace.yaml"))) {
  throw new Error(
    `REPO_ROOT resolved to ${REPO_ROOT}, which is not the AdForge repo root (no pnpm-workspace.yaml). env.ts was likely bundled to a different depth.`,
  );
}

const Effort = z.enum(["low", "medium", "high", "xhigh", "max"]);
const WorkflowName = z
  .string()
  .regex(/^[a-z0-9-]+$/, "lowercase letters, digits and dashes only");
const ClaudeModel = z
  .string()
  .regex(
    /^[a-z0-9][a-z0-9.-]*$/,
    "expected a Claude model id or alias, e.g. claude-opus-5-5",
  );

/**
 * Infrastructure and provider choice. Provider ids are closed lists of what is
 * actually registered — adding a provider adds its id here.
 * LLM calls go through the Claude Agent SDK on the user's subscription (ADR 0009).
 */
export const Env = z
  .object({
    ADFORGE_ENV: z.enum(["dev", "prod"]).default("dev"),
    DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }).optional(),
    ADFORGE_DATA_DIR: z
      .string()
      .min(1)
      .default(".data")
      .transform((p) => resolve(REPO_ROOT, p)),
    ADFORGE_WORKER_PORT: z.coerce
      .number()
      .int()
      .min(1)
      .max(65535)
      .default(3001),
    ADFORGE_PUBLIC_URL: z
      .url({ protocol: /^https?$/ })
      .default("http://127.0.0.1:3001")
      .transform((u) => u.replace(/\/+$/, "")),
    ADFORGE_UI_ORIGIN: z
      .url({ protocol: /^https?$/ })
      .default("http://localhost:3000")
      .transform((u) => new URL(u).origin),

    ADFORGE_PROVIDER_STORAGE: z.enum(["local"]).default("local"),
    ADFORGE_PROVIDER_IMAGE: z.enum(["comfyui"]).default("comfyui"),
    ADFORGE_PROVIDER_CUTOUT: z.enum(["comfyui"]).default("comfyui"),
    ADFORGE_PROVIDER_VIDEO: z.enum(["comfyui"]).default("comfyui"),
    ADFORGE_PROVIDER_LLM: z
      .enum(["claude-agent-sdk"])
      .default("claude-agent-sdk"),
    ADFORGE_PROVIDER_TTS: z.enum(["chatterbox"]).default("chatterbox"),
    ADFORGE_PROVIDER_ALIGNER: z.enum(["whisper"]).default("whisper"),
    ADFORGE_VOICE_URL: z
      .url({ protocol: /^https?$/ })
      .default("http://127.0.0.1:8190")
      .transform((u) => u.replace(/\/+$/, "")),
    ADFORGE_QWEN_TTS_URL: z
      .url({ protocol: /^https?$/ })
      .default("http://127.0.0.1:8191")
      .transform((u) => u.replace(/\/+$/, "")),

    COMFYUI_URL: z
      .url({ protocol: /^https?$/ })
      .default("http://127.0.0.1:8188"),
    ADFORGE_COMFY_WORKFLOW_PLATE: WorkflowName.default("plate-flux-schnell"),
    ADFORGE_COMFY_WORKFLOW_BROLL: WorkflowName.default("broll-wan22-5b"),
    ADFORGE_COMFY_WORKFLOW_CUTOUT: WorkflowName.default("cutout-birefnet"),

    ADFORGE_LLM_STRATEGIST: ClaudeModel.default("claude-sonnet-5-5"),
    ADFORGE_LLM_DIRECTOR: ClaudeModel.default("claude-opus-5-5"),
    ADFORGE_LLM_EFFORT_STRATEGIST: Effort.default("medium"),
    ADFORGE_LLM_EFFORT_DIRECTOR: Effort.default("high"),
  })
  .superRefine((env, ctx) => {
    if (env.ADFORGE_ENV === "prod" && !env.DATABASE_URL) {
      ctx.addIssue({
        code: "custom",
        path: ["DATABASE_URL"],
        message: "DATABASE_URL is required when ADFORGE_ENV=prod",
      });
    }
  });
export type Env = z.infer<typeof Env>;

/** `FOO=` in a .env file means "unset", not "empty string". */
export function parseEnv(raw: Record<string, string | undefined>): Env {
  const cleaned = Object.fromEntries(
    Object.entries(raw).filter(([, v]) => v !== undefined && v !== ""),
  );
  const result = Env.safeParse(cleaned);
  if (!result.success)
    throw new Error(`Invalid environment:\n${z.prettifyError(result.error)}`);
  assertProviderPolicy(result.data);
  return result.data;
}

/** PGlite files and media must not live where OneDrive syncs and locks them. */
export function dataDirWarnings(dataDir: string): string[] {
  const abs = resolve(dataDir);
  return /[\\/]onedrive[\\/ -]/i.test(`${abs}\\`)
    ? [
        `ADFORGE_DATA_DIR (${abs}) is inside OneDrive — sync will lock PGlite and media files. Use e.g. C:\\adforge-data.`,
      ]
    : [];
}
