import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { brollWan22_5b } from '../workflows/broll-wan22-5b.params';
import { cutoutBirefnet } from '../workflows/cutout-birefnet.params';
import { plateFluxSchnell } from '../workflows/plate-flux-schnell.params';
import { nodeIdByTitle, patchWorkflow, type ApiWorkflow, type Patches } from './patch';

const Prompt = z.string().min(1);
const Seed = z.number().int().nonnegative();

/** Every workflow serving a role accepts that role's params, so swapping workflows is an env change. */
export const PlateParams = z.object({
  prompt: Prompt,
  seed: Seed,
  width: z.number().int().positive().multipleOf(16),
  height: z.number().int().positive().multipleOf(16),
});
export type PlateParams = z.infer<typeof PlateParams>;

/** `image` is the filename ComfyUI returned from /upload/image. */
export const CutoutParams = z.object({ image: z.string().min(1) });
export type CutoutParams = z.infer<typeof CutoutParams>;

export const BrollParams = z.object({
  prompt: Prompt,
  seed: Seed,
  image: z.string().min(1),
  width: z.number().int().positive().multipleOf(32),
  height: z.number().int().positive().multipleOf(32),
  length: z
    .number()
    .int()
    .min(5)
    .refine((n) => (n - 1) % 4 === 0, 'Wan frame count must be 4k+1'),
});
export type BrollParams = z.infer<typeof BrollParams>;

export interface Manifest<P> {
  /** Matches `workflows/<name>.json`. */
  name: string;
  output: { title: 'out:image' | 'out:video'; mime: 'image/png' | 'video/mp4' };
  /** Representative params: golden-file input and the boot-time title check. */
  sample: P;
  toPatches(p: P): Patches;
  /** Video only: output size and frame rate fixed by the workflow. */
  size?: { width: number; height: number };
  fps?: number;
}

export const PLATE_WORKFLOWS: Record<string, Manifest<PlateParams>> = {
  [plateFluxSchnell.name]: plateFluxSchnell,
};
export const CUTOUT_WORKFLOWS: Record<string, Manifest<CutoutParams>> = {
  [cutoutBirefnet.name]: cutoutBirefnet,
};
export const BROLL_WORKFLOWS: Record<string, Manifest<BrollParams>> = {
  [brollWan22_5b.name]: brollWan22_5b,
};

export function pickWorkflow<P>(table: Record<string, Manifest<P>>, name: string, role: string): Manifest<P> {
  const m = table[name];
  if (!m) throw new Error(`Unknown ${role} workflow "${name}". Known: ${Object.keys(table).join(', ')}`);
  return m;
}

export function loadWorkflow(name: string): { json: ApiWorkflow; sha256: string } {
  if (!/^[a-z0-9-]+$/.test(name)) throw new Error(`Invalid workflow name: ${name}`);
  // Hash LF-normalized text so CRLF and LF checkouts record the same workflow hash.
  const text = readFileSync(new URL(`../workflows/${name}.json`, import.meta.url), 'utf8').replaceAll('\r\n', '\n');
  return {
    json: JSON.parse(text) as ApiWorkflow,
    sha256: createHash('sha256').update(text).digest('hex'),
  };
}

/** Boot-time guard: the JSON must still carry every title the manifest patches, plus its output title. */
export function assertManifestMatches<P>(json: ApiWorkflow, m: Manifest<P>): void {
  patchWorkflow(json, m.toPatches(m.sample));
  nodeIdByTitle(json, m.output.title);
}
