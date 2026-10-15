import { z } from 'zod';

const PosInt = z.number().int().positive();
const Range = z
  .tuple([z.number().positive(), z.number().positive()])
  .refine(([min, max]) => min <= max, 'range min must be <= max');

/** Creative tunables. Edit DEFAULT_PIPELINE; it is validated at module load. */
export const PipelineConfig = z.object({
  video: z.object({ width: PosInt, height: PosInt, fps: z.literal(30) }),
  timing: z.object({
    totalSec: z.number().positive(),
    hookBeatSec: Range,
    beatSec: Range,
    voWordsPerSec: z.number().positive(),
    voTailFrames: z.number().int().nonnegative(),
  }),
  hook: z.object({
    maxWords: PosInt,
    maxChars: PosInt,
    bannedOpeners: z.array(z.string().min(1)),
  }),
  plate: z.object({ width: PosInt.multipleOf(16), height: PosInt.multipleOf(16) }),
  broll: z.object({
    enabled: z.boolean(),
    maxPerVariant: z.number().int().nonnegative(),
    durationSec: z.number().positive(),
  }),
  shortlist: z.object({ formats: PosInt, hooks: PosInt, reserveExperimentalSlot: z.boolean() }),
  diversity: z.object({
    minHookFamilies: PosInt,
    minFormatFamilies: PosInt,
    repairPasses: z.number().int().nonnegative(),
  }),
  captions: z.object({ mode: z.enum(['proportional']) }),
  retries: z.object({ provider: z.number().int().nonnegative() }),
});
export type PipelineConfig = z.infer<typeof PipelineConfig>;

export const DEFAULT_PIPELINE: PipelineConfig = {
  video: { width: 1080, height: 1920, fps: 30 },
  timing: { totalSec: 20, hookBeatSec: [3, 4], beatSec: [5, 6], voWordsPerSec: 2.5, voTailFrames: 6 },
  hook: {
    maxWords: 9,
    maxChars: 28,
    bannedOpeners: ['Introducing', 'Meet', 'Are you tired of', 'In this video', 'Discover'],
  },
  plate: { width: 768, height: 1344 },
  broll: { enabled: true, maxPerVariant: 1, durationSec: 5 },
  shortlist: { formats: 8, hooks: 10, reserveExperimentalSlot: true },
  diversity: { minHookFamilies: 3, minFormatFamilies: 2, repairPasses: 1 },
  captions: { mode: 'proportional' },
  retries: { provider: 2 },
};

export const PIPELINE: PipelineConfig = PipelineConfig.parse(DEFAULT_PIPELINE);
