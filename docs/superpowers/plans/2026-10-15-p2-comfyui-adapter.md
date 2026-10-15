# P2: ComfyUI Adapter — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `@adforge/provider-comfyui` implements `ImageProvider` (plates), `CutoutProvider` (BiRefNet), and `VideoProvider` (Wan 2.2 b-roll) against the local ComfyUI. All outputs land in AdForge storage as internal `MediaRef`s, and `pnpm smoke:comfy` proves it live.

**Architecture:**
- A thin `ComfyClient` speaks the HTTP API, and every response it reads is Zod-validated.
- A title-based `patchWorkflow` fills the committed API-format workflows using per-workflow manifests.
- A job layer submits idempotently. The `prompt_id` is derived from the idempotency key, and a job that is already queued or finished is never queued twice. It collects results from `/history` by polling only.
- The image and cutout providers wait for their result (seconds). The video provider is submit/poll (minutes).

**Tech Stack:** TypeScript 7 · Zod 4.6.7 · Vitest 5 (`toMatchFileSnapshot` for golden files) · Node 24 `fetch` / `FormData` / `Blob`. **No new dependencies.**

**Spec:** [docs/superpowers/specs/2026-10-15-adforge-local-poc-design.md](../specs/2026-10-15-adforge-local-poc-design.md) §5.5, §6, §7, §8. Also read [docs/providers/comfyui.md](../../providers/comfyui.md) (API reference, v0.35.1) and [ADR 0002](../../decisions/0002-comfyui-provider-and-models.md) (measured behaviour and findings).

## Global Constraints

- Provider SDK/vendor types never leave `packages/providers/comfyui/`. Everything crossing the boundary is a `MediaRef` or another type from `packages/core/src/providers/types.ts`.
- **Every provider request is Zod-validated before dispatch.** A remote 400 means our validation is wrong; fix the schema, not the payload.
- `MediaRef.url` is always an internal URL. Outputs are downloaded via `/view` and stored through `StorageProvider.put` immediately. A ComfyUI URL never leaves the adapter.
- Determinism: no unseeded randomness. When no seed is given, it is derived from the idempotency key.
- Webhooks get lost: completion is detected by polling `/history`, never by websocket.
- `INVALID_INPUT` is a bug in our adapter or setup, never retryable.
- Nodes are addressed by `_meta.title` (`in:prompt`, `in:seed`, `in:size`, `in:image`, `out:image`, `out:video`), never by numeric id.
- Pin exact versions; no new dependencies (Zod is already in the catalog).
- `pnpm test` (which runs typecheck first) must pass before every commit. No test may require a live ComfyUI or GPU; live checks go in `pnpm smoke:comfy` only.
- Commits: `git -c user.name=heetshah16 -c user.email=shahheet85@gmail.com commit ...`, ending with a `Co-Authored-By:` trailer naming the authoring model.

## Review Focus

1. **ComfyUI restarted mid-job** (history wiped). The job must report a *retryable* failure saying it was lost. Retrying with the same idempotency key must resubmit exactly once. → Task 3 tests.
2. **Job finishes between the history check and the queue check.** It must not be reported as lost. → Task 3 test.
3. **Upload name collision.** The server may store the upload as `x (1).png`; the workflow must use the *returned* name, not the one sent. → Task 4 test.
4. **Workflow re-exported from the GUI with a title renamed or missing.** It must fail at provider construction (boot), not mid-job. → Task 1 (`assertManifestMatches`) and Task 4 tests.
5. **Same request retried after a timeout.** It must return the original job's result, never trigger a second render. → Task 4 test (one `POST /prompt` across two calls).

---

## File Structure

```
packages/providers/comfyui/
  package.json, tsconfig.json
  workflows/                         (exists: 3 API-format JSON + README)
    plate-flux-schnell.params.ts     manifest: plate params → title patches
    cutout-birefnet.params.ts        manifest: cutout params → title patches
    broll-wan22-5b.params.ts         manifest: b-roll params → title patches (+ size, fps)
  fixtures/                          (exists: 3 history entries + missing-model 400)
  src/
    patch.ts        ApiWorkflow type, nodeIdByTitle, patchWorkflow
    workflows.ts    role param schemas, Manifest type, workflow tables, loadWorkflow, assertManifestMatches
    client.ts       ComfyClient (HTTP + response schemas), describeRejection, promptIdFor
    job.ts          submitOnce, collect, waitFor, pngSize
    providers.ts    createComfyProviders → { image, cutout, video, workflowHashes }
    index.ts        public exports
    smoke.ts        live end-to-end check (pnpm smoke:comfy)
  test/
    helpers.ts      fakeFetch, json(), fixture(), memoryStorage(), pngBytes()
    golden/         patched-workflow golden files (written by toMatchFileSnapshot)
    patch.test.ts, client.test.ts, job.test.ts, providers.test.ts
packages/core/src/providers/types.ts   + isRetryable(code)
docs/decisions/0007-comfyui-adapter-job-model.md
```

---

### Task 1: Package scaffold, title patcher, workflow manifests, golden files

**Files:**
- Create: `packages/providers/comfyui/package.json`, `packages/providers/comfyui/tsconfig.json`
- Create: `packages/providers/comfyui/src/patch.ts`, `packages/providers/comfyui/src/workflows.ts`
- Create: `packages/providers/comfyui/workflows/plate-flux-schnell.params.ts`, `cutout-birefnet.params.ts`, `broll-wan22-5b.params.ts`
- Create: `packages/providers/comfyui/test/patch.test.ts` (+ generated `test/golden/*.json`)
- Modify: root `package.json` (add `smoke:comfy` script)

**Interfaces:**
- Produces (`src/patch.ts`): `type ApiNode = { class_type: string; inputs: Record<string, unknown>; _meta?: { title?: string } }`; `type ApiWorkflow = Record<string, ApiNode>`; `type Patches = Record<string, Record<string, string | number>>`; `nodeIdByTitle(wf, title): string`; `patchWorkflow(wf, patches): ApiWorkflow` (pure; never mutates its input).
- Produces (`src/workflows.ts`): Zod schemas + types `PlateParams`, `CutoutParams`, `BrollParams`; `interface Manifest<P> { name; output: { title: 'out:image' | 'out:video'; mime: 'image/png' | 'video/mp4' }; sample: P; toPatches(p: P): Patches; size?: { width: number; height: number }; fps?: number }`; tables `PLATE_WORKFLOWS`, `CUTOUT_WORKFLOWS`, `BROLL_WORKFLOWS: Record<string, Manifest<…>>`; `pickWorkflow(table, name, role)`; `loadWorkflow(name): { json: ApiWorkflow; sha256: string }`; `assertManifestMatches(json, manifest): void`.

- [ ] **Step 1: Create the package**

`packages/providers/comfyui/package.json`:
```json
{
  "name": "@adforge/provider-comfyui",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "scripts": {
    "test": "vitest run",
    "typecheck": "tsc -p .",
    "smoke": "tsx src/smoke.ts"
  },
  "dependencies": {
    "@adforge/core": "workspace:*",
    "zod": "catalog:"
  },
  "devDependencies": {
    "@adforge/provider-local-storage": "workspace:*",
    "vitest": "catalog:",
    "tsx": "catalog:",
    "typescript": "catalog:",
    "@types/node": "catalog:"
  }
}
```

`packages/providers/comfyui/tsconfig.json`:
```json
{ "extends": "../../../tsconfig.base.json", "include": ["src", "test", "workflows"] }
```

In the root `package.json` `scripts`, add: `"smoke:comfy": "pnpm --filter @adforge/provider-comfyui smoke"`.

Run: `pnpm install`

- [ ] **Step 2: Write the failing test**

`packages/providers/comfyui/test/patch.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { nodeIdByTitle, patchWorkflow, type ApiWorkflow } from '../src/patch';
import {
  BROLL_WORKFLOWS,
  BrollParams,
  CUTOUT_WORKFLOWS,
  PLATE_WORKFLOWS,
  PlateParams,
  assertManifestMatches,
  loadWorkflow,
  pickWorkflow,
} from '../src/workflows';

const wf: ApiWorkflow = {
  '1': { class_type: 'CLIPTextEncode', inputs: { text: '', clip: ['9', 1] }, _meta: { title: 'in:prompt' } },
  '2': { class_type: 'KSampler', inputs: { seed: 0, steps: 4 }, _meta: { title: 'in:seed' } },
};

describe('patchWorkflow', () => {
  it('sets inputs on the node with the given title', () => {
    const out = patchWorkflow(wf, { 'in:prompt': { text: 'hello' }, 'in:seed': { seed: 7 } });
    expect(out['1']!.inputs.text).toBe('hello');
    expect(out['2']!.inputs.seed).toBe(7);
  });
  it('never mutates the input workflow', () => {
    patchWorkflow(wf, { 'in:prompt': { text: 'hello' } });
    expect(wf['1']!.inputs.text).toBe('');
  });
  it('rejects an unknown title', () => {
    expect(() => patchWorkflow(wf, { 'in:nope': { text: 'x' } })).toThrow('exactly one node titled "in:nope", found 0');
  });
  it('rejects a duplicated title', () => {
    const dup: ApiWorkflow = { ...wf, '3': { ...wf['1']!, _meta: { title: 'in:prompt' } } };
    expect(() => nodeIdByTitle(dup, 'in:prompt')).toThrow('found 2');
  });
  it('rejects an input the node does not have (typo guard)', () => {
    expect(() => patchWorkflow(wf, { 'in:seed': { noise_seed: 1 } })).toThrow('has no input "noise_seed"');
  });
  it('refuses to overwrite a link with a value', () => {
    expect(() => patchWorkflow(wf, { 'in:prompt': { clip: 'x' } })).toThrow('is a link');
  });
});

describe('workflow manifests', () => {
  it('reject sizes the models cannot take', () => {
    expect(PlateParams.safeParse({ prompt: 'p', seed: 1, width: 770, height: 1344 }).success).toBe(false);
    expect(BrollParams.safeParse({ prompt: 'p', seed: 1, image: 'a.png', width: 704, height: 1280, length: 120 }).success).toBe(false);
    expect(BrollParams.safeParse({ prompt: 'p', seed: 1, image: 'a.png', width: 704, height: 1280, length: 121 }).success).toBe(true);
  });

  it('name unknown workflows with the known ones', () => {
    expect(() => pickWorkflow(PLATE_WORKFLOWS, 'plate-sdxl', 'plate')).toThrow(
      'Unknown plate workflow "plate-sdxl". Known: plate-flux-schnell',
    );
  });

  it('rejects path-like workflow names', () => {
    expect(() => loadWorkflow('../../package')).toThrow('Invalid workflow name');
  });

  it('detects a re-exported workflow that lost a title', () => {
    const m = pickWorkflow(PLATE_WORKFLOWS, 'plate-flux-schnell', 'plate');
    const { json } = loadWorkflow(m.name);
    const broken = structuredClone(json);
    for (const node of Object.values(broken)) if (node._meta?.title === 'in:size') node._meta.title = 'Empty Latent';
    expect(() => assertManifestMatches(broken, m)).toThrow('in:size');
  });

  type Golden = [string, () => ApiWorkflow];
  const golden: Golden[] = [
    ...Object.values(PLATE_WORKFLOWS).map((m): Golden => [m.name, () => patchWorkflow(loadWorkflow(m.name).json, m.toPatches(m.sample))]),
    ...Object.values(CUTOUT_WORKFLOWS).map((m): Golden => [m.name, () => patchWorkflow(loadWorkflow(m.name).json, m.toPatches(m.sample))]),
    ...Object.values(BROLL_WORKFLOWS).map((m): Golden => [m.name, () => patchWorkflow(loadWorkflow(m.name).json, m.toPatches(m.sample))]),
  ];
  for (const [name, patched] of golden) {
    it(`golden: ${name} patched with its sample params`, async () => {
      await expect(JSON.stringify(patched(), null, 2) + '\n').toMatchFileSnapshot(`./golden/${name}.json`);
    });
  }
});
```

- [ ] **Step 3: Run to verify failure**

Run: `pnpm --filter @adforge/provider-comfyui test`
Expected: FAIL. `../src/patch` cannot be resolved.

- [ ] **Step 4: Implement the patcher**

`packages/providers/comfyui/src/patch.ts`:
```ts
/** ComfyUI API-format workflow: node id → node. Links are `[srcNodeId, outputIndex]`. */
export interface ApiNode {
  class_type: string;
  inputs: Record<string, unknown>;
  _meta?: { title?: string };
}
export type ApiWorkflow = Record<string, ApiNode>;

/** title → { inputName: value } */
export type Patches = Record<string, Record<string, string | number>>;

export function nodeIdByTitle(wf: ApiWorkflow, title: string): string {
  const ids = Object.keys(wf).filter((id) => wf[id]?._meta?.title === title);
  if (ids.length !== 1) {
    throw new Error(`Workflow must have exactly one node titled "${title}", found ${ids.length}`);
  }
  return ids[0]!;
}

/** Pure: returns a patched copy. Nodes are addressed by title so GUI re-exports stay compatible. */
export function patchWorkflow(wf: ApiWorkflow, patches: Patches): ApiWorkflow {
  const out = structuredClone(wf);
  for (const [title, inputs] of Object.entries(patches)) {
    const node = out[nodeIdByTitle(out, title)]!;
    for (const [name, value] of Object.entries(inputs)) {
      if (!(name in node.inputs)) {
        throw new Error(`Node "${title}" (${node.class_type}) has no input "${name}"`);
      }
      if (Array.isArray(node.inputs[name])) {
        throw new Error(`Input "${name}" on "${title}" is a link, not a value`);
      }
      node.inputs[name] = value;
    }
  }
  return out;
}
```

- [ ] **Step 5: Implement role schemas, the manifest type and loading**

`packages/providers/comfyui/src/workflows.ts`:
```ts
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
  const raw = readFileSync(new URL(`../workflows/${name}.json`, import.meta.url));
  return {
    json: JSON.parse(raw.toString('utf8')) as ApiWorkflow,
    sha256: createHash('sha256').update(raw).digest('hex'),
  };
}

/** Boot-time guard: the JSON must still carry every title the manifest patches, plus its output title. */
export function assertManifestMatches<P>(json: ApiWorkflow, m: Manifest<P>): void {
  patchWorkflow(json, m.toPatches(m.sample));
  nodeIdByTitle(json, m.output.title);
}
```

- [ ] **Step 6: Write the three manifests**

`packages/providers/comfyui/workflows/plate-flux-schnell.params.ts`:
```ts
import type { Manifest, PlateParams } from '../src/workflows';

export const plateFluxSchnell: Manifest<PlateParams> = {
  name: 'plate-flux-schnell',
  output: { title: 'out:image', mime: 'image/png' },
  sample: {
    prompt: 'warm natural daylight, real lived-in kitchen interior, empty surface in the foreground',
    seed: 1,
    width: 768,
    height: 1344,
  },
  toPatches: (p) => ({
    'in:prompt': { text: p.prompt },
    'in:seed': { seed: p.seed },
    'in:size': { width: p.width, height: p.height },
  }),
};
```

`packages/providers/comfyui/workflows/cutout-birefnet.params.ts`:
```ts
import type { CutoutParams, Manifest } from '../src/workflows';

export const cutoutBirefnet: Manifest<CutoutParams> = {
  name: 'cutout-birefnet',
  output: { title: 'out:image', mime: 'image/png' },
  sample: { image: 'product.png' },
  toPatches: (p) => ({ 'in:image': { image: p.image } }),
};
```

`packages/providers/comfyui/workflows/broll-wan22-5b.params.ts`:
```ts
import type { BrollParams, Manifest } from '../src/workflows';

export const brollWan22_5b: Manifest<BrollParams> = {
  name: 'broll-wan22-5b',
  output: { title: 'out:video', mime: 'video/mp4' },
  size: { width: 704, height: 1280 },
  fps: 24,
  sample: {
    prompt: 'slow drifting warm sunlight, soft dust in the air, subtle ambient motion, static camera',
    seed: 7,
    image: 'plate.png',
    width: 704,
    height: 1280,
    length: 121,
  },
  toPatches: (p) => ({
    'in:prompt': { text: p.prompt },
    'in:seed': { seed: p.seed },
    'in:image': { image: p.image },
    'in:size': { width: p.width, height: p.height, length: p.length },
  }),
};
```

- [ ] **Step 7: Run tests (writes the golden files on first run) and inspect them**

Run: `pnpm --filter @adforge/provider-comfyui test`
Expected: all PASS. Three files are created under `test/golden/`. Open each and confirm the sample values landed on the right nodes. For example, in `test/golden/broll-wan22-5b.json`, node `"8"` (`Wan22ImageToVideoLatent`) has `"length": 121` and node `"5"` has `"image": "plate.png"`. Then run the suite again and confirm it still passes. A second run that rewrites the files means the output is non-deterministic, which is a bug.

Run: `pnpm test` (repo root; includes typecheck)
Expected: all PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/providers/comfyui package.json pnpm-lock.yaml
git commit -m "feat(comfyui): title-based workflow patcher, role manifests, golden files"
```

---

### Task 2: ComfyClient — HTTP, response schemas, error mapping

**Files:**
- Create: `packages/providers/comfyui/src/client.ts`
- Create: `packages/providers/comfyui/test/helpers.ts`
- Test: `packages/providers/comfyui/test/client.test.ts`

**Interfaces:**
- Consumes: `ApiWorkflow` (Task 1); `ProviderError` from `@adforge/core/providers/types`; `loadWorkflow` (Task 1, tests only).
- Produces (`src/client.ts`):
  - `FileRef` (schema + type `{ filename; subfolder; type }`) and `HistoryEntry` (type `{ prompt: unknown[]; outputs: Record<string, Record<string, unknown>>; status: { status_str: 'success' | 'error'; completed: boolean; messages: [string, Record<string, unknown>][] } | null }`)
  - `type Fetch = typeof fetch`
  - `class ComfyClient(baseUrl: string, fetchImpl?: Fetch)` with `systemStats(): Promise<unknown>`, `uploadImage(bytes: Uint8Array, filename: string): Promise<string>`, `queuePrompt(wf: ApiWorkflow, promptId: string): Promise<void>`, `history(promptId): Promise<HistoryEntry | null>`, `isQueued(promptId): Promise<boolean>`, `view(file: FileRef): Promise<Uint8Array>`
  - `describeRejection(wf, rejected): string` and `promptIdFor(idempotencyKey: string): string`
- Produces (`test/helpers.ts`): `fakeFetch(routes)` (returns a `typeof fetch` with a `.calls: string[]` log and a `.bodies: Record<string, unknown[]>` map), `json(body, status?)`, `fixture(name)`, `memoryStorage()`, and `pngBytes(width, height)`.

- [ ] **Step 1: Write the test helpers**

`packages/providers/comfyui/test/helpers.ts`:
```ts
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { MediaRef, PutOptions, StorageProvider } from '@adforge/core/providers/types';

type Handler = (req: Request) => Response | Promise<Response>;

/** Routes are keyed `METHOD /path` (query ignored). Unrouted calls throw, so tests see every request. */
export function fakeFetch(routes: Record<string, Handler>) {
  const calls: string[] = [];
  const bodies: Record<string, unknown[]> = {};
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    const key = `${req.method} ${new URL(req.url).pathname}`;
    calls.push(key);
    if (req.headers.get('content-type')?.includes('application/json')) {
      (bodies[key] ??= []).push(await req.clone().json());
    }
    const handler = routes[key];
    if (!handler) throw new Error(`unrouted request: ${key}`);
    return handler(req);
  }) as typeof fetch;
  return Object.assign(impl, { calls, bodies });
}

export const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

export const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8'));

/** A minimal PNG header (signature + IHDR) — enough for dimension parsing. */
export function pngBytes(width: number, height: number): Uint8Array {
  const b = new Uint8Array(33);
  b.set([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82]);
  const v = new DataView(b.buffer);
  v.setUint32(16, width);
  v.setUint32(20, height);
  return b;
}

export function memoryStorage() {
  const files = new Map<string, Uint8Array>();
  const puts: PutOptions[] = [];
  const storage: StorageProvider = {
    id: 'memory',
    async put(bytes, opts) {
      puts.push(opts);
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      const id = `${sha256.slice(0, 2)}/${sha256}.${opts.mime.split('/')[1]}`;
      files.set(id, bytes);
      const ref: MediaRef = { id, url: `http://localhost:3000/media/${id}`, mime: opts.mime, sha256, bytes: bytes.byteLength };
      return { ...ref, width: opts.width, height: opts.height, durationSec: opts.durationSec };
    },
    async read(key) {
      const b = files.get(key);
      if (!b) throw new Error(`no such key ${key}`);
      return b;
    },
  };
  return Object.assign(storage, { files, puts });
}
```

- [ ] **Step 2: Write the failing test**

`packages/providers/comfyui/test/client.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { ProviderError } from '@adforge/core/providers/types';
import { ComfyClient, promptIdFor } from '../src/client';
import { loadWorkflow } from '../src/workflows';
import { fakeFetch, fixture, json } from './helpers';

const BASE = 'http://127.0.0.1:8188';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe('promptIdFor', () => {
  it('is a canonical lowercase UUID, stable per key, distinct across keys', () => {
    expect(promptIdFor('job1:plate:0')).toMatch(UUID);
    expect(promptIdFor('job1:plate:0')).toBe(promptIdFor('job1:plate:0'));
    expect(promptIdFor('job1:plate:0')).not.toBe(promptIdFor('job1:plate:1'));
  });
});

describe('ComfyClient', () => {
  it('maps a missing-model 400 to INVALID_INPUT naming the node title and file', async () => {
    const rec = fixture('prompt-missing-model.400.json') as { status: number; body: unknown };
    const client = new ComfyClient(BASE, fakeFetch({ 'POST /prompt': () => json(rec.body, rec.status) }));
    const { json: wf } = loadWorkflow('broll-wan22-5b');
    const err = await client.queuePrompt(wf, promptIdFor('k')).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).code).toBe('INVALID_INPUT');
    expect((err as ProviderError).message).toContain('unet (UNETLoader)');
    expect((err as ProviderError).message).toContain('wan2.2_ti2v_5B_fp16.safetensors');
  });

  it('sends the prompt_id it was given', async () => {
    const f = fakeFetch({ 'POST /prompt': () => json({ prompt_id: 'x', number: 1, node_errors: {} }) });
    await new ComfyClient(BASE, f).queuePrompt({}, promptIdFor('k'));
    expect(f.bodies['POST /prompt']?.[0]).toMatchObject({ prompt_id: promptIdFor('k') });
  });

  for (const name of ['plate-flux-schnell', 'cutout-birefnet', 'broll-wan22-5b']) {
    it(`parses the recorded ${name} history entry`, async () => {
      const rec = fixture(`${name}.history.json`) as Record<string, unknown>;
      const id = Object.keys(rec)[0]!;
      const client = new ComfyClient(BASE, fakeFetch({ [`GET /history/${id}`]: () => json(rec) }));
      const entry = await client.history(id);
      expect(entry?.status?.status_str).toBe('success');
      expect(Object.keys(entry!.outputs).length).toBeGreaterThan(0);
    });
  }

  it('returns null for an id not in history', async () => {
    const client = new ComfyClient(BASE, fakeFetch({ 'GET /history/abc': () => json({}) }));
    expect(await client.history('abc')).toBeNull();
  });

  it('reports an unreachable server as UPSTREAM naming the URL', async () => {
    const down = (async () => {
      throw new TypeError('fetch failed');
    }) as typeof fetch;
    const err = await new ComfyClient(BASE, down).systemStats().catch((e: unknown) => e);
    expect((err as ProviderError).code).toBe('UPSTREAM');
    expect((err as ProviderError).message).toContain(BASE);
  });

  it('rejects an unexpected response shape as UPSTREAM', async () => {
    const client = new ComfyClient(BASE, fakeFetch({ 'GET /history/abc': () => json({ abc: { outputs: 5 } }) }));
    const err = await client.history('abc').catch((e: unknown) => e);
    expect((err as ProviderError).code).toBe('UPSTREAM');
    expect((err as ProviderError).message).toContain('Unexpected /history/abc response');
  });

  it('finds an id among running and pending jobs', async () => {
    const client = new ComfyClient(
      BASE,
      fakeFetch({ 'GET /queue': () => json({ queue_running: [[1, 'run-id', {}]], queue_pending: [[2, 'wait-id', {}]] }) }),
    );
    expect(await client.isQueued('run-id')).toBe(true);
    expect(await client.isQueued('wait-id')).toBe(true);
    expect(await client.isQueued('other')).toBe(false);
  });

  it('uploads multipart and returns the name the server chose', async () => {
    const f = fakeFetch({
      'POST /upload/image': async (req) => {
        const form = await req.formData();
        expect(form.get('overwrite')).toBe('true');
        expect((form.get('image') as File).name).toBe('abc.png');
        return json({ name: 'abc (1).png', subfolder: '', type: 'input' });
      },
    });
    expect(await new ComfyClient(BASE, f).uploadImage(new Uint8Array([1, 2]), 'abc.png')).toBe('abc (1).png');
  });

  it('downloads an output file through /view', async () => {
    const f = fakeFetch({ 'GET /view': () => new Response(new Uint8Array([9, 8, 7])) });
    const bytes = await new ComfyClient(BASE, f).view({ filename: 'a.png', subfolder: 'adforge', type: 'output' });
    expect([...bytes]).toEqual([9, 8, 7]);
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `pnpm --filter @adforge/provider-comfyui test`
Expected: FAIL. `../src/client` cannot be resolved.

- [ ] **Step 4: Implement the client**

`packages/providers/comfyui/src/client.ts`:
```ts
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { ProviderError } from '@adforge/core/providers/types';
import type { ApiWorkflow } from './patch';

const P = 'comfyui';

export const FileRef = z.object({ filename: z.string().min(1), subfolder: z.string(), type: z.string() });
export type FileRef = z.infer<typeof FileRef>;

const HistoryEntry = z.object({
  prompt: z.array(z.unknown()),
  outputs: z.record(z.string(), z.record(z.string(), z.unknown())),
  status: z
    .object({
      status_str: z.enum(['success', 'error']),
      completed: z.boolean(),
      messages: z.array(z.tuple([z.string(), z.record(z.string(), z.unknown())])),
    })
    .nullable(),
});
export type HistoryEntry = z.infer<typeof HistoryEntry>;

const PromptRejected = z.object({
  error: z.object({ type: z.string(), message: z.string() }),
  node_errors: z.record(
    z.string(),
    z.object({
      class_type: z.string().optional(),
      errors: z.array(z.object({ message: z.string(), details: z.string().optional() })),
    }),
  ),
});
type PromptRejected = z.infer<typeof PromptRejected>;

const Uploaded = z.object({ name: z.string().min(1) });
const Queue = z.object({ queue_running: z.array(z.array(z.unknown())), queue_pending: z.array(z.array(z.unknown())) });

export type Fetch = typeof fetch;

/** Thin HTTP client. Every response it reads is schema-checked; transport and shape failures are UPSTREAM. */
export class ComfyClient {
  constructor(
    private readonly baseUrl: string,
    private readonly fetchImpl: Fetch = fetch,
  ) {}

  async #request(path: string, init?: RequestInit): Promise<Response> {
    try {
      return await this.fetchImpl(`${this.baseUrl}${path}`, init);
    } catch (e) {
      throw new ProviderError(P, 'UPSTREAM', `ComfyUI unreachable at ${this.baseUrl}: ${(e as Error).message}`, e);
    }
  }

  async #json<T>(path: string, schema: z.ZodType<T>, init?: RequestInit): Promise<T> {
    const res = await this.#request(path, init);
    if (!res.ok) throw new ProviderError(P, 'UPSTREAM', `${init?.method ?? 'GET'} ${path} -> HTTP ${res.status}`);
    const parsed = schema.safeParse(await res.json());
    if (!parsed.success) {
      throw new ProviderError(P, 'UPSTREAM', `Unexpected ${path} response: ${z.prettifyError(parsed.error)}`);
    }
    return parsed.data;
  }

  systemStats(): Promise<unknown> {
    return this.#json('/system_stats', z.unknown());
  }

  /** Returns the stored filename, which may differ from `filename` on a name clash. */
  async uploadImage(bytes: Uint8Array, filename: string): Promise<string> {
    const form = new FormData();
    form.append('image', new Blob([bytes]), filename);
    form.append('overwrite', 'true');
    return (await this.#json('/upload/image', Uploaded, { method: 'POST', body: form })).name;
  }

  async queuePrompt(workflow: ApiWorkflow, promptId: string): Promise<void> {
    const res = await this.#request('/prompt', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: workflow, prompt_id: promptId }),
    });
    if (res.ok) return;
    const body: unknown = await res.json().catch(() => null);
    const rejected = PromptRejected.safeParse(body);
    if (res.status === 400 && rejected.success) {
      throw new ProviderError(P, 'INVALID_INPUT', describeRejection(workflow, rejected.data), body);
    }
    throw new ProviderError(P, 'UPSTREAM', `POST /prompt -> HTTP ${res.status}`, body);
  }

  async history(promptId: string): Promise<HistoryEntry | null> {
    const all = await this.#json(`/history/${promptId}`, z.record(z.string(), HistoryEntry));
    return all[promptId] ?? null;
  }

  async isQueued(promptId: string): Promise<boolean> {
    const q = await this.#json('/queue', Queue);
    return [...q.queue_running, ...q.queue_pending].some((item) => item[1] === promptId);
  }

  async view(file: FileRef): Promise<Uint8Array> {
    const q = new URLSearchParams({ filename: file.filename, subfolder: file.subfolder, type: file.type });
    const res = await this.#request(`/view?${q}`);
    if (!res.ok) throw new ProviderError(P, 'UPSTREAM', `GET /view ${file.filename} -> HTTP ${res.status}`);
    return new Uint8Array(await res.arrayBuffer());
  }
}

/** Names each rejected node by its title, e.g. "unet (UNETLoader): Value not in list - unet_name: 'x' not in []". */
export function describeRejection(workflow: ApiWorkflow, r: PromptRejected): string {
  const nodes = Object.entries(r.node_errors).map(([id, e]) => {
    const title = workflow[id]?._meta?.title ?? id;
    const cls = e.class_type ?? workflow[id]?.class_type ?? 'unknown';
    const msgs = e.errors.map((x) => [x.message, x.details].filter(Boolean).join(' - ')).join('; ');
    return `${title} (${cls}): ${msgs}`;
  });
  return `ComfyUI rejected the workflow (${r.error.type}): ${nodes.join(' | ') || r.error.message}`;
}

/** Deterministic canonical UUID per idempotency key, so a retry finds its own job instead of queueing another. */
export function promptIdFor(idempotencyKey: string): string {
  const h = createHash('sha256').update(`adforge:${idempotencyKey}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}
```

- [ ] **Step 5: Run tests and typecheck**

Run: `pnpm --filter @adforge/provider-comfyui test`, then `pnpm test`
Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/providers/comfyui
git commit -m "feat(comfyui): HTTP client with schema-checked responses and error mapping"
```

---

### Task 3: Job layer — idempotent submit, collect, wait

**Files:**
- Modify: `packages/core/src/providers/types.ts` (add `isRetryable`)
- Test: `packages/core/test/retryable.test.ts`
- Create: `packages/providers/comfyui/src/job.ts`
- Test: `packages/providers/comfyui/test/job.test.ts`

**Interfaces:**
- Consumes: `ComfyClient`, `FileRef`, `HistoryEntry`, `promptIdFor` (Task 2); `nodeIdByTitle`, `ApiWorkflow` (Task 1); `ProviderError`, `MediaRef`, `ProviderResult`, `StorageProvider` from core.
- Produces (core `types.ts`): `isRetryable(code: ProviderErrorCode): boolean`. It is true only for `RATE_LIMIT`, `TIMEOUT` and `UPSTREAM`.
- Produces (`src/job.ts`):
  - `interface OutputSpec { title: 'out:image' | 'out:video'; mime: 'image/png' | 'video/mp4'; width?: number; height?: number; durationSec?: (entry: HistoryEntry) => number | undefined }`
  - `submitOnce(client, workflow, idempotencyKey): Promise<string>`, which returns the promptId
  - `collect(client, storage, workflow, promptId, output: OutputSpec): Promise<ProviderResult<MediaRef>>`
  - `waitFor(poll: () => Promise<ProviderResult<MediaRef>>, opts: { timeoutMs: number; intervalMs: number; sleep?: (ms: number) => Promise<void> }): Promise<ProviderResult<MediaRef>>`
  - `pngSize(bytes): { width: number; height: number }`
  - `toFailed(e: unknown): ProviderResult<never>`

- [ ] **Step 1: Write the failing core test**

`packages/core/test/retryable.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { isRetryable } from '../src/providers/types';

describe('isRetryable', () => {
  it('retries transient failures only', () => {
    expect(isRetryable('UPSTREAM')).toBe(true);
    expect(isRetryable('TIMEOUT')).toBe(true);
    expect(isRetryable('RATE_LIMIT')).toBe(true);
    expect(isRetryable('INVALID_INPUT')).toBe(false);
    expect(isRetryable('AUTH')).toBe(false);
    expect(isRetryable('CONTENT_POLICY')).toBe(false);
    expect(isRetryable('UNKNOWN')).toBe(false);
  });
});
```

Run: `pnpm --filter @adforge/core test` → FAIL (`isRetryable` is not exported).

- [ ] **Step 2: Add `isRetryable` to core**

In `packages/core/src/providers/types.ts`, directly after the `ProviderErrorCode` type, add:
```ts
const RETRYABLE: ReadonlySet<ProviderErrorCode> = new Set(['RATE_LIMIT', 'TIMEOUT', 'UPSTREAM']);

/** One source of truth for retry policy, so `retryable` can't disagree with the error code. */
export function isRetryable(code: ProviderErrorCode): boolean {
  return RETRYABLE.has(code);
}
```

Run: `pnpm --filter @adforge/core test` → PASS.

- [ ] **Step 3: Write the failing job test**

`packages/providers/comfyui/test/job.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { ProviderError } from '@adforge/core/providers/types';
import { ComfyClient, promptIdFor, type HistoryEntry } from '../src/client';
import { collect, pngSize, submitOnce, waitFor } from '../src/job';
import { loadWorkflow } from '../src/workflows';
import { fakeFetch, fixture, json, memoryStorage, pngBytes } from './helpers';

const BASE = 'http://127.0.0.1:8188';
const plate = loadWorkflow('plate-flux-schnell').json;
const broll = loadWorkflow('broll-wan22-5b').json;
const IMAGE_OUT = { title: 'out:image', mime: 'image/png' } as const;

/** The recorded plate entry, re-keyed to `id`, with optional message overrides. */
function plateEntry(id: string, messages?: [string, Record<string, unknown>][]) {
  const rec = fixture('plate-flux-schnell.history.json') as Record<string, HistoryEntry>;
  const entry = structuredClone(Object.values(rec)[0]!);
  if (messages) entry.status = { ...entry.status!, status_str: 'error', messages };
  return { [id]: entry };
}

describe('submitOnce', () => {
  it('queues a fresh job under the id derived from the key', async () => {
    const id = promptIdFor('k1');
    const f = fakeFetch({
      [`GET /history/${id}`]: () => json({}),
      'GET /queue': () => json({ queue_running: [], queue_pending: [] }),
      'POST /prompt': () => json({ prompt_id: id, number: 1, node_errors: {} }),
    });
    expect(await submitOnce(new ComfyClient(BASE, f), plate, 'k1')).toBe(id);
    expect(f.bodies['POST /prompt']?.[0]).toMatchObject({ prompt_id: id });
  });

  it('does not queue again when the job already finished', async () => {
    const id = promptIdFor('k2');
    const f = fakeFetch({ [`GET /history/${id}`]: () => json(plateEntry(id)) });
    expect(await submitOnce(new ComfyClient(BASE, f), plate, 'k2')).toBe(id);
    expect(f.calls).not.toContain('POST /prompt');
  });

  it('does not queue again when the job is still queued', async () => {
    const id = promptIdFor('k3');
    const f = fakeFetch({
      [`GET /history/${id}`]: () => json({}),
      'GET /queue': () => json({ queue_running: [[1, id, {}]], queue_pending: [] }),
    });
    await submitOnce(new ComfyClient(BASE, f), plate, 'k3');
    expect(f.calls).not.toContain('POST /prompt');
  });
});

describe('collect', () => {
  it('downloads the output, stores it, and reports execution time', async () => {
    const id = 'p1';
    const storage = memoryStorage();
    const f = fakeFetch({
      [`GET /history/${id}`]: () => json(plateEntry(id)),
      'GET /view': () => new Response(pngBytes(768, 1344)),
    });
    const r = await collect(new ComfyClient(BASE, f), storage, plate, id, IMAGE_OUT);
    expect(r.status).toBe('done');
    if (r.status !== 'done') return;
    expect(r.value).toMatchObject({ mime: 'image/png', width: 768, height: 1344 });
    expect(r.value.url).toMatch(/^http:\/\/localhost:3000\/media\//);
    expect(r.latencyMs).toBe(1792044731145 - 1792044726228);
    expect(r.cost).toEqual({ amountUsd: 0, estimated: false });
    expect(storage.files.size).toBe(1);
  });

  it('stores video with the size and duration it is told', async () => {
    const rec = fixture('broll-wan22-5b.history.json') as Record<string, HistoryEntry>;
    const id = Object.keys(rec)[0]!;
    const f = fakeFetch({
      [`GET /history/${id}`]: () => json(rec),
      'GET /view': () => new Response(new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112])),
    });
    const r = await collect(new ComfyClient(BASE, f), memoryStorage(), broll, id, {
      title: 'out:video',
      mime: 'video/mp4',
      width: 704,
      height: 1280,
      durationSec: () => 121 / 24,
    });
    expect(r.status === 'done' && r.value).toMatchObject({ mime: 'video/mp4', width: 704, height: 1280, durationSec: 121 / 24 });
  });

  it('is pending while the job is queued', async () => {
    const f = fakeFetch({
      'GET /history/p2': () => json({}),
      'GET /queue': () => json({ queue_running: [[1, 'p2', {}]], queue_pending: [] }),
    });
    const r = await collect(new ComfyClient(BASE, f), memoryStorage(), plate, 'p2', IMAGE_OUT);
    expect(r).toMatchObject({ status: 'pending', handle: { provider: 'comfyui', externalId: 'p2' } });
  });

  it('reports a job lost to a restart as a retryable failure', async () => {
    const f = fakeFetch({
      'GET /history/p3': () => json({}),
      'GET /queue': () => json({ queue_running: [], queue_pending: [] }),
    });
    const r = await collect(new ComfyClient(BASE, f), memoryStorage(), plate, 'p3', IMAGE_OUT);
    expect(r.status === 'failed' && r.retryable).toBe(true);
    expect(r.status === 'failed' && r.error.message).toContain('neither queued nor in history');
  });

  it('does not call a job lost when it finishes between the two checks', async () => {
    let historyCalls = 0;
    const f = fakeFetch({
      'GET /history/p4': () => json(historyCalls++ === 0 ? {} : plateEntry('p4')),
      'GET /queue': () => json({ queue_running: [], queue_pending: [] }),
      'GET /view': () => new Response(pngBytes(768, 1344)),
    });
    const r = await collect(new ComfyClient(BASE, f), memoryStorage(), plate, 'p4', IMAGE_OUT);
    expect(r.status).toBe('done');
  });

  it('maps an execution error to a retryable UPSTREAM failure with the exception text', async () => {
    const f = fakeFetch({
      'GET /history/p5': () =>
        json(plateEntry('p5', [['execution_error', { node_id: '5', node_type: 'KSampler', exception_message: 'CUDA out of memory' }]])),
    });
    const r = await collect(new ComfyClient(BASE, f), memoryStorage(), plate, 'p5', IMAGE_OUT);
    expect(r.status === 'failed' && r.error.code).toBe('UPSTREAM');
    expect(r.status === 'failed' && r.retryable).toBe(true);
    expect(r.status === 'failed' && r.error.message).toContain('CUDA out of memory');
  });

  it('treats an interrupted job as not retryable', async () => {
    const f = fakeFetch({ 'GET /history/p6': () => json(plateEntry('p6', [['execution_interrupted', { node_id: '5' }]])) });
    const r = await collect(new ComfyClient(BASE, f), memoryStorage(), plate, 'p6', IMAGE_OUT);
    expect(r.status === 'failed' && r.retryable).toBe(false);
  });

  it('fails cleanly when the image output is not a PNG', async () => {
    const f = fakeFetch({
      'GET /history/p7': () => json(plateEntry('p7')),
      'GET /view': () => new Response(new Uint8Array([1, 2, 3])),
    });
    const r = await collect(new ComfyClient(BASE, f), memoryStorage(), plate, 'p7', IMAGE_OUT);
    expect(r.status === 'failed' && r.error.message).toContain('not a PNG');
  });

  it('turns an unreachable server into a retryable failure instead of throwing', async () => {
    const down = (async () => {
      throw new TypeError('fetch failed');
    }) as typeof fetch;
    const r = await collect(new ComfyClient(BASE, down), memoryStorage(), plate, 'p8', IMAGE_OUT);
    expect(r.status === 'failed' && r.retryable).toBe(true);
  });
});

describe('waitFor', () => {
  const pending = { status: 'pending', handle: { provider: 'comfyui', externalId: 'x', pollAfterMs: 1 } } as const;

  it('polls until a terminal result', async () => {
    let n = 0;
    const done = { status: 'done', value: {} as never, cost: { amountUsd: 0, estimated: false }, latencyMs: 1 } as const;
    const r = await waitFor(async () => (++n < 3 ? pending : done), { timeoutMs: 1000, intervalMs: 1, sleep: async () => {} });
    expect(r.status).toBe('done');
    expect(n).toBe(3);
  });

  it('times out as a retryable TIMEOUT', async () => {
    const r = await waitFor(async () => pending, { timeoutMs: 0, intervalMs: 1, sleep: async () => {} });
    expect(r.status === 'failed' && r.error.code).toBe('TIMEOUT');
    expect(r.status === 'failed' && r.retryable).toBe(true);
  });
});

describe('pngSize', () => {
  it('reads IHDR dimensions and rejects non-PNG bytes', () => {
    expect(pngSize(pngBytes(704, 1280))).toEqual({ width: 704, height: 1280 });
    expect(() => pngSize(new Uint8Array(30))).toThrow(ProviderError);
  });
});
```

- [ ] **Step 4: Run to verify failure**

Run: `pnpm --filter @adforge/provider-comfyui test`
Expected: FAIL. `../src/job` cannot be resolved.

- [ ] **Step 5: Implement the job layer**

`packages/providers/comfyui/src/job.ts`:
```ts
import {
  ProviderError,
  isRetryable,
  type MediaRef,
  type ProviderErrorCode,
  type ProviderResult,
  type StorageProvider,
} from '@adforge/core/providers/types';
import { FileRef, promptIdFor, type ComfyClient, type HistoryEntry } from './client';
import { nodeIdByTitle, type ApiWorkflow } from './patch';

const P = 'comfyui';

export interface OutputSpec {
  title: 'out:image' | 'out:video';
  mime: 'image/png' | 'video/mp4';
  width?: number;
  height?: number;
  durationSec?: (entry: HistoryEntry) => number | undefined;
}

export function toFailed(e: unknown): ProviderResult<never> {
  if (e instanceof ProviderError) return { status: 'failed', error: e, retryable: isRetryable(e.code) };
  throw e;
}

function failed(code: ProviderErrorCode, message: string, raw?: unknown): ProviderResult<never> {
  return toFailed(new ProviderError(P, code, message, raw));
}

/** Queue under the key's deterministic id unless that id is already finished or queued. */
export async function submitOnce(client: ComfyClient, workflow: ApiWorkflow, idempotencyKey: string): Promise<string> {
  const promptId = promptIdFor(idempotencyKey);
  if ((await client.history(promptId)) || (await client.isQueued(promptId))) return promptId;
  await client.queuePrompt(workflow, promptId);
  return promptId;
}

/** One poll: pending while queued, done once the output is in AdForge storage, failed otherwise. Never throws ProviderError. */
export async function collect(
  client: ComfyClient,
  storage: StorageProvider,
  workflow: ApiWorkflow,
  promptId: string,
  output: OutputSpec,
): Promise<ProviderResult<MediaRef>> {
  try {
    let entry = await client.history(promptId);
    if (!entry) {
      if (await client.isQueued(promptId)) {
        return { status: 'pending', handle: { provider: P, externalId: promptId, pollAfterMs: 2000 } };
      }
      // It may have finished between the two calls; only a second miss means it is truly lost.
      entry = await client.history(promptId);
      if (!entry) {
        return failed(
          'UPSTREAM',
          `ComfyUI job ${promptId} is neither queued nor in history (server restarted?); resubmit with the same idempotency key`,
        );
      }
    }

    const messages = entry.status?.messages ?? [];
    const error = messages.find(([type]) => type === 'execution_error')?.[1];
    if (error) {
      return failed(
        'UPSTREAM',
        `ComfyUI ${String(error.node_type ?? 'node')} ${String(error.node_id ?? '')} failed: ${String(error.exception_message ?? 'unknown error')}`,
        error,
      );
    }
    if (messages.some(([type]) => type === 'execution_interrupted')) {
      return { status: 'failed', error: new ProviderError(P, 'UPSTREAM', `ComfyUI job ${promptId} was interrupted`), retryable: false };
    }
    if (entry.status?.status_str !== 'success') {
      return failed('UPSTREAM', `ComfyUI job ${promptId} ended with status ${entry.status?.status_str ?? 'unknown'}`);
    }

    const file = firstFile(entry, nodeIdByTitle(workflow, output.title));
    if (!file) return failed('UPSTREAM', `ComfyUI job ${promptId} produced no file on ${output.title}`);
    const bytes = await client.view(file);
    const dims = output.mime === 'image/png' ? pngSize(bytes) : { width: output.width, height: output.height };
    const ref = await storage.put(bytes, { mime: output.mime, ...dims, durationSec: output.durationSec?.(entry) });
    return { status: 'done', value: ref, cost: { amountUsd: 0, estimated: false }, latencyMs: executionMs(messages) };
  } catch (e) {
    return toFailed(e);
  }
}

export async function waitFor(
  poll: () => Promise<ProviderResult<MediaRef>>,
  opts: { timeoutMs: number; intervalMs: number; sleep?: (ms: number) => Promise<void> },
): Promise<ProviderResult<MediaRef>> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const deadline = Date.now() + opts.timeoutMs;
  for (;;) {
    const r = await poll();
    if (r.status !== 'pending') return r;
    if (Date.now() >= deadline) {
      return failed('TIMEOUT', `ComfyUI job ${r.handle.externalId} still running after ${opts.timeoutMs}ms`);
    }
    await sleep(opts.intervalMs);
  }
}

/** Reads width/height from the PNG IHDR chunk. */
export function pngSize(bytes: Uint8Array): { width: number; height: number } {
  const sig = [137, 80, 78, 71, 13, 10, 26, 10];
  if (bytes.length < 24 || sig.some((b, i) => bytes[i] !== b)) {
    throw new ProviderError(P, 'UPSTREAM', 'ComfyUI output is not a PNG');
  }
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: v.getUint32(16), height: v.getUint32(20) };
}

/** Video save nodes also report under `images` (with `animated: [true]`), so take the first file-shaped entry. */
function firstFile(entry: HistoryEntry, nodeId: string): FileRef | undefined {
  for (const value of Object.values(entry.outputs[nodeId] ?? {})) {
    if (!Array.isArray(value)) continue;
    for (const item of value) {
      const parsed = FileRef.safeParse(item);
      if (parsed.success) return parsed.data;
    }
  }
  return undefined;
}

/** GPU execution time from the history's own timestamps (excludes queue wait). */
function executionMs(messages: [string, Record<string, unknown>][]): number {
  const at = (type: string) => messages.find(([t]) => t === type)?.[1].timestamp;
  const start = at('execution_start');
  const end = at('execution_success');
  return typeof start === 'number' && typeof end === 'number' ? end - start : 0;
}
```

- [ ] **Step 6: Run tests and typecheck**

Run: `pnpm --filter @adforge/provider-comfyui test`, then `pnpm test`
Expected: all PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/core packages/providers/comfyui
git commit -m "feat(comfyui): idempotent submit, polling collect, timeout-bounded wait"
```

---

### Task 4: Providers — image, cutout, video

**Files:**
- Create: `packages/providers/comfyui/src/providers.ts`, `packages/providers/comfyui/src/index.ts`
- Test: `packages/providers/comfyui/test/providers.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1–3; core `ImageProvider`, `CutoutProvider`, `VideoProvider`, `VideoCapabilities`, `StorageProvider`, `ProviderError`.
- Produces (`src/providers.ts`, re-exported from `src/index.ts`):
  - `interface ComfyOptions { baseUrl: string; storage: StorageProvider; plateWorkflow: string; cutoutWorkflow: string; brollWorkflow: string; fetchImpl?: Fetch; syncTimeoutMs?: number; pollIntervalMs?: number; sleep?: (ms: number) => Promise<void> }`
  - `createComfyProviders(o: ComfyOptions): { image: ImageProvider; cutout: CutoutProvider; video: VideoProvider; client: ComfyClient; workflowHashes: Record<string, string> }`. It throws at construction on an unknown workflow name or a manifest/JSON title mismatch.
- `src/index.ts` exports: `createComfyProviders`, `ComfyOptions`, `ComfyClient`, `promptIdFor`.

- [ ] **Step 1: Write the failing test**

`packages/providers/comfyui/test/providers.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { ProviderError, type VideoGenRequest } from '@adforge/core/providers/types';
import { promptIdFor } from '../src/client';
import { createComfyProviders } from '../src/providers';
import { fakeFetch, fixture, json, memoryStorage, pngBytes } from './helpers';

const BASE = 'http://127.0.0.1:8188';
const opts = {
  baseUrl: BASE,
  plateWorkflow: 'plate-flux-schnell',
  cutoutWorkflow: 'cutout-birefnet',
  brollWorkflow: 'broll-wan22-5b',
  sleep: async () => {},
  pollIntervalMs: 1,
};
const empty = { queue_running: [], queue_pending: [] };

/** Serves a fresh job: not found → queued → finished with the recorded entry for `name`. */
function jobRoutes(key: string, name: string, viewBytes: Uint8Array) {
  const id = promptIdFor(key);
  const rec = fixture(`${name}.history.json`) as Record<string, unknown>;
  let submitted = false;
  return {
    [`GET /history/${id}`]: () => json(submitted ? { [id]: Object.values(rec)[0] } : {}),
    'GET /queue': () => json(empty),
    'POST /prompt': () => {
      submitted = true;
      return json({ prompt_id: id, number: 1, node_errors: {} });
    },
    'GET /view': () => new Response(viewBytes),
  };
}

describe('createComfyProviders', () => {
  it('fails at construction on an unknown workflow', () => {
    expect(() => createComfyProviders({ ...opts, storage: memoryStorage(), plateWorkflow: 'plate-sdxl' })).toThrow(
      'Unknown plate workflow "plate-sdxl"',
    );
  });

  it('exposes workflow file hashes for the job config snapshot', () => {
    const { workflowHashes } = createComfyProviders({ ...opts, storage: memoryStorage() });
    expect(Object.keys(workflowHashes).sort()).toEqual(['broll-wan22-5b', 'cutout-birefnet', 'plate-flux-schnell']);
    expect(workflowHashes['plate-flux-schnell']).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('image provider', () => {
  it('patches the plate workflow, waits, and returns an internal MediaRef', async () => {
    const f = fakeFetch(jobRoutes('img1', 'plate-flux-schnell', pngBytes(768, 1344)));
    const { image } = createComfyProviders({ ...opts, storage: memoryStorage(), fetchImpl: f });
    const r = await image.generate({ prompt: 'a kitchen', width: 768, height: 1344, idempotencyKey: 'img1' });
    expect(r.status).toBe('done');
    expect(r.status === 'done' && r.value).toMatchObject({ mime: 'image/png', width: 768, height: 1344 });
    const body = f.bodies['POST /prompt']?.[0] as { prompt: Record<string, { inputs: Record<string, unknown>; _meta: { title: string } }> };
    const byTitle = (t: string) => Object.values(body.prompt).find((n) => n._meta.title === t)!.inputs;
    expect(byTitle('in:prompt').text).toBe('a kitchen');
    expect(byTitle('in:size')).toMatchObject({ width: 768, height: 1344 });
  });

  it('derives the same seed from the same key when none is given', async () => {
    const seeds: unknown[] = [];
    for (let run = 0; run < 2; run++) {
      const f = fakeFetch(jobRoutes('seed-key', 'plate-flux-schnell', pngBytes(768, 1344)));
      const { image } = createComfyProviders({ ...opts, storage: memoryStorage(), fetchImpl: f });
      await image.generate({ prompt: 'p', width: 768, height: 1344, idempotencyKey: 'seed-key' });
      const body = f.bodies['POST /prompt']?.[0] as { prompt: Record<string, { inputs: { seed?: unknown }; _meta: { title: string } }> };
      seeds.push(Object.values(body.prompt).find((n) => n._meta.title === 'in:seed')!.inputs.seed);
    }
    expect(seeds[0]).toBe(seeds[1]);
    expect(typeof seeds[0]).toBe('number');
  });

  it('a retry with the same key returns the first job instead of rendering again', async () => {
    const f = fakeFetch(jobRoutes('img2', 'plate-flux-schnell', pngBytes(768, 1344)));
    const { image } = createComfyProviders({ ...opts, storage: memoryStorage(), fetchImpl: f });
    await image.generate({ prompt: 'p', width: 768, height: 1344, idempotencyKey: 'img2' });
    await image.generate({ prompt: 'p', width: 768, height: 1344, idempotencyKey: 'img2' });
    expect(f.calls.filter((c) => c === 'POST /prompt')).toHaveLength(1);
  });

  it('rejects an invalid size before any network call', async () => {
    const f = fakeFetch({});
    const { image } = createComfyProviders({ ...opts, storage: memoryStorage(), fetchImpl: f });
    const r = await image.generate({ prompt: 'p', width: 770, height: 1344, idempotencyKey: 'img3' });
    expect(r.status === 'failed' && r.error.code).toBe('INVALID_INPUT');
    expect(r.status === 'failed' && r.retryable).toBe(false);
    expect(f.calls).toEqual([]);
  });

  it('times out as retryable TIMEOUT when the job never finishes', async () => {
    const id = promptIdFor('img4');
    const f = fakeFetch({
      [`GET /history/${id}`]: () => json({}),
      'GET /queue': () => json({ queue_running: [[1, id, {}]], queue_pending: [] }),
    });
    const { image } = createComfyProviders({ ...opts, storage: memoryStorage(), fetchImpl: f, syncTimeoutMs: 0 });
    const r = await image.generate({ prompt: 'p', width: 768, height: 1344, idempotencyKey: 'img4' });
    expect(r.status === 'failed' && r.error.code).toBe('TIMEOUT');
  });
});

describe('cutout provider', () => {
  it('uploads the stored photo and uses the name ComfyUI returned', async () => {
    const storage = memoryStorage();
    const photo = await storage.put(pngBytes(768, 1344), { mime: 'image/png' });
    const routes = jobRoutes('cut1', 'cutout-birefnet', pngBytes(768, 1344));
    const f = fakeFetch({
      ...routes,
      'POST /upload/image': async (req) => {
        expect(((await req.formData()).get('image') as File).name).toBe(`${photo.sha256}.png`);
        return json({ name: `${photo.sha256} (1).png`, subfolder: '', type: 'input' });
      },
    });
    const { cutout } = createComfyProviders({ ...opts, storage, fetchImpl: f });
    const r = await cutout.cutout({ image: photo, idempotencyKey: 'cut1' });
    expect(r.status).toBe('done');
    const body = f.bodies['POST /prompt']?.[0] as { prompt: Record<string, { inputs: { image?: unknown }; _meta: { title: string } }> };
    expect(Object.values(body.prompt).find((n) => n._meta.title === 'in:image')!.inputs.image).toBe(`${photo.sha256} (1).png`);
  });

  it('rejects a non-image input', async () => {
    const storage = memoryStorage();
    const clip = await storage.put(new Uint8Array([1]), { mime: 'video/mp4' });
    const { cutout } = createComfyProviders({ ...opts, storage, fetchImpl: fakeFetch({}) });
    const r = await cutout.cutout({ image: clip, idempotencyKey: 'cut2' });
    expect(r.status === 'failed' && r.error.code).toBe('INVALID_INPUT');
  });
});

describe('video provider', () => {
  const frame = { id: 'ab/x.png', url: 'u', mime: 'image/png', sha256: 'x', bytes: 1 };
  const valid: VideoGenRequest = {
    mode: 'image_to_video',
    prompt: 'drifting light',
    firstFrame: frame,
    durationSec: 5,
    aspectRatio: '9:16',
    resolution: '720p',
    idempotencyKey: 'vid1',
  };

  it('declares only what the workflow can do', () => {
    const { video } = createComfyProviders({ ...opts, storage: memoryStorage() });
    expect(video.capabilities).toMatchObject({ modes: ['image_to_video'], resolutions: ['720p'], maxDurationSec: 5 });
  });

  for (const [label, patch] of [
    ['text_to_video mode', { mode: 'text_to_video' }],
    ['16:9 aspect', { aspectRatio: '16:9' }],
    ['6s duration', { durationSec: 6 }],
    ['missing first frame', { firstFrame: undefined }],
  ] as const) {
    it(`throws INVALID_INPUT before dispatch for ${label}`, async () => {
      const f = fakeFetch({});
      const { video } = createComfyProviders({ ...opts, storage: memoryStorage(), fetchImpl: f });
      const err = await video.submit({ ...valid, ...patch } as VideoGenRequest).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ProviderError);
      expect((err as ProviderError).code).toBe('INVALID_INPUT');
      expect(f.calls).toEqual([]);
    });
  }

  it('submits 121 frames at 704x1280 for 5s and polls to a stored mp4', async () => {
    const storage = memoryStorage();
    const ref = await storage.put(pngBytes(768, 1344), { mime: 'image/png' });
    const f = fakeFetch({
      ...jobRoutes('vid1', 'broll-wan22-5b', new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112])),
      'POST /upload/image': () => json({ name: 'frame.png', subfolder: '', type: 'input' }),
    });
    const { video } = createComfyProviders({ ...opts, storage, fetchImpl: f });
    const handle = await video.submit({ ...valid, firstFrame: ref });
    expect(handle).toMatchObject({ provider: 'comfyui', externalId: promptIdFor('vid1') });
    const body = f.bodies['POST /prompt']?.[0] as { prompt: Record<string, { inputs: Record<string, unknown>; _meta: { title: string } }> };
    expect(Object.values(body.prompt).find((n) => n._meta.title === 'in:size')!.inputs).toMatchObject({
      width: 704,
      height: 1280,
      length: 121,
    });
    const r = await video.poll(handle);
    expect(r.status === 'done' && r.value).toMatchObject({ mime: 'video/mp4', width: 704, height: 1280 });
    expect(r.status === 'done' && r.value.durationSec).toBeCloseTo(121 / 24, 5);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @adforge/provider-comfyui test`
Expected: FAIL. `../src/providers` cannot be resolved.

- [ ] **Step 3: Implement the providers**

`packages/providers/comfyui/src/providers.ts`:
```ts
import { z } from 'zod';
import {
  ProviderError,
  type CutoutProvider,
  type ImageProvider,
  type JobHandle,
  type MediaRef,
  type ProviderResult,
  type StorageProvider,
  type VideoCapabilities,
  type VideoProvider,
} from '@adforge/core/providers/types';
import { ComfyClient, promptIdFor, type Fetch, type HistoryEntry } from './client';
import { collect, submitOnce, toFailed, waitFor, type OutputSpec } from './job';
import { nodeIdByTitle, patchWorkflow, type ApiWorkflow } from './patch';
import {
  BROLL_WORKFLOWS,
  BrollParams,
  CUTOUT_WORKFLOWS,
  CutoutParams,
  PLATE_WORKFLOWS,
  PlateParams,
  assertManifestMatches,
  loadWorkflow,
  pickWorkflow,
  type Manifest,
} from './workflows';

const P = 'comfyui';
const IMAGE_EXT: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };

export interface ComfyOptions {
  baseUrl: string;
  storage: StorageProvider;
  plateWorkflow: string;
  cutoutWorkflow: string;
  brollWorkflow: string;
  fetchImpl?: Fetch;
  /** How long image/cutout calls wait for their result. Default 120s. */
  syncTimeoutMs?: number;
  /** Poll interval for image/cutout waits. Default 1s. */
  pollIntervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

const invalid = (message: string): ProviderResult<never> => ({
  status: 'failed',
  error: new ProviderError(P, 'INVALID_INPUT', message),
  retryable: false,
});

/** No seed given → derive one from the key, so retries reproduce the same pixels. */
const seedFor = (key: string): number => Number.parseInt(promptIdFor(`seed:${key}`).slice(0, 8), 16);

function load<Params>(table: Record<string, Manifest<Params>>, name: string, role: string) {
  const manifest = pickWorkflow(table, name, role);
  const { json, sha256 } = loadWorkflow(manifest.name);
  assertManifestMatches(json, manifest);
  return { manifest, json, sha256 };
}

export function createComfyProviders(o: ComfyOptions): {
  image: ImageProvider;
  cutout: CutoutProvider;
  video: VideoProvider;
  client: ComfyClient;
  workflowHashes: Record<string, string>;
} {
  const client = new ComfyClient(o.baseUrl, o.fetchImpl);
  const plate = load(PLATE_WORKFLOWS, o.plateWorkflow, 'plate');
  const cut = load(CUTOUT_WORKFLOWS, o.cutoutWorkflow, 'cutout');
  const broll = load(BROLL_WORKFLOWS, o.brollWorkflow, 'broll');
  const wait = { timeoutMs: o.syncTimeoutMs ?? 120_000, intervalMs: o.pollIntervalMs ?? 1000, sleep: o.sleep };

  const runSync = async (wf: ApiWorkflow, key: string, output: OutputSpec): Promise<ProviderResult<MediaRef>> => {
    try {
      const promptId = await submitOnce(client, wf, key);
      return await waitFor(() => collect(client, o.storage, wf, promptId, output), wait);
    } catch (e) {
      return toFailed(e);
    }
  };

  const upload = async (ref: MediaRef): Promise<string> => {
    const ext = IMAGE_EXT[ref.mime];
    if (!ext) throw new ProviderError(P, 'INVALID_INPUT', `Unsupported image type for ComfyUI input: ${ref.mime}`);
    return client.uploadImage(await o.storage.read(ref.id), `${ref.sha256}.${ext}`);
  };

  const image: ImageProvider = {
    id: P,
    async generate(req) {
      const params = PlateParams.safeParse({
        prompt: req.prompt,
        seed: req.seed ?? seedFor(req.idempotencyKey),
        width: req.width,
        height: req.height,
      });
      if (!params.success) return invalid(`Invalid plate request: ${z.prettifyError(params.error)}`);
      return runSync(patchWorkflow(plate.json, plate.manifest.toPatches(params.data)), req.idempotencyKey, plate.manifest.output);
    },
  };

  const cutout: CutoutProvider = {
    id: P,
    async cutout(req) {
      try {
        const params = CutoutParams.parse({ image: await upload(req.image) });
        return await runSync(patchWorkflow(cut.json, cut.manifest.toPatches(params)), req.idempotencyKey, cut.manifest.output);
      } catch (e) {
        return toFailed(e);
      }
    },
  };

  const fps = broll.manifest.fps ?? 24;
  const size = broll.manifest.size ?? { width: 704, height: 1280 };
  const maxDurationSec = 5;
  const sizeNodeId = nodeIdByTitle(broll.json, 'in:size');
  const brollOutput: OutputSpec = {
    ...broll.manifest.output,
    ...size,
    durationSec: (entry: HistoryEntry) => {
      const workflow = entry.prompt[2] as ApiWorkflow | undefined;
      const length = workflow?.[sizeNodeId]?.inputs.length;
      return typeof length === 'number' ? length / fps : undefined;
    },
  };
  const capabilities: VideoCapabilities = {
    modes: ['image_to_video'],
    maxDurationSec,
    resolutions: ['720p'],
    typicalLatencyMs: 275_000,
  };

  const video: VideoProvider = {
    id: P,
    capabilities,
    async submit(req): Promise<JobHandle> {
      const reject = (why: string) => new ProviderError(P, 'INVALID_INPUT', `Unsupported b-roll request: ${why}`);
      if (req.mode !== 'image_to_video') throw reject(`mode ${req.mode}`);
      if (req.aspectRatio !== '9:16' || req.resolution !== '720p') throw reject(`${req.aspectRatio} at ${req.resolution}`);
      if (!req.firstFrame) throw reject('firstFrame is required');
      if (!(req.durationSec > 0 && req.durationSec <= maxDurationSec)) throw reject(`durationSec ${req.durationSec}`);
      const length = Math.max(1, Math.round((req.durationSec * fps) / 4)) * 4 + 1;
      const params = BrollParams.safeParse({
        prompt: req.prompt,
        seed: req.seed ?? seedFor(req.idempotencyKey),
        image: 'pending-upload.png',
        ...size,
        length,
      });
      if (!params.success) throw reject(z.prettifyError(params.error));
      const imageName = await upload(req.firstFrame);
      const wf = patchWorkflow(broll.json, broll.manifest.toPatches({ ...params.data, image: imageName }));
      const promptId = await submitOnce(client, wf, req.idempotencyKey);
      return { provider: P, externalId: promptId, pollAfterMs: 15_000 };
    },
    poll(handle) {
      return collect(client, o.storage, broll.json, handle.externalId, brollOutput);
    },
  };

  return {
    image,
    cutout,
    video,
    client,
    workflowHashes: {
      [plate.manifest.name]: plate.sha256,
      [cut.manifest.name]: cut.sha256,
      [broll.manifest.name]: broll.sha256,
    },
  };
}
```

`packages/providers/comfyui/src/index.ts`:
```ts
export { ComfyClient, promptIdFor } from './client';
export { createComfyProviders, type ComfyOptions } from './providers';
```

- [ ] **Step 4: Run tests and typecheck**

Run: `pnpm --filter @adforge/provider-comfyui test`, then `pnpm test`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/providers/comfyui
git commit -m "feat(comfyui): image, cutout and video providers over the job layer"
```

---

### Task 5: Live smoke check + ADR 0007

**Files:**
- Create: `packages/providers/comfyui/src/smoke.ts`
- Create: `docs/decisions/0007-comfyui-adapter-job-model.md`

**Interfaces:**
- Consumes: `createComfyProviders` (Task 4); `LocalDiskStorage` from `@adforge/provider-local-storage`; `parseEnv`, `REPO_ROOT` from `@adforge/core/config/env`.
- Produces: the `pnpm smoke:comfy [runId]` command. It runs plate → product shot → cutout → b-roll live, and prints each `MediaRef` and its latency.

- [ ] **Step 1: Write the smoke script**

`packages/providers/comfyui/src/smoke.ts`:
```ts
import { join } from 'node:path';
import { REPO_ROOT, parseEnv } from '@adforge/core/config/env';
import type { MediaRef, ProviderResult } from '@adforge/core/providers/types';
import { LocalDiskStorage } from '@adforge/provider-local-storage';
import { createComfyProviders } from './providers';

/**
 * Live end-to-end check against a running ComfyUI (scripts/comfyui.ps1). Not part of `pnpm test`.
 * Same runId → same idempotency keys → ComfyUI returns cached results. Pass a new runId to render fresh.
 */
try {
  process.loadEnvFile(join(REPO_ROOT, '.env'));
} catch (e) {
  if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
}
const env = parseEnv(process.env);
const runId = process.argv[2] ?? 'v1';
const storage = new LocalDiskStorage(join(env.ADFORGE_DATA_DIR, 'media'), env.ADFORGE_PUBLIC_URL);
const comfy = createComfyProviders({
  baseUrl: env.COMFYUI_URL,
  storage,
  plateWorkflow: env.ADFORGE_COMFY_WORKFLOW_PLATE,
  cutoutWorkflow: env.ADFORGE_COMFY_WORKFLOW_CUTOUT,
  brollWorkflow: env.ADFORGE_COMFY_WORKFLOW_BROLL,
});

function expectDone(step: string, r: ProviderResult<MediaRef>): MediaRef {
  if (r.status !== 'done') {
    console.error(`FAIL ${step}:`, r.status === 'failed' ? `${r.error.code} ${r.error.message}` : 'still pending');
    process.exit(1);
  }
  console.log(`ok   ${step.padEnd(8)} ${(r.latencyMs / 1000).toFixed(1)}s  ${r.value.mime} ${r.value.width}x${r.value.height}  ${r.value.url}`);
  return r.value;
}

await comfy.client.systemStats();
console.log(`ComfyUI up at ${env.COMFYUI_URL}; storage ${join(env.ADFORGE_DATA_DIR, 'media')}; run ${runId}`);

const plate = expectDone(
  'plate',
  await comfy.image.generate({
    prompt: 'warm natural daylight, real lived-in kitchen interior, wooden countertop, empty surface in the foreground',
    width: 768,
    height: 1344,
    idempotencyKey: `smoke:${runId}:plate`,
  }),
);
const product = expectDone(
  'product',
  await comfy.image.generate({
    prompt: 'studio product photo of a single amber glass bottle with a plain paper label, isolated on a pure white background',
    width: 768,
    height: 1344,
    idempotencyKey: `smoke:${runId}:product`,
  }),
);
expectDone('cutout', await comfy.cutout.cutout({ image: product, idempotencyKey: `smoke:${runId}:cutout` }));

const handle = await comfy.video.submit({
  mode: 'image_to_video',
  prompt: 'slow drifting warm sunlight, soft dust particles in the air, subtle ambient motion, static camera',
  firstFrame: plate,
  durationSec: 5,
  aspectRatio: '9:16',
  resolution: '720p',
  idempotencyKey: `smoke:${runId}:broll`,
});
console.log(`...  broll    submitted ${handle.externalId}, polling every ${handle.pollAfterMs / 1000}s`);
const deadline = Date.now() + 15 * 60_000;
let r = await comfy.video.poll(handle);
while (r.status === 'pending' && Date.now() < deadline) {
  await new Promise((res) => setTimeout(res, handle.pollAfterMs));
  r = await comfy.video.poll(handle);
}
const clip = expectDone('broll', r);
console.log(`     broll duration ${clip.durationSec?.toFixed(2)}s`);
console.log('SMOKE OK');
```

- [ ] **Step 2: Typecheck, then run live**

Run: `pnpm test`
Expected: all PASS. The smoke file typechecks; it is not executed by the tests.

Make sure ComfyUI is running (`powershell -ExecutionPolicy Bypass -File scripts/comfyui.ps1`, or check `curl http://127.0.0.1:8188/system_stats`).

Run: `pnpm smoke:comfy p2-check`
Expected:
- An `ok` line for each of `plate`, `product`, `cutout` and `broll`.
- `broll duration 5.04s`, then `SMOKE OK`.
- The files exist under `<ADFORGE_DATA_DIR>/media/`.

Then run `pnpm smoke:comfy p2-check` again. Expected: the same `url`s, with near-zero b-roll time, because same keys mean no re-render. Paste both outputs into the report.

- [ ] **Step 3: Write ADR 0007**

`docs/decisions/0007-comfyui-adapter-job-model.md`:
```markdown
# 0007 — ComfyUI adapter job model

**Status:** accepted · 2026-10-15

## Context
ComfyUI has no notion of our idempotency keys, keeps history only in memory, and plates and cutouts take seconds while b-roll takes minutes (ADR 0002). Inngest will retry failed steps (P7), so a retry must never render twice.

## Decision
- **Idempotency:**
  - The `prompt_id` is a canonical UUID derived from the idempotency key. Before queueing, the adapter checks `/history` and `/queue` for that id and queues only when it is in neither.
  - A missing seed is derived from the key the same way, so retries reproduce identical pixels.
- **Sync vs async:**
  - `ImageProvider.generate` and `CutoutProvider.cutout` wait for the result, bounded by `syncTimeoutMs` (default 120s).
  - `VideoProvider` is submit/poll with a 15s poll hint.
- **Retry policy lives in core:** `isRetryable(code)` covers `UPSTREAM`, `TIMEOUT` and `RATE_LIMIT`, and every adapter result derives `retryable` from it. The one exception is an interrupted job, which a user cancelled.
- **Lost jobs:** a job is "lost" only after two history misses around a queue miss. It is a retryable failure, and the retry resubmits under the same id.
- **Latency:** this is execution time taken from ComfyUI's own `execution_start` and `execution_success` timestamps, excluding queue wait. Cost is $0 and not estimated, since this is local GPU.
- **Video duration:** read back from the `length` input in the history's own copy of the workflow, so the reported duration is what actually ran.

## Consequences
- A timed-out image call can be retried safely: it re-finds the same job.
- Workflow JSON hashes are exposed for `jobs.configSnapshot`. The hash covers bytes on disk, so the CRLF/LF checkout style changes it across OSes.
- Swapping to a hosted provider later means implementing the same three core interfaces. Callers stay unchanged.
```

- [ ] **Step 4: Commit**

```bash
git add packages/providers/comfyui/src/smoke.ts docs/decisions/0007-comfyui-adapter-job-model.md
git commit -m "feat(comfyui): live smoke check and ADR 0007 job model"
```

**P2 exit check:**
- `pnpm test` is green, with no ComfyUI needed.
- `pnpm smoke:comfy` writes a plate, a product shot, a cutout and a b-roll clip into storage.
- A second run with the same `runId` returns the same files without re-rendering.
- Golden files and fixtures are committed.
