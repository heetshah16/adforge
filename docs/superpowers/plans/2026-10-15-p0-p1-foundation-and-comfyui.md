# P0–P1: Foundation + ComfyUI Install — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A green pnpm/Turborepo monorepo with the core types, every configuration home from spec §5, a PGlite database with the seeded vocabulary registry, content-addressed local storage — plus a working local ComfyUI with three exported, title-tagged workflows ready for the P2 adapter.

**Architecture:** Source-only TypeScript workspace packages (no build step; Vitest, tsx and later Next.js consume `.ts` directly). `packages/core` owns types and config; `packages/db` owns Drizzle schema, PGlite client and seed; `packages/providers/local-storage` is the first `StorageProvider`. ComfyUI runs as a separate local service outside the repo.

**Tech Stack:** Node 24 · pnpm 12.11.2 · Turborepo 2.11.8 · TypeScript 7.0.2 · Zod 4.6.7 · Vitest 5.0.4 · tsx 4.23.15 · Drizzle ORM 0.45.4 + drizzle-kit 0.31.11 · PGlite 0.5.10 · ComfyUI portable (NVIDIA)

**Spec:** [docs/superpowers/specs/2026-10-15-adforge-local-poc-design.md](../specs/2026-10-15-adforge-local-poc-design.md) — read it, and [docs/architecture.md](../../architecture.md), before starting.

**Scope:** P0 and P1 only. P2–P8 each get their own plan, written after the vendor docs they depend on are fetched into `docs/providers/` (CLAUDE.md: never write an adapter from memory).

## Global Constraints

- Pin **exact** versions everywhere — no `^` or `~`. Versions live once, in the `catalog:` block of `pnpm-workspace.yaml`.
- TypeScript strict, `noUncheckedIndexedAccess` on.
- Provider SDK types never leave `packages/providers/<name>/`. Everything crossing a boundary is a `MediaRef` or another type from `packages/core/src/providers/types.ts`.
- `MediaRef.url` is always an internal URL (`${ADFORGE_PUBLIC_URL}/media/<key>`), never a vendor URL.
- All timing in frames; seconds→frames conversion happens only through `packages/core/src/spec/frames.ts`.
- Never set `temperature`, `top_p`, or `top_k` anywhere.
- Registry `slug` is the attribution key: never renamed, never reused, never deleted. Seeding never changes an existing row's `status`.
- Nothing tunable is hardcoded inside a pipeline step — it lives in env (`config/env.ts`), creative config (`config/pipeline.ts`), treatment config (`config/treatments.ts`), the DB registry, workflow files, or prompt files.
- `pnpm test` must pass before every commit.
- Commits use the repo's existing author if git has no identity configured: `git -c user.name=heetshah16 -c user.email=shahheet85@gmail.com commit ...`, and end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **Data dir inside OneDrive.** The repo lives under OneDrive; PGlite files and media written to `./.data` would be synced and file-locked mid-write. Expect a loud boot-check warning when `ADFORGE_DATA_DIR` resolves under a OneDrive folder, and `.env.example` pointing outside it. → Task 3 test.
2. **Empty env values.** A `.env` line like `COMFYUI_URL=` should mean "unset, use default", not "invalid URL". → Task 3 test.
3. **Same PGlite directory opened twice** (seed script while the dev server runs). PGlite is single-process; two writers corrupt it. Expect a clear "already open by pid N" error. → Task 4 test.
4. **Re-seeding after editing the seed file.** Regrouping a hook into another family must update its `familyId`; a row someone retired must stay retired. → Task 5 test.
5. **Storage key abuse and duplicate uploads.** `read('../../etc/x')` must be rejected; the same bytes uploaded twice must yield one file and one key. → Task 6 test.

---

## File Structure

```
adforge/
  package.json                       root scripts, packageManager pin
  pnpm-workspace.yaml                workspace globs + version catalog
  turbo.json                         test / typecheck tasks
  tsconfig.base.json                 shared strict compiler options
  .env.example                       every env var with its default
  packages/core/
    package.json, tsconfig.json
    src/spec/frames.ts               seconds→frames, drift-free layout
    src/providers/types.ts           MediaRef, Money, JobHandle, ProviderResult, ProviderError,
                                     Storage/Image/Cutout/Video provider interfaces
    src/providers/registry.ts        ProviderRegistry
    src/vocab/enums.ts               closed render-coupled enums
    src/config/env.ts                Zod env schema, parseEnv, dataDirWarnings
    src/config/boot-check.ts         CLI: load .env, validate, print warnings
    src/config/pipeline.ts           creative tunables, validated at load
    src/config/treatments.ts         per-visual_treatment render params
    test/*.test.ts
  packages/db/
    package.json, tsconfig.json, drizzle.config.ts
    src/schema.ts                    Drizzle tables
    src/client.ts                    openDb(): PGlite + migrate + single-process lock
    src/seed/vocabulary.ts           families + 7/8/7 seed data
    src/seed/seed.ts                 seedVocabulary, seedLocalUser
    src/seed/run.ts                  CLI
    drizzle/                         generated migrations (committed)
    test/*.test.ts
  packages/providers/local-storage/
    package.json, tsconfig.json
    src/index.ts                     LocalDiskStorage
    test/local-storage.test.ts
  packages/providers/comfyui/workflows/   (P1) exported API-format workflows
  packages/providers/comfyui/fixtures/    (P1) recorded /history responses
  docs/providers/comfyui.md               (P1) fetched API docs
  docs/decisions/0001..0006               ADRs
```

---

### Task 1: Monorepo scaffold + drift-free frame math

**Files:**
- Create: `package.json`, `pnpm-workspace.yaml`, `turbo.json`, `tsconfig.base.json`
- Create: `packages/core/package.json`, `packages/core/tsconfig.json`
- Create: `packages/core/src/spec/frames.ts`
- Test: `packages/core/test/frames.test.ts`
- Modify: `.gitignore` (append data dir)

**Interfaces:**
- Produces: `secondsToFrames(seconds: number, fps: number): number`; `layoutFrames(durationsSec: number[], fps: number): { startFrame: number; durationInFrames: number }[]`. Import path: `@adforge/core/spec/frames`.

- [ ] **Step 1: Install pnpm**

Run (PowerShell): `corepack enable; corepack prepare pnpm@12.11.2 --activate; pnpm -v`
Expected: `12.11.2`. If `corepack enable` fails with EPERM (Node in Program Files), run `npm i -g pnpm@12.11.2` instead and re-check `pnpm -v`.

- [ ] **Step 2: Write root workspace files**

`package.json`:
```json
{
  "name": "adforge",
  "private": true,
  "packageManager": "pnpm@12.11.2",
  "engines": { "node": ">=24" },
  "scripts": {
    "test": "turbo run test",
    "typecheck": "turbo run typecheck",
    "boot-check": "pnpm --filter @adforge/core boot-check",
    "db:generate": "pnpm --filter @adforge/db generate",
    "db:seed": "pnpm --filter @adforge/db seed"
  },
  "devDependencies": {
    "turbo": "catalog:",
    "typescript": "catalog:",
    "@types/node": "catalog:"
  }
}
```

`pnpm-workspace.yaml`:
```yaml
packages:
  - packages/*
  - packages/providers/*
  - apps/*

saveExact: true

# Every third-party version lives here, exact. Upgrades are deliberate PRs.
catalog:
  typescript: 7.0.2
  turbo: 2.11.8
  vitest: 5.0.4
  zod: 4.6.7
  tsx: 4.23.15
  "@types/node": 26.6.5
  drizzle-orm: 0.45.4
  drizzle-kit: 0.31.11
  "@electric-sql/pglite": 0.5.10
```

`turbo.json`:
```json
{
  "$schema": "https://turborepo.com/schema.json",
  "tasks": {
    "test": { "cache": false },
    "typecheck": {}
  }
}
```

`tsconfig.base.json`:
```json
{
  "compilerOptions": {
    "target": "es2023",
    "lib": ["es2023"],
    "module": "preserve",
    "moduleResolution": "bundler",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "verbatimModuleSyntax": true,
    "resolveJsonModule": true,
    "skipLibCheck": true,
    "noEmit": true,
    "types": ["node"]
  }
}
```

Append to `.gitignore`:
```
# --- local data (PGlite + media) --------------------------------------------
.data/
```

- [ ] **Step 3: Create the core package**

`packages/core/package.json`:
```json
{
  "name": "@adforge/core",
  "private": true,
  "type": "module",
  "exports": { "./*": "./src/*.ts" },
  "scripts": {
    "test": "vitest run",
    "typecheck": "tsc -p .",
    "boot-check": "tsx src/config/boot-check.ts"
  },
  "dependencies": { "zod": "catalog:" },
  "devDependencies": {
    "vitest": "catalog:",
    "tsx": "catalog:",
    "typescript": "catalog:",
    "@types/node": "catalog:"
  }
}
```

`packages/core/tsconfig.json`:
```json
{ "extends": "../../tsconfig.base.json", "include": ["src", "test"] }
```

Run: `pnpm install`
Expected: lockfile created, no errors.

- [ ] **Step 4: Write the failing test**

`packages/core/test/frames.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { layoutFrames, secondsToFrames } from '../src/spec/frames';

describe('secondsToFrames', () => {
  it('converts at 30fps', () => {
    expect(secondsToFrames(2, 30)).toBe(60);
    expect(secondsToFrames(0, 30)).toBe(0);
  });
  it('rejects negative and non-finite input', () => {
    expect(() => secondsToFrames(-1, 30)).toThrow(RangeError);
    expect(() => secondsToFrames(Number.NaN, 30)).toThrow(RangeError);
  });
});

describe('layoutFrames', () => {
  it('has no cumulative drift where per-segment rounding would add frames', () => {
    // 0.25s @30fps = 7.5 frames; rounding each segment alone gives 8×4 = 32, not 30.
    const out = layoutFrames([0.25, 0.25, 0.25, 0.25], 30);
    const total = out.reduce((n, s) => n + s.durationInFrames, 0);
    expect(total).toBe(30);
  });
  it('produces contiguous segments starting at 0', () => {
    const out = layoutFrames([3.5, 5.5, 5.5, 5.5], 30);
    expect(out[0]?.startFrame).toBe(0);
    for (let i = 1; i < out.length; i++) {
      const prev = out[i - 1]!;
      expect(out[i]!.startFrame).toBe(prev.startFrame + prev.durationInFrames);
    }
    expect(out.at(-1)!.startFrame + out.at(-1)!.durationInFrames).toBe(600);
  });
});
```

- [ ] **Step 5: Run test to verify it fails**

Run: `pnpm test`
Expected: FAIL — cannot resolve `../src/spec/frames`.

- [ ] **Step 6: Implement**

`packages/core/src/spec/frames.ts`:
```ts
/** The only place seconds become frames. Everything downstream is integer frames. */
export function secondsToFrames(seconds: number, fps: number): number {
  if (!Number.isFinite(seconds) || seconds < 0) {
    throw new RangeError(`seconds must be a finite non-negative number, got ${seconds}`);
  }
  return Math.round(seconds * fps);
}

/**
 * Lays out consecutive segments from cumulative time, so start frames are exact
 * rounded cumulative sums and the total never drifts from round(sum * fps).
 */
export function layoutFrames(
  durationsSec: number[],
  fps: number,
): { startFrame: number; durationInFrames: number }[] {
  let elapsedSec = 0;
  return durationsSec.map((d) => {
    const startFrame = secondsToFrames(elapsedSec, fps);
    elapsedSec += d;
    return { startFrame, durationInFrames: secondsToFrames(elapsedSec, fps) - startFrame };
  });
}
```

- [ ] **Step 7: Run tests and typecheck**

Run: `pnpm test; pnpm typecheck`
Expected: 4 tests PASS; typecheck clean. If `tsc` 7.0.2 errors on a compiler option rather than on code, change the catalog to `typescript: 5.9.3`, re-run `pnpm install`, and note it for ADR 0001.

- [ ] **Step 8: Commit**

```bash
git add package.json pnpm-workspace.yaml pnpm-lock.yaml turbo.json tsconfig.base.json .gitignore packages/core
git commit -m "feat(core): monorepo scaffold and drift-free frame layout"
```

---

### Task 2: Provider types and registry

**Files:**
- Create: `packages/core/src/providers/types.ts`
- Create: `packages/core/src/providers/registry.ts`
- Test: `packages/core/test/registry.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces (`@adforge/core/providers/types`): `MediaRef`, `Money`, `JobHandle`, `ProviderResult<T>`, `ProviderErrorCode`, `ProviderError`, `PutOptions`, `StorageProvider`, `ImageGenRequest`, `ImageProvider`, `CutoutRequest`, `CutoutProvider`, `VideoGenRequest`, `VideoCapabilities`, `VideoProvider`.
- Produces (`@adforge/core/providers/registry`): `ProviderKind = 'storage' | 'image' | 'cutout' | 'video'`; `class ProviderRegistry { register<K>(kind: K, impl: ProviderMap[K]): void; get<K>(kind: K, id: string): ProviderMap[K] }`.

- [ ] **Step 1: Write the types**

`packages/core/src/providers/types.ts`:
```ts
/** Everything that crosses a provider boundary. Vendor SDK types never appear here. */

export interface MediaRef {
  /** Storage key. Layers reference asset ids; storage resolves keys. */
  id: string;
  /** ALWAYS an internal URL (`${ADFORGE_PUBLIC_URL}/media/<key>`), never a vendor URL. */
  url: string;
  mime: string;
  sha256: string;
  bytes: number;
  width?: number;
  height?: number;
  durationSec?: number;
}

export interface Money {
  amountUsd: number;
  estimated: boolean;
}

export interface JobHandle {
  provider: string;
  externalId: string;
  pollAfterMs: number;
  /** Vendor payload, for debugging only. */
  raw?: unknown;
}

export type ProviderErrorCode =
  | 'AUTH'
  | 'RATE_LIMIT'
  | 'INVALID_INPUT'
  | 'CONTENT_POLICY'
  | 'TIMEOUT'
  | 'UPSTREAM'
  | 'UNKNOWN';

/** INVALID_INPUT is a bug in our adapter — it should have failed Zod validation locally. */
export class ProviderError extends Error {
  constructor(
    readonly provider: string,
    readonly code: ProviderErrorCode,
    message: string,
    readonly raw?: unknown,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}

export type ProviderResult<T> =
  | { status: 'pending'; handle: JobHandle }
  | { status: 'done'; value: T; cost: Money; latencyMs: number }
  | { status: 'failed'; error: ProviderError; retryable: boolean };

export interface PutOptions {
  mime: string;
  width?: number;
  height?: number;
  durationSec?: number;
}

export interface StorageProvider {
  readonly id: string;
  put(bytes: Uint8Array, opts: PutOptions): Promise<MediaRef>;
  read(key: string): Promise<Uint8Array>;
}

export interface ImageGenRequest {
  prompt: string;
  width: number;
  height: number;
  seed?: number;
  idempotencyKey: string;
}

export interface ImageProvider {
  readonly id: string;
  generate(req: ImageGenRequest): Promise<ProviderResult<MediaRef>>;
}

export interface CutoutRequest {
  image: MediaRef;
  idempotencyKey: string;
}

/** Returns an RGBA PNG of the subject with the background removed. */
export interface CutoutProvider {
  readonly id: string;
  cutout(req: CutoutRequest): Promise<ProviderResult<MediaRef>>;
}

export interface VideoGenRequest {
  mode: 'text_to_video' | 'image_to_video' | 'reference_to_video' | 'first_last_frame';
  prompt: string;
  images?: MediaRef[];
  firstFrame?: MediaRef;
  lastFrame?: MediaRef;
  durationSec: number;
  aspectRatio: '9:16' | '16:9' | '1:1';
  resolution: '480p' | '720p' | '1080p';
  seed?: number;
  idempotencyKey: string;
}

export interface VideoCapabilities {
  modes: VideoGenRequest['mode'][];
  maxDurationSec: number;
  resolutions: VideoGenRequest['resolution'][];
  typicalLatencyMs: number;
}

export interface VideoProvider {
  readonly id: string;
  readonly capabilities: VideoCapabilities;
  submit(req: VideoGenRequest): Promise<JobHandle>;
  poll(handle: JobHandle): Promise<ProviderResult<MediaRef>>;
}
```

- [ ] **Step 2: Write the failing registry test**

`packages/core/test/registry.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { ProviderRegistry } from '../src/providers/registry';
import type { StorageProvider } from '../src/providers/types';

const fake = (id: string): StorageProvider => ({
  id,
  put: async () => { throw new Error('unused'); },
  read: async () => new Uint8Array(),
});

describe('ProviderRegistry', () => {
  it('returns a registered provider by kind and id', () => {
    const r = new ProviderRegistry();
    const p = fake('local');
    r.register('storage', p);
    expect(r.get('storage', 'local')).toBe(p);
  });

  it('rejects duplicate registration', () => {
    const r = new ProviderRegistry();
    r.register('storage', fake('local'));
    expect(() => r.register('storage', fake('local'))).toThrow(/already registered/);
  });

  it('names the registered ids when an id is unknown', () => {
    const r = new ProviderRegistry();
    r.register('storage', fake('local'));
    r.register('storage', fake('r2'));
    expect(() => r.get('storage', 'gcs')).toThrow('No storage provider "gcs". Registered: local, r2');
  });

  it('reports an empty kind clearly', () => {
    expect(() => new ProviderRegistry().get('video', 'comfyui')).toThrow(
      'No video provider "comfyui". Registered: (none)',
    );
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm test`
Expected: FAIL — cannot resolve `../src/providers/registry`.

- [ ] **Step 4: Implement**

`packages/core/src/providers/registry.ts`:
```ts
import type { CutoutProvider, ImageProvider, StorageProvider, VideoProvider } from './types';

interface ProviderMap {
  storage: StorageProvider;
  image: ImageProvider;
  cutout: CutoutProvider;
  video: VideoProvider;
}
export type ProviderKind = keyof ProviderMap;

/** Providers register by id; env (`ADFORGE_PROVIDER_*`) chooses which id a pipeline uses. */
export class ProviderRegistry {
  readonly #byKind = new Map<ProviderKind, Map<string, ProviderMap[ProviderKind]>>();

  register<K extends ProviderKind>(kind: K, impl: ProviderMap[K]): void {
    const ids = this.#byKind.get(kind) ?? new Map();
    if (ids.has(impl.id)) throw new Error(`${kind} provider "${impl.id}" already registered`);
    ids.set(impl.id, impl);
    this.#byKind.set(kind, ids);
  }

  get<K extends ProviderKind>(kind: K, id: string): ProviderMap[K] {
    const ids = this.#byKind.get(kind);
    const impl = ids?.get(id);
    if (!impl) {
      const known = ids && ids.size > 0 ? [...ids.keys()].join(', ') : '(none)';
      throw new Error(`No ${kind} provider "${id}". Registered: ${known}`);
    }
    return impl as ProviderMap[K];
  }
}
```

- [ ] **Step 5: Run tests and typecheck**

Run: `pnpm test; pnpm typecheck`
Expected: all PASS, typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add packages/core
git commit -m "feat(core): provider boundary types and registry"
```

---

### Task 3: Configuration homes — env, pipeline, treatments, enums

**Files:**
- Create: `packages/core/src/vocab/enums.ts`
- Create: `packages/core/src/config/env.ts`
- Create: `packages/core/src/config/boot-check.ts`
- Create: `packages/core/src/config/pipeline.ts`
- Create: `packages/core/src/config/treatments.ts`
- Create: `.env.example`
- Test: `packages/core/test/env.test.ts`, `packages/core/test/pipeline.test.ts`, `packages/core/test/treatments.test.ts`

**Interfaces:**
- Produces (`@adforge/core/vocab/enums`): Zod enums + types `VisualTreatment`, `Motion`, `ProductProminence`.
- Produces (`@adforge/core/config/env`): `Env` (Zod schema), `type Env`, `parseEnv(raw: Record<string, string | undefined>): Env` (throws `Error` whose message starts `Invalid environment:`), `dataDirWarnings(dataDir: string): string[]`.
- Produces (`@adforge/core/config/pipeline`): `PipelineConfig` (schema + type), `DEFAULT_PIPELINE`, `PIPELINE`.
- Produces (`@adforge/core/config/treatments`): `TreatmentConfig`, `TREATMENTS: Record<VisualTreatment, TreatmentConfig>`.

- [ ] **Step 1: Write the enums**

`packages/core/src/vocab/enums.ts`:
```ts
import { z } from 'zod';

/**
 * Render-coupled dimensions: closed by design. Every value needs renderer code
 * and a TREATMENTS entry, so adding one is a PR, not a data change (architecture §5.1).
 */
export const VisualTreatment = z.enum([
  'clean_studio',
  'lifestyle_context',
  'macro_texture',
  'hand_held_ugc',
  'flat_lay',
  'split_compare',
]);
export type VisualTreatment = z.infer<typeof VisualTreatment>;

export const Motion = z.enum(['slow_zoom_in', 'slow_zoom_out', 'slow_pan', 'subtle_shake', 'static']);
export type Motion = z.infer<typeof Motion>;

/** Drives fidelityTier in code: hero|supporting → T0 cutout overlay; absent → T2. */
export const ProductProminence = z.enum(['hero', 'supporting', 'absent']);
export type ProductProminence = z.infer<typeof ProductProminence>;
```

- [ ] **Step 2: Write failing env tests**

`packages/core/test/env.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { dataDirWarnings, parseEnv } from '../src/config/env';

describe('parseEnv', () => {
  it('applies defaults to an empty environment', () => {
    const env = parseEnv({});
    expect(env.COMFYUI_URL).toBe('http://127.0.0.1:8188');
    expect(env.ADFORGE_PROVIDER_IMAGE).toBe('comfyui');
    expect(env.ADFORGE_COMFY_WORKFLOW_PLATE).toBe('plate-flux-schnell');
    expect(env.ADFORGE_LLM_EFFORT_DIRECTOR).toBe('high');
  });

  it('treats empty strings as unset', () => {
    expect(parseEnv({ COMFYUI_URL: '' }).COMFYUI_URL).toBe('http://127.0.0.1:8188');
  });

  it('fails on an unknown provider id, naming the variable', () => {
    expect(() => parseEnv({ ADFORGE_PROVIDER_IMAGE: 'fal' })).toThrow(/ADFORGE_PROVIDER_IMAGE/);
  });

  it('fails on a malformed URL', () => {
    expect(() => parseEnv({ COMFYUI_URL: 'localhost:8188' })).toThrow(/COMFYUI_URL/);
  });

  it('fails on a malformed LLM model id', () => {
    expect(() => parseEnv({ ADFORGE_LLM_DIRECTOR: 'claude opus' })).toThrow(/ADFORGE_LLM_DIRECTOR/);
    expect(parseEnv({ ADFORGE_LLM_DIRECTOR: 'anthropic/claude-opus-5' }).ADFORGE_LLM_DIRECTOR).toBe(
      'anthropic/claude-opus-5',
    );
  });
});

describe('dataDirWarnings', () => {
  it('warns when the data dir is inside OneDrive', () => {
    expect(dataDirWarnings('C:\\Users\\a\\OneDrive\\Desktop\\adforge\\.data')).toHaveLength(1);
  });
  it('is silent outside OneDrive', () => {
    expect(dataDirWarnings('C:\\adforge-data')).toEqual([]);
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `pnpm test`
Expected: FAIL — cannot resolve `../src/config/env`.

- [ ] **Step 4: Implement env**

`packages/core/src/config/env.ts`:
```ts
import { resolve } from 'node:path';
import { z } from 'zod';

const Effort = z.enum(['low', 'medium', 'high', 'xhigh', 'max']);
const WorkflowName = z.string().regex(/^[a-z0-9-]+$/, 'lowercase letters, digits and dashes only');
const OpenRouterModel = z.string().regex(/^[a-z0-9-]+\/[a-z0-9.:-]+$/, 'expected "vendor/model"');

/**
 * Infrastructure and provider choice. Provider ids are closed lists of what is
 * actually registered — adding a provider adds its id here.
 * LLM vars become required in P5.
 */
export const Env = z.object({
  ADFORGE_DATA_DIR: z.string().min(1).default('.data'),
  ADFORGE_PUBLIC_URL: z.url().default('http://localhost:3000'),

  ADFORGE_PROVIDER_STORAGE: z.enum(['local']).default('local'),
  ADFORGE_PROVIDER_IMAGE: z.enum(['comfyui']).default('comfyui'),
  ADFORGE_PROVIDER_CUTOUT: z.enum(['comfyui']).default('comfyui'),
  ADFORGE_PROVIDER_VIDEO: z.enum(['comfyui']).default('comfyui'),
  ADFORGE_PROVIDER_TTS: z.enum(['kokoro']).default('kokoro'),

  COMFYUI_URL: z.url().default('http://127.0.0.1:8188'),
  ADFORGE_COMFY_WORKFLOW_PLATE: WorkflowName.default('plate-flux-schnell'),
  ADFORGE_COMFY_WORKFLOW_BROLL: WorkflowName.default('broll-wan22-5b'),
  ADFORGE_COMFY_WORKFLOW_CUTOUT: WorkflowName.default('cutout-birefnet'),

  ADFORGE_TTS_VOICE: z.string().min(1).default('af_heart'),

  OPENROUTER_API_KEY: z.string().min(1).optional(),
  ADFORGE_LLM_STRATEGIST: OpenRouterModel.optional(),
  ADFORGE_LLM_DIRECTOR: OpenRouterModel.optional(),
  ADFORGE_LLM_EFFORT_STRATEGIST: Effort.default('medium'),
  ADFORGE_LLM_EFFORT_DIRECTOR: Effort.default('high'),
});
export type Env = z.infer<typeof Env>;

/** `FOO=` in a .env file means "unset", not "empty string". */
export function parseEnv(raw: Record<string, string | undefined>): Env {
  const cleaned = Object.fromEntries(Object.entries(raw).filter(([, v]) => v !== undefined && v !== ''));
  const result = Env.safeParse(cleaned);
  if (!result.success) throw new Error(`Invalid environment:\n${z.prettifyError(result.error)}`);
  return result.data;
}

/** PGlite files and media must not live where OneDrive syncs and locks them. */
export function dataDirWarnings(dataDir: string): string[] {
  const abs = resolve(dataDir);
  return /[\\/]onedrive[\\/ -]/i.test(`${abs}\\`)
    ? [`ADFORGE_DATA_DIR (${abs}) is inside OneDrive — sync will lock PGlite and media files. Use e.g. C:\\adforge-data.`]
    : [];
}
```

- [ ] **Step 5: Implement boot-check and .env.example**

`packages/core/src/config/boot-check.ts`:
```ts
import { dataDirWarnings, parseEnv } from './env';

const envFile = new URL('../../../../.env', import.meta.url);
try {
  process.loadEnvFile(envFile);
} catch (e) {
  if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
}

try {
  const env = parseEnv(process.env);
  for (const w of dataDirWarnings(env.ADFORGE_DATA_DIR)) console.warn(`WARN ${w}`);
  console.log('env ok');
} catch (e) {
  console.error((e as Error).message);
  process.exit(1);
}
```

`.env.example`:
```bash
# Copy to .env. Empty values mean "use the default".

# Keep data OUTSIDE OneDrive — sync locks PGlite and media files.
ADFORGE_DATA_DIR=C:/adforge-data
ADFORGE_PUBLIC_URL=http://localhost:3000

# Provider ids (must be registered)
ADFORGE_PROVIDER_STORAGE=local
ADFORGE_PROVIDER_IMAGE=comfyui
ADFORGE_PROVIDER_CUTOUT=comfyui
ADFORGE_PROVIDER_VIDEO=comfyui
ADFORGE_PROVIDER_TTS=kokoro

# ComfyUI
COMFYUI_URL=http://127.0.0.1:8188
ADFORGE_COMFY_WORKFLOW_PLATE=plate-flux-schnell
ADFORGE_COMFY_WORKFLOW_BROLL=broll-wan22-5b
ADFORGE_COMFY_WORKFLOW_CUTOUT=cutout-birefnet

# TTS
ADFORGE_TTS_VOICE=af_heart

# LLM via OpenRouter (required from P5). Verify slugs at openrouter.ai/models.
OPENROUTER_API_KEY=
ADFORGE_LLM_STRATEGIST=
ADFORGE_LLM_DIRECTOR=
ADFORGE_LLM_EFFORT_STRATEGIST=medium
ADFORGE_LLM_EFFORT_DIRECTOR=high
```

- [ ] **Step 6: Run env tests**

Run: `pnpm test`
Expected: env tests PASS.

- [ ] **Step 7: Write failing pipeline + treatments tests**

`packages/core/test/pipeline.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { DEFAULT_PIPELINE, PIPELINE, PipelineConfig } from '../src/config/pipeline';

describe('pipeline config', () => {
  it('defaults are valid and loaded', () => {
    expect(PIPELINE.video).toEqual({ width: 1080, height: 1920, fps: 30 });
    expect(PIPELINE.diversity.minHookFamilies).toBe(3);
  });

  it('rejects an inverted range', () => {
    const bad = { ...DEFAULT_PIPELINE, timing: { ...DEFAULT_PIPELINE.timing, beatSec: [6, 5] } };
    expect(PipelineConfig.safeParse(bad).success).toBe(false);
  });

  it('rejects plate sizes that are not multiples of 16', () => {
    const bad = { ...DEFAULT_PIPELINE, plate: { width: 770, height: 1344 } };
    expect(PipelineConfig.safeParse(bad).success).toBe(false);
  });
});
```

`packages/core/test/treatments.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { TREATMENTS } from '../src/config/treatments';
import { Motion, VisualTreatment } from '../src/vocab/enums';

describe('treatments', () => {
  it('has an entry for every visual treatment and nothing else', () => {
    expect(Object.keys(TREATMENTS).sort()).toEqual([...VisualTreatment.options].sort());
  });
  it('uses only known motions and non-empty plate suffixes', () => {
    for (const t of Object.values(TREATMENTS)) {
      expect(Motion.options).toContain(t.defaultMotion);
      expect(t.platePromptSuffix.length).toBeGreaterThan(20);
    }
  });
});
```

- [ ] **Step 8: Run to verify failure**

Run: `pnpm test`
Expected: FAIL — cannot resolve `../src/config/pipeline` / `../src/config/treatments`.

- [ ] **Step 9: Implement pipeline config**

`packages/core/src/config/pipeline.ts`:
```ts
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
```

- [ ] **Step 10: Implement treatments**

`packages/core/src/config/treatments.ts`:
```ts
import type { Motion, VisualTreatment } from '../vocab/enums';

export interface TreatmentConfig {
  captionPosition: 'bottom_center' | 'mid_lower' | 'top_third';
  captionWeight: 'regular' | 'bold' | 'chunky';
  scrim: boolean;
  defaultMotion: Motion;
  /** Appended to every plate prompt for this treatment. Plates never contain the product. */
  platePromptSuffix: string;
}

/** Build spec §3 Axis 3 mapping. `satisfies` makes a missing treatment a compile error. */
export const TREATMENTS = {
  clean_studio: {
    captionPosition: 'bottom_center',
    captionWeight: 'regular',
    scrim: false,
    defaultMotion: 'slow_zoom_in',
    platePromptSuffix:
      'seamless soft light-grey studio backdrop, gentle gradient, softbox lighting, minimal commercial product photography, empty centre foreground',
  },
  lifestyle_context: {
    captionPosition: 'bottom_center',
    captionWeight: 'regular',
    scrim: true,
    defaultMotion: 'slow_pan',
    platePromptSuffix:
      'warm natural daylight, real lived-in interior, shallow depth of field, candid editorial photography, empty surface in the foreground',
  },
  macro_texture: {
    captionPosition: 'bottom_center',
    captionWeight: 'bold',
    scrim: true,
    defaultMotion: 'slow_zoom_in',
    platePromptSuffix:
      'extreme macro detail, tactile surface texture, dramatic raking light, very shallow depth of field',
  },
  hand_held_ugc: {
    captionPosition: 'mid_lower',
    captionWeight: 'chunky',
    scrim: false,
    defaultMotion: 'subtle_shake',
    platePromptSuffix:
      'smartphone photo look, casual everyday setting, natural window light, slightly imperfect framing',
  },
  flat_lay: {
    captionPosition: 'top_third',
    captionWeight: 'regular',
    scrim: false,
    defaultMotion: 'slow_zoom_out',
    platePromptSuffix:
      'top-down flat lay on a textured surface, styled props arranged at the edges, soft even light, empty centre',
  },
  split_compare: {
    captionPosition: 'top_third',
    captionWeight: 'bold',
    scrim: false,
    defaultMotion: 'static',
    platePromptSuffix: 'clean dark backdrop, dramatic rim light, strong contrast, empty centre',
  },
} satisfies Record<VisualTreatment, TreatmentConfig>;
```

- [ ] **Step 11: Run all checks, including boot-check**

Run: `pnpm test; pnpm typecheck; pnpm boot-check`
Expected: tests PASS; typecheck clean; boot-check prints `WARN ADFORGE_DATA_DIR (...\OneDrive\...\.data) is inside OneDrive...` then `env ok` (no `.env` yet, so the default `.data` resolves under the repo).
Then: `$env:ADFORGE_PROVIDER_IMAGE='fal'; pnpm boot-check; Remove-Item Env:ADFORGE_PROVIDER_IMAGE`
Expected: exit code 1, message contains `ADFORGE_PROVIDER_IMAGE`.

- [ ] **Step 12: Commit**

```bash
git add packages/core .env.example
git commit -m "feat(core): env, pipeline and treatment config homes with boot check"
```

---

### Task 4: Database — schema, PGlite client, single-process lock

**Files:**
- Create: `packages/db/package.json`, `packages/db/tsconfig.json`, `packages/db/drizzle.config.ts`
- Create: `packages/db/src/schema.ts`, `packages/db/src/client.ts`
- Create: `packages/db/drizzle/` (generated)
- Create: `docs/decisions/0006-job-config-snapshot.md`
- Test: `packages/db/test/client.test.ts`

**Interfaces:**
- Produces (`@adforge/db/schema`): tables `users`, `projects`, `assets`, `vocabFamilies`, `archetypes`, `formats`, `hookArchetypes`, `jobs`, `variants`, `providerCalls`; pg enums `vocabKind`, `vocabStatus`, `jobStatus`, `variantStatus`, `callStatus`.
- Produces (`@adforge/db/client`): `openDb(dataDir?: string): Promise<{ db: Db; close(): Promise<void> }>` — `undefined` = in-memory, no lock; `type Db`.

- [ ] **Step 1: Create the package**

`packages/db/package.json`:
```json
{
  "name": "@adforge/db",
  "private": true,
  "type": "module",
  "exports": { "./*": "./src/*.ts" },
  "scripts": {
    "test": "vitest run",
    "typecheck": "tsc -p .",
    "generate": "drizzle-kit generate",
    "seed": "tsx src/seed/run.ts"
  },
  "dependencies": {
    "@adforge/core": "workspace:*",
    "@electric-sql/pglite": "catalog:",
    "drizzle-orm": "catalog:"
  },
  "devDependencies": {
    "drizzle-kit": "catalog:",
    "vitest": "catalog:",
    "tsx": "catalog:",
    "typescript": "catalog:",
    "@types/node": "catalog:"
  }
}
```

`packages/db/tsconfig.json`:
```json
{ "extends": "../../tsconfig.base.json", "include": ["src", "test", "drizzle.config.ts"] }
```

`packages/db/drizzle.config.ts`:
```ts
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema.ts',
  out: './drizzle',
  casing: 'snake_case',
});
```

Run: `pnpm install`

- [ ] **Step 2: Write the schema**

`packages/db/src/schema.ts`:
```ts
import {
  boolean,
  doublePrecision,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

const id = () => uuid().primaryKey().defaultRandom();
const createdAt = () => timestamp({ withTimezone: true }).notNull().defaultNow();

export const vocabKind = pgEnum('vocab_kind', ['archetype', 'format', 'hook']);
export const vocabStatus = pgEnum('vocab_status', ['proposed', 'experimental', 'active', 'retired']);
export const jobStatus = pgEnum('job_status', ['queued', 'running', 'completed', 'failed']);
export const variantStatus = pgEnum('variant_status', ['pending', 'running', 'completed', 'failed']);
export const callStatus = pgEnum('call_status', ['pending', 'done', 'failed']);

export const users = pgTable('users', {
  id: id(),
  email: text().notNull().unique(),
  createdAt: createdAt(),
});

export const projects = pgTable('projects', {
  id: id(),
  userId: uuid().notNull().references(() => users.id),
  name: text().notNull(),
  brandKit: jsonb().notNull().default({}),
  createdAt: createdAt(),
});

export const assets = pgTable(
  'assets',
  {
    id: id(),
    projectId: uuid().notNull().references(() => projects.id),
    kind: text().notNull(), // upload | cutout | plate | broll | voice | render
    storageKey: text().notNull(),
    mime: text().notNull(),
    width: integer(),
    height: integer(),
    durationSec: doublePrecision(),
    bytes: integer().notNull(),
    sha256: text().notNull(),
    sourceUrl: text(),
    createdAt: createdAt(),
  },
  (t) => [unique().on(t.projectId, t.sha256)],
);

// --- the adaptive vocabulary (architecture §5.1) ----------------------------
// Slugs are the attribution key: never renamed, never reused, never deleted.

export const vocabFamilies = pgTable('vocab_families', {
  id: id(),
  kind: vocabKind().notNull(),
  slug: text().notNull().unique(),
  name: text().notNull(),
});

export const archetypes = pgTable('archetypes', {
  id: id(),
  slug: text().notNull().unique(),
  familyId: uuid().references(() => vocabFamilies.id),
  name: text().notNull(),
  buyingDriver: text().notNull(),
  definition: text().notNull(),
  examples: jsonb().$type<string[]>().notNull().default([]),
  status: vocabStatus().notNull().default('proposed'),
  createdAt: createdAt(),
  retiredAt: timestamp({ withTimezone: true }),
});

/** fitsArchetypes = [] means "fits any archetype". */
export const formats = pgTable('formats', {
  id: id(),
  slug: text().notNull().unique(),
  familyId: uuid().notNull().references(() => vocabFamilies.id),
  name: text().notNull(),
  beats: jsonb().$type<string[]>().notNull(),
  fitsArchetypes: text().array().notNull().default([]),
  definition: text().notNull(),
  status: vocabStatus().notNull().default('proposed'),
  createdAt: createdAt(),
  retiredAt: timestamp({ withTimezone: true }),
});

export const hookArchetypes = pgTable('hook_archetypes', {
  id: id(),
  slug: text().notNull().unique(),
  familyId: uuid().notNull().references(() => vocabFamilies.id),
  name: text().notNull(),
  shape: text().notNull(),
  skeleton: text().notNull(),
  constraints: jsonb().$type<string[]>().notNull().default([]),
  fitsArchetypes: text().array().notNull().default([]),
  status: vocabStatus().notNull().default('proposed'),
  createdAt: createdAt(),
  retiredAt: timestamp({ withTimezone: true }),
});

// --- jobs --------------------------------------------------------------------

export const jobs = pgTable('jobs', {
  id: id(),
  projectId: uuid().notNull().references(() => projects.id),
  userId: uuid().notNull().references(() => users.id),
  status: jobStatus().notNull().default('queued'),
  inputSpec: jsonb().notNull(),
  brief: jsonb(),
  shortlist: jsonb(),
  /** Resolved config, treatment params, workflow names, model ids and prompt hashes this job ran with. */
  configSnapshot: jsonb(),
  costUsd: doublePrecision().notNull().default(0),
  error: jsonb(),
  createdAt: createdAt(),
  completedAt: timestamp({ withTimezone: true }),
});

/** Slugs, not foreign keys — a retired registry row can never orphan a historical variant. */
export const variants = pgTable(
  'variants',
  {
    id: id(),
    jobId: uuid().notNull().references(() => jobs.id),
    variantNo: integer().notNull(),
    formatSlug: text().notNull(),
    hookSlug: text().notNull(),
    archetypeSlug: text().notNull(),
    visualTreatment: text().notNull(),
    strategicBet: text().notNull(),
    isExploratory: boolean().notNull().default(false),
    direction: jsonb(),
    spec: jsonb(),
    status: variantStatus().notNull().default('pending'),
    renderAssetId: uuid().references(() => assets.id),
    costUsd: doublePrecision().notNull().default(0),
    error: jsonb(),
    createdAt: createdAt(),
  },
  (t) => [unique().on(t.jobId, t.variantNo)],
);

export const providerCalls = pgTable('provider_calls', {
  id: id(),
  jobId: uuid().references(() => jobs.id),
  variantId: uuid().references(() => variants.id),
  kind: text().notNull(),
  provider: text().notNull(),
  model: text(),
  requestHash: text().notNull(),
  /** Double-fire guard. */
  idempotencyKey: text().notNull().unique(),
  latencyMs: integer(),
  costUsd: doublePrecision().notNull().default(0),
  status: callStatus().notNull().default('pending'),
  error: jsonb(),
  createdAt: createdAt(),
});
```

- [ ] **Step 3: Generate the migration**

Run: `pnpm db:generate`
Expected: `packages/db/drizzle/0000_<name>.sql` and `packages/db/drizzle/meta/` created. Open the SQL and confirm snake_case columns (`idempotency_key`), the `UNIQUE` on it, and `text[]` for `fits_archetypes`.

- [ ] **Step 4: Write the failing client test**

`packages/db/test/client.test.ts`:
```ts
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDb } from '../src/client';
import { jobs, projects, providerCalls, users } from '../src/schema';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function seedJob() {
  const { db, close } = await openDb();
  const [u] = await db.insert(users).values({ email: 't@x.dev' }).returning();
  const [p] = await db.insert(projects).values({ userId: u!.id, name: 'p' }).returning();
  const [j] = await db.insert(jobs).values({ projectId: p!.id, userId: u!.id, inputSpec: {} }).returning();
  return { db, close, jobId: j!.id };
}

describe('openDb', () => {
  it('migrates an in-memory database', async () => {
    const { db, close, jobId } = await seedJob();
    const rows = await db.select().from(jobs);
    expect(rows[0]?.id).toBe(jobId);
    expect(rows[0]?.status).toBe('queued');
    await close();
  });

  it('enforces the provider_calls idempotency key', async () => {
    const { db, close, jobId } = await seedJob();
    const call = { jobId, kind: 'image', provider: 'comfyui', requestHash: 'h', idempotencyKey: 'k1' };
    await db.insert(providerCalls).values(call);
    await expect(db.insert(providerCalls).values(call)).rejects.toThrow();
    await close();
  });

  it('refuses to open the same data dir twice', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'adforge-db-'));
    dirs.push(dir);
    const first = await openDb(dir);
    await expect(openDb(dir)).rejects.toThrow(/already open by pid/);
    await first.close();
    const again = await openDb(dir); // lock released on close
    await again.close();
  });
});
```

- [ ] **Step 5: Run to verify failure**

Run: `pnpm test`
Expected: FAIL — cannot resolve `../src/client`.

- [ ] **Step 6: Implement the client**

`packages/db/src/client.ts`:
```ts
import { mkdirSync, openSync, readFileSync, rmSync, writeSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import * as schema from './schema';

const MIGRATIONS = fileURLToPath(new URL('../drizzle', import.meta.url));

function makeDb(client: PGlite) {
  return drizzle({ client, schema, casing: 'snake_case' });
}
export type Db = ReturnType<typeof makeDb>;

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * PGlite is single-process: two writers on one directory corrupt it.
 * ponytail: pid lockfile, not an OS lock — a reused pid can block until the file is deleted by hand.
 */
function acquireLock(dataDir: string): () => void {
  mkdirSync(dataDir, { recursive: true });
  const lockPath = join(dataDir, '.adforge.lock');
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(lockPath, 'wx');
      writeSync(fd, String(process.pid));
      closeSync(fd);
      return () => rmSync(lockPath, { force: true });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      const pid = Number(readFileSync(lockPath, 'utf8'));
      if (Number.isInteger(pid) && isAlive(pid)) {
        throw new Error(`Database ${dataDir} is already open by pid ${pid}. Stop that process first.`);
      }
      rmSync(lockPath, { force: true }); // stale lock from a dead process
    }
  }
  throw new Error(`Could not acquire lock on ${dataDir}`);
}

/** `dataDir` undefined = in-memory (tests). Applies all migrations before returning. */
export async function openDb(dataDir?: string): Promise<{ db: Db; close(): Promise<void> }> {
  const release = dataDir ? acquireLock(dataDir) : () => {};
  try {
    const client = new PGlite(dataDir ? join(dataDir, 'pg') : undefined);
    const db = makeDb(client);
    await migrate(db, { migrationsFolder: MIGRATIONS });
    return {
      db,
      async close() {
        await client.close();
        release();
      },
    };
  } catch (e) {
    release();
    throw e;
  }
}
```

- [ ] **Step 7: Run tests and typecheck**

Run: `pnpm test; pnpm typecheck`
Expected: all PASS.

- [ ] **Step 8: Write ADR 0006**

`docs/decisions/0006-job-config-snapshot.md`:
```markdown
# 0006 — Snapshot resolved config onto every job

**Status:** accepted · 2026-10-15

## Context
The POC makes every tunable changeable (env, `pipeline.ts`, `treatments.ts`, workflow files, prompt files). Without a record of what a job ran with, an old output can't be explained or compared — the same reason `jobs.shortlist` exists.

## Decision
`jobs.configSnapshot` (jsonb) stores, at preflight: the parsed `PIPELINE`, `TREATMENTS`, selected provider ids, ComfyUI workflow names + file SHA-256s, LLM model ids + effort, and prompt file SHA-256s. Secrets are never included.

## Consequences
Before/after comparisons across a config change are a query, not archaeology. Snapshots are a few KB per job.
```

- [ ] **Step 9: Commit**

```bash
git add packages/db docs/decisions/0006-job-config-snapshot.md pnpm-lock.yaml
git commit -m "feat(db): drizzle schema, PGlite client with single-process lock"
```

---

### Task 5: Vocabulary registry seed

**Files:**
- Create: `packages/db/src/seed/vocabulary.ts`
- Create: `packages/db/src/seed/seed.ts`
- Create: `packages/db/src/seed/run.ts`
- Create: `docs/decisions/0005-seeded-vocab-families.md`
- Test: `packages/db/test/seed.test.ts`

**Interfaces:**
- Consumes: `openDb`, `Db` (Task 4); schema tables (Task 4); `parseEnv`, `dataDirWarnings` (Task 3).
- Produces (`@adforge/db/seed/vocabulary`): `type VocabSeed = { families; archetypes; formats; hooks }`, `VOCAB: VocabSeed`.
- Produces (`@adforge/db/seed/seed`): `seedVocabulary(db: Db, vocab?: VocabSeed): Promise<void>`; `seedLocalUser(db: Db): Promise<{ userId: string; projectId: string }>`.

- [ ] **Step 1: Write the seed data**

`packages/db/src/seed/vocabulary.ts`:
```ts
/**
 * Source: docs/adforge-build-spec.md §3–4. Edit this file and run `pnpm db:seed` to
 * regroup families or add entries. Never rename or delete a slug — retire it instead.
 */

export interface VocabSeed {
  families: { kind: 'archetype' | 'format' | 'hook'; slug: string; name: string }[];
  archetypes: { slug: string; name: string; buyingDriver: string; definition: string; examples: string[] }[];
  formats: {
    slug: string;
    family: string;
    name: string;
    beats: string[];
    fitsArchetypes: string[];
    definition: string;
  }[];
  hooks: {
    slug: string;
    family: string;
    name: string;
    shape: string;
    skeleton: string;
    fitsArchetypes: string[];
  }[];
}

export const VOCAB: VocabSeed = {
  families: [
    { kind: 'hook', slug: 'contrarian', name: 'Contrarian' },
    { kind: 'hook', slug: 'targeting', name: 'Targeting' },
    { kind: 'hook', slug: 'evidence', name: 'Evidence' },
    { kind: 'hook', slug: 'tension', name: 'Tension' },
    { kind: 'format', slug: 'narrative_arc', name: 'Narrative arc' },
    { kind: 'format', slug: 'social_proof', name: 'Social proof' },
    { kind: 'format', slug: 'rational', name: 'Rational' },
    { kind: 'format', slug: 'sensory', name: 'Sensory' },
    { kind: 'format', slug: 'persuasion', name: 'Persuasion' },
  ],
  archetypes: [
    { slug: 'remedy', name: 'Remedy', buyingDriver: 'Solves a felt pain', definition: 'Bought to make a felt problem go away.', examples: ['skincare', 'cleaning', 'pain relief', 'health foods'] },
    { slug: 'upgrade', name: 'Upgrade', buyingDriver: 'Better version of something owned', definition: 'Bought to replace something the buyer already has with a better one.', examples: ['gadgets', 'cookware', 'tools', 'luggage'] },
    { slug: 'indulgence', name: 'Indulgence', buyingDriver: 'Sensory or emotional want', definition: 'Bought for pleasure rather than need.', examples: ['snacks', 'beverages', 'fragrance', 'dessert'] },
    { slug: 'identity', name: 'Identity', buyingDriver: 'Signals who the buyer is', definition: 'Bought for what owning it says about the buyer.', examples: ['apparel', 'jewellery', 'sneakers', 'decor'] },
    { slug: 'utility', name: 'Utility', buyingDriver: 'Rational time/money saving', definition: 'Bought on a rational calculation of time or money saved.', examples: ['services', 'SaaS', 'storage', 'stationery'] },
    { slug: 'gifting', name: 'Gifting', buyingDriver: 'Bought for someone else', definition: 'Bought to be given; the recipient’s reaction is the payoff.', examples: ['hampers', 'toys', 'occasion items'] },
    { slug: 'trust', name: 'Trust', buyingDriver: 'High-consideration, risk-reducing', definition: 'Bought only once the buyer believes the risk is low.', examples: ['baby products', 'health devices', "kids' food"] },
  ],
  formats: [
    { slug: 'problem_solution', family: 'narrative_arc', name: 'Problem → solution', beats: ['pain', 'agitate', 'reveal', 'relief'], fitsArchetypes: ['remedy', 'utility', 'trust'], definition: 'Name a pain, make it worse, reveal the product, show relief.' },
    { slug: 'ugc_testimonial', family: 'social_proof', name: 'UGC testimonial', beats: ['to-camera hook', 'skepticism', 'try', 'verdict'], fitsArchetypes: ['remedy', 'trust', 'indulgence'], definition: 'A real-seeming person doubts, tries, and gives a verdict.' },
    { slug: 'before_after', family: 'narrative_arc', name: 'Before / after', beats: ['state A', 'trigger', 'state B', 'proof'], fitsArchetypes: ['remedy', 'upgrade'], definition: 'Show the state before, the product as trigger, the state after, then proof.' },
    { slug: 'spec_flex', family: 'rational', name: 'Spec flex', beats: ['claim', 'demo', 'comparison', 'price anchor'], fitsArchetypes: ['upgrade', 'utility'], definition: 'Lead with a hard claim, demonstrate it, compare, anchor the price.' },
    { slug: 'sensory_tease', family: 'sensory', name: 'Sensory tease', beats: ['extreme close-up', 'texture', 'reaction', 'want'], fitsArchetypes: ['indulgence'], definition: 'Sell the sensation through close-ups and a reaction.' },
    { slug: 'styling_moment', family: 'sensory', name: 'Styling moment', beats: ['context', 'product enters', 'transformation', 'look'], fitsArchetypes: ['identity', 'gifting'], definition: 'The product enters a scene and transforms the look.' },
    { slug: 'objection_kill', family: 'persuasion', name: 'Objection kill', beats: ['state doubt', 'escalate', 'counter-proof', 'CTA'], fitsArchetypes: ['trust', 'utility'], definition: 'Voice the buyer’s doubt, then dismantle it with proof.' },
    { slug: 'listicle_3', family: 'rational', name: 'Listicle (3 reasons)', beats: ['"3 reasons"', 'reason', 'reason', 'winner'], fitsArchetypes: [], definition: 'Three reasons, the last one the strongest. Fallback for any archetype.' },
  ],
  hooks: [
    { slug: 'pattern_break', family: 'contrarian', name: 'Pattern break', shape: 'Contradicts expectation', skeleton: 'Stop buying [obvious thing].', fitsArchetypes: [] },
    { slug: 'direct_call', family: 'targeting', name: 'Direct call', shape: 'Names the viewer', skeleton: 'If you [trait], watch this.', fitsArchetypes: [] },
    { slug: 'stat_shock', family: 'evidence', name: 'Stat shock', shape: "Number that doesn't fit intuition", skeleton: '[N]% of [X] contains [Y].', fitsArchetypes: [] },
    { slug: 'confession', family: 'contrarian', name: 'Confession', shape: 'Admits something', skeleton: 'I was wrong about [category].', fitsArchetypes: [] },
    { slug: 'curiosity_gap', family: 'tension', name: 'Curiosity gap', shape: 'Withholds the payoff', skeleton: "Nobody checks what's inside [X].", fitsArchetypes: [] },
    { slug: 'demonstration', family: 'evidence', name: 'Demonstration', shape: 'Opens mid-action, no preamble', skeleton: 'Product already doing the thing.', fitsArchetypes: [] },
    { slug: 'objection_lead', family: 'tension', name: 'Objection lead', shape: 'Voices the doubt first', skeleton: "Yes, it's 3x the price. Here's why.", fitsArchetypes: [] },
  ],
};
```

- [ ] **Step 2: Write the failing seed test**

`packages/db/test/seed.test.ts`:
```ts
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { openDb } from '../src/client';
import { archetypes, formats, hookArchetypes, projects, users, vocabFamilies } from '../src/schema';
import { seedLocalUser, seedVocabulary } from '../src/seed/seed';
import { VOCAB, type VocabSeed } from '../src/seed/vocabulary';

const clone = (): VocabSeed => structuredClone(VOCAB);

describe('seedVocabulary', () => {
  it('seeds 7 archetypes, 8 formats, 7 hooks, 9 families — all active', async () => {
    const { db, close } = await openDb();
    await seedVocabulary(db);
    expect(await db.$count(archetypes)).toBe(7);
    expect(await db.$count(formats)).toBe(8);
    expect(await db.$count(hookArchetypes)).toBe(7);
    expect(await db.$count(vocabFamilies)).toBe(9);
    expect(await db.$count(hookArchetypes, eq(hookArchetypes.status, 'active'))).toBe(7);
    await close();
  });

  it('is idempotent', async () => {
    const { db, close } = await openDb();
    await seedVocabulary(db);
    await seedVocabulary(db);
    expect(await db.$count(formats)).toBe(8);
    await close();
  });

  it('applies a family regroup on re-seed but never un-retires a row', async () => {
    const { db, close } = await openDb();
    await seedVocabulary(db);
    await db.update(hookArchetypes).set({ status: 'retired' }).where(eq(hookArchetypes.slug, 'confession'));

    const vocab = clone();
    vocab.hooks.find((h) => h.slug === 'direct_call')!.family = 'tension';
    await seedVocabulary(db, vocab);

    const [tension] = await db.select().from(vocabFamilies).where(eq(vocabFamilies.slug, 'tension'));
    const [directCall] = await db.select().from(hookArchetypes).where(eq(hookArchetypes.slug, 'direct_call'));
    const [confession] = await db.select().from(hookArchetypes).where(eq(hookArchetypes.slug, 'confession'));
    expect(directCall?.familyId).toBe(tension?.id);
    expect(confession?.status).toBe('retired');
    await close();
  });

  it('fails the whole seed when a hook points at a format family', async () => {
    const { db, close } = await openDb();
    const vocab = clone();
    vocab.hooks[0]!.family = 'narrative_arc';
    await expect(seedVocabulary(db, vocab)).rejects.toThrow(/narrative_arc.*format.*hook/);
    expect(await db.$count(vocabFamilies)).toBe(0); // rolled back
    await close();
  });
});

describe('seedLocalUser', () => {
  it('creates one user and one project, idempotently', async () => {
    const { db, close } = await openDb();
    const a = await seedLocalUser(db);
    const b = await seedLocalUser(db);
    expect(b).toEqual(a);
    expect(await db.$count(users)).toBe(1);
    expect(await db.$count(projects)).toBe(1);
    await close();
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `pnpm test`
Expected: FAIL — cannot resolve `../src/seed/seed`.

- [ ] **Step 4: Implement seeding**

`packages/db/src/seed/seed.ts`:
```ts
import { eq } from 'drizzle-orm';
import type { Db } from '../client';
import { archetypes, formats, hookArchetypes, projects, users, vocabFamilies } from '../schema';
import { VOCAB, type VocabSeed } from './vocabulary';

/**
 * Upsert by slug. Content fields and family membership follow the seed file;
 * `status` is set only on insert — re-seeding never revives a retired row.
 * All-or-nothing: any bad reference rolls the whole seed back.
 */
export async function seedVocabulary(db: Db, vocab: VocabSeed = VOCAB): Promise<void> {
  await db.transaction(async (tx) => {
    for (const f of vocab.families) {
      await tx
        .insert(vocabFamilies)
        .values(f)
        .onConflictDoUpdate({ target: vocabFamilies.slug, set: { name: f.name } });
    }
    const fams = await tx.select().from(vocabFamilies);
    const familyId = (slug: string, kind: 'format' | 'hook'): string => {
      const fam = fams.find((f) => f.slug === slug);
      if (!fam) throw new Error(`Unknown family "${slug}"`);
      if (fam.kind !== kind) throw new Error(`Family "${slug}" is a ${fam.kind} family, used by a ${kind}`);
      return fam.id;
    };

    for (const { slug, ...rest } of vocab.archetypes) {
      await tx
        .insert(archetypes)
        .values({ slug, ...rest, status: 'active' })
        .onConflictDoUpdate({ target: archetypes.slug, set: rest });
    }
    for (const { slug, family, ...rest } of vocab.formats) {
      const set = { ...rest, familyId: familyId(family, 'format') };
      await tx
        .insert(formats)
        .values({ slug, ...set, status: 'active' })
        .onConflictDoUpdate({ target: formats.slug, set });
    }
    for (const { slug, family, ...rest } of vocab.hooks) {
      const set = { ...rest, familyId: familyId(family, 'hook') };
      await tx
        .insert(hookArchetypes)
        .values({ slug, ...set, status: 'active' })
        .onConflictDoUpdate({ target: hookArchetypes.slug, set });
    }
  });
}

const LOCAL_EMAIL = 'local@adforge.dev';

/** POC stand-in for Supabase Auth: one user, one project. */
export async function seedLocalUser(db: Db): Promise<{ userId: string; projectId: string }> {
  return db.transaction(async (tx) => {
    const [user] = await tx
      .insert(users)
      .values({ email: LOCAL_EMAIL })
      .onConflictDoUpdate({ target: users.email, set: { email: LOCAL_EMAIL } })
      .returning();
    const userId = user!.id;
    const [existing] = await tx.select().from(projects).where(eq(projects.userId, userId)).limit(1);
    const project = existing ?? (await tx.insert(projects).values({ userId, name: 'Local' }).returning())[0]!;
    return { userId, projectId: project.id };
  });
}
```

`packages/db/src/seed/run.ts`:
```ts
import { dataDirWarnings, parseEnv } from '@adforge/core/config/env';
import { openDb } from '../client';
import { seedLocalUser, seedVocabulary } from './seed';

try {
  process.loadEnvFile(new URL('../../../../.env', import.meta.url));
} catch (e) {
  if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
}

const env = parseEnv(process.env);
for (const w of dataDirWarnings(env.ADFORGE_DATA_DIR)) console.warn(`WARN ${w}`);

const { db, close } = await openDb(env.ADFORGE_DATA_DIR);
try {
  await seedVocabulary(db);
  const ids = await seedLocalUser(db);
  console.log('seeded', ids);
} finally {
  await close();
}
```

- [ ] **Step 5: Run tests and typecheck**

Run: `pnpm test; pnpm typecheck`
Expected: all PASS.

- [ ] **Step 6: Seed a real data dir**

Run: `Copy-Item .env.example .env` (if `.env` doesn't exist), then `pnpm db:seed`
Expected: `seeded { userId: '...', projectId: '...' }`, no OneDrive warning (`.env` points to `C:/adforge-data`). Run it a second time — same ids printed.

- [ ] **Step 7: Write ADR 0005**

`docs/decisions/0005-seeded-vocab-families.md`:
```markdown
# 0005 — Seeded vocabulary families

**Status:** accepted · 2026-10-15

## Context
`assertVariantDiversity()` checks hook and format *families* (architecture §5.2). The build spec has slugs but no families; one-family-per-slug would make the family check identical to the slug check and let near-synonyms through.

## Decision
Seed 4 hook families and 5 format families (spec §5.1 table). Archetypes get no family yet (`family_id` nullable). Families are DB rows; regrouping is an edit to `packages/db/src/seed/vocabulary.ts` + `pnpm db:seed`, or a direct row update. Re-seeding updates membership but never changes `status`.

## Consequences
With 4 hook families, "3 distinct hook families" is satisfiable but tight — `targeting` has one member. If the Director repeatedly fails the repair pass on archetypes whose shortlists lack a family, revisit the grouping before loosening the rule.
```

- [ ] **Step 8: Commit**

```bash
git add packages/db docs/decisions/0005-seeded-vocab-families.md
git commit -m "feat(db): idempotent vocabulary registry seed with families"
```

---

### Task 6: Local disk storage provider

**Files:**
- Create: `packages/providers/local-storage/package.json`, `packages/providers/local-storage/tsconfig.json`
- Create: `packages/providers/local-storage/src/index.ts`
- Create: `docs/decisions/0001-local-poc-stack.md`
- Test: `packages/providers/local-storage/test/local-storage.test.ts`

**Interfaces:**
- Consumes: `StorageProvider`, `MediaRef`, `PutOptions` (Task 2).
- Produces (`@adforge/provider-local-storage`): `class LocalDiskStorage implements StorageProvider { constructor(root: string, publicBaseUrl: string); readonly id: 'local'; put(bytes, opts): Promise<MediaRef>; read(key): Promise<Uint8Array>; pathFor(key): string }`. Key format: `<sha[0..2]>/<sha256>.<ext>`.

- [ ] **Step 1: Create the package**

`packages/providers/local-storage/package.json`:
```json
{
  "name": "@adforge/provider-local-storage",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "scripts": { "test": "vitest run", "typecheck": "tsc -p ." },
  "dependencies": { "@adforge/core": "workspace:*" },
  "devDependencies": {
    "vitest": "catalog:",
    "typescript": "catalog:",
    "@types/node": "catalog:"
  }
}
```

`packages/providers/local-storage/tsconfig.json`:
```json
{ "extends": "../../../tsconfig.base.json", "include": ["src", "test"] }
```

Run: `pnpm install`

- [ ] **Step 2: Write the failing test**

`packages/providers/local-storage/test/local-storage.test.ts`:
```ts
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LocalDiskStorage } from '../src/index';

let root: string;
let storage: LocalDiskStorage;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'adforge-media-'));
  storage = new LocalDiskStorage(root, 'http://localhost:3000');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const bytes = new TextEncoder().encode('fake png bytes');

describe('LocalDiskStorage', () => {
  it('stores content-addressed and returns an internal MediaRef', async () => {
    const ref = await storage.put(bytes, { mime: 'image/png', width: 10, height: 20 });
    expect(ref.id).toMatch(/^[0-9a-f]{2}\/[0-9a-f]{64}\.png$/);
    expect(ref.url).toBe(`http://localhost:3000/media/${ref.id}`);
    expect(ref).toMatchObject({ mime: 'image/png', bytes: bytes.byteLength, width: 10, height: 20 });
    expect(ref.sha256).toBe(ref.id.slice(3, 67));
  });

  it('dedupes identical bytes to one file', async () => {
    const a = await storage.put(bytes, { mime: 'image/png' });
    const b = await storage.put(bytes, { mime: 'image/png' });
    expect(b.id).toBe(a.id);
    const shard = a.id.slice(0, 2);
    expect(readdirSync(join(root, shard))).toEqual([a.id.slice(3)]); // no leftover temp files
  });

  it('round-trips through read', async () => {
    const ref = await storage.put(bytes, { mime: 'audio/wav' });
    expect(Buffer.from(await storage.read(ref.id)).toString()).toBe('fake png bytes');
  });

  it('rejects keys that are not content-addressed (path traversal)', async () => {
    await expect(storage.read('../../etc/passwd')).rejects.toThrow(/Invalid storage key/);
    await expect(storage.read('ab/../../x.png')).rejects.toThrow(/Invalid storage key/);
  });

  it('rejects unknown mime types', async () => {
    await expect(storage.put(bytes, { mime: 'application/x-msdownload' })).rejects.toThrow(/Unsupported mime/);
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `pnpm test`
Expected: FAIL — cannot resolve `../src/index`.

- [ ] **Step 4: Implement**

`packages/providers/local-storage/src/index.ts`:
```ts
import { createHash, randomUUID } from 'node:crypto';
import { access, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { MediaRef, PutOptions, StorageProvider } from '@adforge/core/providers/types';

const EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'video/mp4': 'mp4',
  'audio/wav': 'wav',
  'application/json': 'json',
};
const KEY = /^[0-9a-f]{2}\/[0-9a-f]{64}\.[a-z0-9]+$/;

/** POC stand-in for R2. Content-addressed: same bytes → same key → one file. */
export class LocalDiskStorage implements StorageProvider {
  readonly id = 'local';

  constructor(
    private readonly root: string,
    private readonly publicBaseUrl: string,
  ) {}

  pathFor(key: string): string {
    if (!KEY.test(key)) throw new Error(`Invalid storage key: ${key}`);
    return join(this.root, key);
  }

  async put(bytes: Uint8Array, opts: PutOptions): Promise<MediaRef> {
    const ext = EXT[opts.mime];
    if (!ext) throw new Error(`Unsupported mime type: ${opts.mime}`);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const key = `${sha256.slice(0, 2)}/${sha256}.${ext}`;
    const path = this.pathFor(key);

    const exists = await access(path).then(() => true, () => false);
    if (!exists) {
      await mkdir(dirname(path), { recursive: true });
      // Write-then-rename so a crash never leaves a truncated file under a valid key.
      const tmp = `${path}.${randomUUID()}.tmp`;
      await writeFile(tmp, bytes);
      await rename(tmp, path);
    }

    return {
      id: key,
      url: `${this.publicBaseUrl}/media/${key}`,
      mime: opts.mime,
      sha256,
      bytes: bytes.byteLength,
      width: opts.width,
      height: opts.height,
      durationSec: opts.durationSec,
    };
  }

  async read(key: string): Promise<Uint8Array> {
    return readFile(this.pathFor(key));
  }
}
```

Note: `exactOptionalPropertyTypes` is off in the base tsconfig, so assigning `undefined` to optional `MediaRef` fields typechecks.

- [ ] **Step 5: Run tests and typecheck**

Run: `pnpm test; pnpm typecheck`
Expected: all PASS across core, db, local-storage.

- [ ] **Step 6: Write ADR 0001**

`docs/decisions/0001-local-poc-stack.md`:
```markdown
# 0001 — Local POC infrastructure stand-ins

**Status:** accepted · 2026-10-15 · Spec: docs/superpowers/specs/2026-10-15-adforge-local-poc-design.md §2

## Context
The POC must run end to end on one Windows machine with no Docker and zero media spend, without forking the code shape architecture.md prescribes.

## Decision
Keep every seam; swap what is behind it:
- Supabase Postgres → **PGlite** with the same Drizzle schema and migrations. Single-process, guarded by a pid lockfile.
- Supabase Auth → one seeded local user; `userId` still threads through the schema.
- R2 → **LocalDiskStorage**, content-addressed under `ADFORGE_DATA_DIR`, served at `/media/<key>`.
- Inngest Cloud → Inngest dev server. fal.ai → ComfyUI (ADR 0002). ElevenLabs → Kokoro (ADR 0003).
- Langfuse/Sentry deferred; `provider_calls` is still written.
- `ADFORGE_DATA_DIR` must live outside OneDrive; boot-check warns otherwise.

## Consequences
Going to production is new adapters + env, not a rewrite. PGlite cannot be shared by two processes, so seed scripts and the dev server cannot run against the same data dir at once.
```

- [ ] **Step 7: Commit**

```bash
git add packages/providers/local-storage docs/decisions/0001-local-poc-stack.md pnpm-lock.yaml
git commit -m "feat(storage): content-addressed local disk storage provider"
```

**P0 exit check:** `pnpm install; pnpm test; pnpm typecheck; pnpm boot-check; pnpm db:seed` all succeed from a clean clone (with `.env` copied from `.env.example`).

---

### Task 7: ComfyUI install, models, and exported workflows (P1)

Operational task — the deliverables are a working local service, three committed workflow files, three recorded fixtures, fetched docs, and an ADR. Run commands in PowerShell.

**Files:**
- Create: `packages/providers/comfyui/workflows/plate-flux-schnell.json`
- Create: `packages/providers/comfyui/workflows/cutout-birefnet.json`
- Create: `packages/providers/comfyui/workflows/broll-wan22-5b.json`
- Create: `packages/providers/comfyui/fixtures/{plate-flux-schnell,cutout-birefnet,broll-wan22-5b}.history.json`
- Create: `packages/providers/comfyui/workflows/README.md`
- Create: `docs/providers/comfyui.md`
- Create: `docs/decisions/0002-comfyui-provider-and-models.md`

**Interfaces:**
- Produces for P2: workflow JSON files in ComfyUI **API format** where every input the adapter sets lives on a node whose title (`_meta.title`) follows the contract below, plus one real `/history/{prompt_id}` response per workflow.

**Node-title contract** (the P2 patcher addresses nodes by these titles, never by numeric id):

| Title | Node | Input(s) the adapter sets |
|---|---|---|
| `in:prompt` | positive text encode | `text` |
| `in:seed` | sampler / noise node | `seed` or `noise_seed` |
| `in:size` | empty latent / Wan image-to-video latent | `width`, `height` (+ `length` for video) |
| `in:image` | LoadImage | `image` |
| `out:image` | SaveImage | — (output read from history) |
| `out:video` | save video node | — |

- [ ] **Step 1: Install ComfyUI portable outside OneDrive**

Download the latest **Windows portable NVIDIA** build from https://github.com/comfyanonymous/ComfyUI/releases (asset named like `ComfyUI_windows_portable_nvidia.7z`). Extract so that `C:\ComfyUI\run_nvidia_gpu.bat` exists (7-Zip, or Windows 11 Explorer's built-in 7z support).

Verify Blackwell support:
```powershell
C:\ComfyUI\python_embeded\python.exe -c "import torch; print(torch.__version__, torch.version.cuda, torch.cuda.get_device_name(0), 'sm_120' in torch.cuda.get_arch_list())"
```
Expected: CUDA `12.8` or newer, `NVIDIA GeForce RTX 5070 Ti`, `True`. If `False`, the bundled torch predates Blackwell — download a newer portable release.

- [ ] **Step 2: Start it and check the API**

Run: `Start-Process C:\ComfyUI\run_nvidia_gpu.bat`, wait for "To see the GUI go to: http://127.0.0.1:8188", then:
```powershell
(Invoke-WebRequest -UseBasicParsing http://127.0.0.1:8188/system_stats).Content
```
Expected: JSON listing the 5070 Ti under `devices` with ~16 GB `vram_total`.

- [ ] **Step 3: Fetch the API docs FIRST (CLAUDE.md rule)**

Fetch the ComfyUI server routes documentation (https://docs.comfy.org — "Server" / "Routes" pages: `POST /prompt`, `GET /history/{prompt_id}`, `GET /view`, `POST /upload/image`, `GET /system_stats`, `GET /object_info`, `GET /queue`, websocket `/ws`) and save the relevant content, with source URLs and fetch date, to `docs/providers/comfyui.md`. Include the exact shape of a `/prompt` error response (`error`, `node_errors`) and of a `/history` entry (`outputs`, `status.status_str`, `status.messages`).

- [ ] **Step 4: Plate workflow — Flux.1-schnell**

In the ComfyUI GUI open Workflow → Browse Templates → **Flux Schnell**. Let it download the model it lists (expected: `flux1-schnell-fp8.safetensors` into `models/checkpoints/`, from `Comfy-Org/flux1-schnell` on Hugging Face). Then:
1. Set the empty latent to width `768`, height `1344`, batch 1. Title it `in:size`.
2. Title the positive prompt node `in:prompt`; the KSampler `in:seed`; the SaveImage `out:image`.
3. Queue once with the prompt `seamless soft light-grey studio backdrop, gentle gradient, softbox lighting, minimal commercial product photography, empty centre foreground`. Note the wall-clock time for the first (cold) and second (warm) run.
4. Workflow → **Export (API)** → save as `packages/providers/comfyui/workflows/plate-flux-schnell.json`.

Verify the titles survived export:
```powershell
Select-String -Path packages/providers/comfyui/workflows/plate-flux-schnell.json -Pattern '"in:prompt"|"in:seed"|"in:size"|"out:image"' | Measure-Object | Select-Object -ExpandProperty Count
```
Expected: `4`.

- [ ] **Step 5: Cutout workflow — BiRefNet**

Install a background-removal custom node that provides BiRefNet: clone `https://github.com/1038lab/ComfyUI-RMBG` into `C:\ComfyUI\ComfyUI\custom_nodes\`, then `C:\ComfyUI\python_embeded\python.exe -m pip install -r C:\ComfyUI\ComfyUI\custom_nodes\ComfyUI-RMBG\requirements.txt`, restart ComfyUI. Read its README and confirm (a) it offers a BiRefNet model, (b) the node's license, (c) the BiRefNet model's license (MIT expected). If it doesn't offer BiRefNet, use any maintained node that does and record which in ADR 0002.

Build: `LoadImage` (title `in:image`) → BiRefNet removal node (model: BiRefNet general) → `SaveImage` (title `out:image`). Run on any product photo and confirm the saved PNG has transparency (open it — checkerboard background). Export (API) → `packages/providers/comfyui/workflows/cutout-birefnet.json`. Verify 2 titles with the `Select-String` check (`"in:image"|"out:image"`).

- [ ] **Step 6: B-roll workflow — Wan 2.2 TI2V-5B**

Browse Templates → **Wan 2.2 5B** image-to-video (TI2V). Download the models it lists (expected: `wan2.2_ti2v_5B_fp16.safetensors` → `models/diffusion_models/`, `umt5_xxl_fp8_e4m3fn_scaled.safetensors` → `models/text_encoders/`, `wan2.2_vae.safetensors` → `models/vae/`, from the `Comfy-Org` repackaged repos). Then:
1. Set the Wan image-to-video latent node to vertical `704 × 1280`, length `121` (≈5s at 24fps). Title it `in:size`.
2. Title `LoadImage` `in:image`, positive prompt `in:prompt`, sampler `in:seed`, save-video node `out:video` (mp4/h264 output).
3. Run once using the plate from Step 4 as input, prompt `slow drifting soft light, gentle dust particles in the air, subtle ambient motion, static camera`. Record cold and warm wall-clock time and peak VRAM (Task Manager → GPU → Dedicated memory).
4. Export (API) → `packages/providers/comfyui/workflows/broll-wan22-5b.json`. Verify 5 titles.

If a 121-frame clip takes more than ~10 minutes warm, drop length to `81` and record that in ADR 0002 (the P2 adapter reads length from `PIPELINE.broll.durationSec`).

- [ ] **Step 7: Record one live /history response per workflow**

For each workflow, after a successful run, find its prompt id (`GET /history?max_items=1`) and save the entry:
```powershell
$h = Invoke-RestMethod "http://127.0.0.1:8188/history?max_items=1"
$h | ConvertTo-Json -Depth 20 | Out-File -Encoding utf8 packages/providers/comfyui/fixtures/plate-flux-schnell.history.json
```
(Run immediately after each workflow's run, changing the file name.) Each fixture must contain an `outputs` entry for the `out:*` node's id with `filename`, `subfolder`, `type`.

- [ ] **Step 8: Workflow README + ADR 0002**

`packages/providers/comfyui/workflows/README.md`:
```markdown
# ComfyUI workflows

API-format exports (Workflow → Export (API)). The adapter patches nodes **by title**, so re-exporting after tuning in the GUI is safe as long as titles are kept.

| Title | Meaning |
|---|---|
| `in:prompt` | positive prompt text |
| `in:seed` | sampler seed |
| `in:size` | width / height (+ length for video) |
| `in:image` | LoadImage input |
| `out:image` / `out:video` | output node read from `/history` |

To add a workflow: build it in the GUI, apply the titles, export to `<name>.json`, add `<name>.params.ts` (P2), set `ADFORGE_COMFY_WORKFLOW_*` and add the name to nothing else.
```

`docs/decisions/0002-comfyui-provider-and-models.md` — fill every bracket with what Steps 1–7 actually measured:
```markdown
# 0002 — ComfyUI as the local media provider

**Status:** accepted · 2026-10-15

## Decision
ComfyUI portable at `C:\ComfyUI` (outside OneDrive), called over its HTTP API behind `ImageProvider` / `CutoutProvider` / `VideoProvider`. Completion by polling `/history`, never websocket alone.

| Role | Model | File | License | Cold / warm time | Peak VRAM |
|---|---|---|---|---|---|
| Plate | Flux.1-schnell fp8, 4 steps, 768×1344 | flux1-schnell-fp8.safetensors | Apache-2.0 | [measured] | [measured] |
| Cutout | BiRefNet via [node name + license] | [file] | MIT | [measured] | [measured] |
| B-roll | Wan 2.2 TI2V-5B, 704×1280, [121|81] frames | wan2.2_ti2v_5B_fp16.safetensors | Apache-2.0 | [measured] | [measured] |

ComfyUI version: [from /system_stats]. Torch / CUDA: [from Step 1].

## Consequences
Swapping models is a workflow re-export + env change. Flux.1-dev is excluded by default (non-commercial licence).
```

- [ ] **Step 9: Commit**

```bash
git add packages/providers/comfyui docs/providers/comfyui.md docs/decisions/0002-comfyui-provider-and-models.md
git commit -m "chore(comfyui): local install, three title-tagged workflows, recorded fixtures"
```

**P1 exit check:** ComfyUI answers `/system_stats`; each of the three workflows runs from the GUI; the three JSON exports contain their `in:*`/`out:*` titles; the three fixtures and `docs/providers/comfyui.md` are committed; ADR 0002 has real numbers.

---

## Next plans

Written after this plan lands, each against fetched docs:
- **P2** ComfyUI adapter — client, title-based patcher, `.params.ts` manifests, goldens from these workflows, fixtures from Step 7, `pnpm smoke:comfy`.
- **P3** HyperFrames render spike (fetch `docs/providers/hyperframes.md` first).
- **P4–P8** registry shortlist + diversity, LLM layer, Kokoro + spec builder, Inngest pipeline, UI.
