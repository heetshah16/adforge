# C2: Editable Composition and Recipe Cache Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** an ad becomes an editable project, a base generation plus a log of edit operations, compiled deterministically into `VideoSpec` v2.
- Every generated asset has a content-addressed recipe.
- An edit regenerates only what its operation invalidates. A layout edit regenerates nothing; a VO edit regenerates one line's TTS and alignment, then re-flows.
- The review page previews the compiled composition in the browser.

**Architecture:**
- **`packages/core/src/project/`** is pure. It holds `Project` (base and ops), the `EditOp` union, `compileProject` (base, ops, current beat assets → `VideoSpec` v2) and `classifyEdit`. `buildSpec` becomes `compileProject` with no ops.
- **`packages/core/src/recipe/`** is pure. `Recipe` and `recipeKey` give a sha256 of canonical JSON, with `orgId` inside, and `RecipeGraph` maps ops to invalidated asset tags.
- **Database:** two new tables, `recipes` and `variant_revisions`. Revision 0 is written by `generateAds`.
- **Inngest:** `adforge/variant.edit` (executor) and `adforge/variant.export` (render).
- **Renderer:** composes only v2; v1 specs pass through `upgradeSpec`.
- **Preview:** `@hyperframes/player` mounts the same composition HTML, with assets served from `/media/*`.

**Tech Stack:** TypeScript, Zod 4, Drizzle (PGlite tests, Postgres prod), Inngest 4.21.1, HyperFrames 0.8.106 (+ `@hyperframes/player` 0.8.106, exact), Next.js 16.3.8, Vitest.

**Spec:** `docs/superpowers/specs/2026-10-17-creative-engine-v2-design.md` §4.5–§4.6 and §5 (C2 exit criteria), plus the roadmap `docs/superpowers/plans/2026-10-17-bridge-roadmap.md` §C2, whose fixed interfaces this plan honours (amendments below). `docs/architecture.md` wins where neither says otherwise.

## Amendments to the roadmap (ADR 0019 records them)

1. **VideoSpec stays frames-only.** Cue-bound reveals (`reveal: { cue, offsetFrames }`) live in the **project** layer. `compileProject` resolves them into an absolute `revealFrame` on each `VideoSpec` v2 element (architecture rule: all timing in frames).
2. **Task order:** revisions and lock (roadmap T4) come before the executor (roadmap T3), because the executor reads and writes revisions.
3. **Structural edits** (`setField path 'format'`) are classified and stored, but **not executed in C2.** Their executor arrives with Director v2 (C3). `POST` of a structural op returns 422 `structural edits arrive with Director v2`. The dropped-edits mechanism, ops whose target layer no longer exists, is built and tested now.
4. **The e2e is GPU-light**, per the user's rule (2026-10-19) that the full `e2e:pipeline` waits for the end of development:
   - `e2e:edit` builds revision 0 from the C1 library photo and cutout plus a code-generated plate;
   - it runs one real TTS and one real alignment for the base;
   - it then applies three ops through the API.

   It needs no ComfyUI.
5. **Preview assets** come from `storage.urlFor(key)`: `/media/*` under r2 (B3) and the worker URL in dev. This is not the "worker storage URL" of spec §4.6, which predates B3.
6. **Revision 0 is created `locked: true`,** so today's generate-then-approve flow keeps working. An edit creates an unlocked child, and approve requires the variant's **current** revision to be locked.

## Global Constraints

- **Timing:** all timing is in frames, and the `VideoSpec` IR never holds seconds or cues. Seconds become frames only in `compileProject` (the former `buildSpec` rule).
- **Asset references:** layers reference storage keys, never URLs.
- **Async rendering:** no synchronous render path. Export goes through Inngest.
- **Render-coupled vocabulary is closed Zod enums:**
  - element layer `type`: `plate | broll | product | headline | stat | chip | badge | cta_button | logo`;
  - `transitionIn`: only `cut` in C2 (C4 adds values by PR);
  - `motion`: unchanged.

  Adding a value is a PR.
- **Recipe keys include `orgId`.** The same request in two orgs gives two keys, and a cache hit never crosses orgs.
- **Tenancy:** every new table has `org_id`, RLS and narrowed grants, following ADR 0015 and migration 0009 patterns. Writes come from the worker's owner connection, and users get SELECT only, plus the revision routes, which go through `withUser`.
- **Pins:** exact versions, at least 14 days old, never ranges. `@hyperframes/player` must equal the pinned `@hyperframes/*` version (0.8.106).
- **Tests:**
  - `pnpm test` stays offline: no GPU, no network, no subscription;
  - render tests are 240×426, 5 frames;
  - golden files are used for compiled specs.
- **LLM:** no LLM is called by any C2 code path.
- **Git:**
  - commit with `git -c user.name=heetshah16 -c user.email=shahheet85@gmail.com` and a `Co-Authored-By` trailer naming the implementing model;
  - stage specific paths;
  - never commit `.env*`, `fixtures/eval-products/`, `.superpowers/` or media;
  - push only after the milestone's final review.
- **Workflow:** ADR `docs/decisions/0019-c2-editable-composition.md`.

## Review Focus

1. **A cache hit across orgs:** two orgs with byte-identical TTS requests. Expected: different recipe keys; the second org's edit calls the provider.
   - Test: Task 2.
2. **An op whose target layer is gone:** for example a `move` on `s3.headline` after the variant has 3 scenes, or an op on a layer removed by a later op. Expected: the op is skipped, listed in `dropped`, and never throws.
   - Test: Task 1.
3. **A VO edit that lengthens a line:**
   - the scene grows;
   - every later scene, voice track and caption shifts;
   - word-cued reveals follow their word;
   - scene-cued reveals keep their offset;
   - nothing overlaps.

   Test: Task 1 (compile) and Task 4 (executor).
4. **An edit posted to a locked revision, or approve on an unlocked current revision.** Expected: 409, and nothing written.
   - Test: Task 3.
5. **Two edits posted from the same parent at once.** Expected: two sibling revisions, no lost op; the variant's current revision is the later-created one; each revision's ops are immutable.
   - Test: Task 3.

## File map

| File | Responsibility | Task |
|---|---|---|
| `packages/core/src/spec/video-spec.ts` | `VideoSpec` v2 schema (and the frozen v1 schema as `VideoSpecV1`) | 1 |
| `packages/core/src/spec/upgrade-spec.ts` | `upgradeSpec(v1) → v2` | 1 |
| `packages/core/src/project/{types,compile,classify}.ts` | `Project`, `EditOp`, `Cue`, `compileProject`, `classifyEdit` | 1 |
| `packages/core/src/spec/build-spec.ts` | becomes a thin wrapper: `compileProject({ base, ops: [] }, beats).spec` | 1 |
| `packages/renderer-hyperframes/src/compose.ts` | composes v2 elements, with `revealFrame` applied, and an `assetUrl` option | 1 |
| `packages/core/src/recipe/{recipe,graph}.ts` | `Recipe`, `recipeKey`, `RecipeGraph` | 2 |
| `packages/db/src/schema.ts` + `drizzle/0016_*.sql` | `recipes` table, RLS, grants | 2 |
| `packages/pipeline/src/heavy.ts`, `record.ts` | record a recipe per generated asset | 2 |
| `packages/db/src/schema.ts` + `drizzle/0017_*.sql` | `variant_revisions`, `variants.project_base`, RLS, grants | 3 |
| `apps/web/app/api/variants/[id]/revisions/...`, `apps/web/lib/server/revisions-api.ts`, `apps/web/lib/data/jobs.ts` (approve) | revision, lock and unlock routes; approve requires lock | 3 |
| `packages/pipeline/src/edit.ts`, `inngest.ts` | executor `adforge/variant.edit`, export `adforge/variant.export` | 4 |
| `apps/web/app/jobs/[id]/preview.tsx`, `apps/web/lib/preview.ts` | in-browser preview | 5 |
| `docs/decisions/0019-c2-editable-composition.md`, `docs/architecture.md` §5 note | ADR | 6 |
| `apps/worker/src/e2e-edit.ts`, `package.json` script `e2e:edit` | the one e2e | E2e |

---

### Task 1: VideoSpec v2, upgradeSpec, Project, EditOp, compileProject, classifyEdit (Opus implements, Opus reviews)

**Files:**
- Modify: `packages/core/src/spec/video-spec.ts`, `packages/core/src/spec/build-spec.ts`, `packages/renderer-hyperframes/src/compose.ts`, `packages/renderer-hyperframes/src/render.ts` (accept v2 only; v1 callers upgrade first)
- Create: `packages/core/src/spec/upgrade-spec.ts`, `packages/core/src/project/{types,compile,classify,index}.ts`
- Test: `packages/core/test/project-compile.test.ts`, `packages/core/test/upgrade-spec.test.ts`, `packages/core/test/golden/compile-*.json`, `packages/renderer-hyperframes/test/v2-identity.test.ts`

**Interfaces:**
- **Produces (core):**
  - `Box = { x, y, w, h }` (fractions, `0 ≤ x,y`, `w,h > 0`, `x + w ≤ 1`, `y + h ≤ 1`).
  - `ElementLayer`, a discriminated union on `type`. Every element has `layerId` (`/^[a-z0-9_.:-]{1,64}$/`), `box`, `z` (int) and `revealFrame` (Frame, absolute).
    - `plate { key }`, `broll { key, trimStartFrame }`, `product { key, shadow }`, `logo { key }`;
    - text elements `headline | stat | chip | badge | cta_button { content (1–60 chars), style: { weight: TextWeight, scrim: boolean } }`.
  - `Scene` v2 = `{ startFrame, durationInFrames, motion, transitionIn: 'cut', layers: ElementLayer[] }`.
  - `VideoSpec` v2 = `{ version: 2, id, width, height, fps: 30, durationInFrames, theme, scenes, audio: { voice[], music: Track[], sfx: Track[] }, captions: { position, style: { weight }, words } }`.
    - `Track = { key, startFrame, durationInFrames, gainDb: number }`.
    - `music` and `sfx` are empty in C2.
    - All v1 superRefine rules are carried over: background first (plate/broll), at most one broll and never with a plate, broll ⇒ static, contiguous scenes, voice and words inside the video, no overlapping words.
    - New rules: `revealFrame` must lie inside its scene; layer ids are unique across the spec.
  - `VideoSpecV1` (the current schema, frozen) and `upgradeSpec(v1: VideoSpecV1): VideoSpec`.
  - `Cue = { kind: 'scene'; offsetFrames: number } | { kind: 'word'; word: number; offsetFrames: number }` (`word` indexes this scene's VO words).
  - `EditOp`, discriminated on `op`:
    - `move { layerId, x, y }`
    - `resize { layerId, w, h }`
    - `setText { layerId, content }`
    - `setStyle { layerId, style: { weight?, scrim?, position? } }` (`position` only for `layerId: 'captions'`)
    - `retime { layerId, reveal: Cue }`
    - `setField { beat, path: 'vo' | 'emotion' | 'scene' | 'format', value: string }`
    - `regenerate { assetTag: string }` (`plate:<beat>` | `voice:<beat>`)
    - `lock {}` and `unlock {}`
  - `ProjectBase = { id: string; variant: DirectorVariant; theme: { primary; accent } }`, and `Project = { base: ProjectBase; ops: EditOp[] }`.
  - `compileProject(project: Project, beats: BeatAssets[], cfg?: PipelineConfig): { spec: VideoSpec; dropped: EditOp[] }`. It is pure. `BeatAssets` is the existing type from build-spec.
  - `classifyEdit(op: EditOp): 'free' | 'voice' | 'shot' | 'structural'`.
  - Layer ids from the base: `s<i>.plate`, `s<i>.broll`, `s<i>.product` and `s<i>.headline` (the Director `overlay`). The captions target is `captions`.
- **Rules `compileProject` applies:**
  - The base layout reproduces today's `buildSpec`. The product box comes from `cfg.composite[prominence]`, using the upgrade mapping below. The headline box comes from its `TextPosition`.
  - Base reveals: every element is cued `{ kind: 'scene', offsetFrames: 0 }`.
  - Ops apply in order. An op whose `layerId` doesn't exist at that point is dropped.
  - `setField 'vo' | 'emotion' | 'scene'` and `regenerate` don't change the compiled layout; their effect arrives through new `beats` from the executor.
  - Word cues resolve against that scene's words. When the word index is beyond the words, fall back to scene start and list the op in `dropped`.
- **`classifyEdit`:**
  - `move`, `resize`, `setText`, `setStyle`, `retime`, `lock`, `unlock` → `free`;
  - `setField vo | emotion` and `regenerate voice:*` → `voice`;
  - `setField scene` and `regenerate plate:*` → `shot`;
  - `setField format` → `structural`.
- **The upgrade mapping is pixel-identity-critical:**
  - a cutout `{ anchorX, anchorY, heightFrac }` becomes a product box `{ x: anchorX − 0.5, y: anchorY − heightFrac, w: 1, h: heightFrac }`, rendered bottom-centre anchored with height `h`, which reproduces today's CSS;
  - text in `top_third`, `mid_lower` or `bottom_center` becomes headline box `x 0.06`, `w 0.88`, with `y` set to 0.14, 0.58 or 0.74 and `h` to 0.2;
  - `revealFrame` is the scene start;
  - `z` follows layer order;
  - ids are as above;
  - `transitionIn` is `cut`;
  - `music` and `sfx` are `[]`;
  - captions style weight is `bold`.

  If an x outside [0,1] is needed for the product box (anchorX − 0.5 < 0), the box schema allows product boxes to exceed the frame horizontally. **Only product** boxes are exempt from the `x + w ≤ 1` rule. Document this in the schema.

- [ ] **Step 1: Record the baseline.**
  - Before touching `compose.ts`, add `packages/renderer-hyperframes/test/v2-identity.test.ts`. It renders the two existing v1 test specs (a plate+cutout+text scene; a broll scene) at 240×426×5 and writes their per-frame sha256 to `test/golden/v1-frame-hashes.json`.
  - Commit the golden: `test(renderer): v1 frame-hash baseline`.
- [ ] **Step 2: Write the failing tests.**
  - `upgradeSpec(v1)` passes `VideoSpec` v2 and renders frame-hash-identical to the baseline golden.
  - `compileProject({ base, ops: [] }, beats).spec` deep-equals `upgradeSpec(oldBuildSpec(sameInput))`. Generate the old output once into `golden/compile-base.json` before refactoring `buildSpec`.
  - One golden compile per op kind: `compile-move.json`, `compile-resize.json`, `compile-settext.json`, `compile-setstyle.json` (headline and captions), `compile-retime.json`.
  - `setField` and `regenerate` and `lock`/`unlock` leave the spec unchanged.
  - `classifyEdit` table test covering every op and path.
  - Review Focus 2: a `move` on `s9.headline` gives `dropped: [op]`, the spec equals the no-op compile, and nothing throws.
  - Review Focus 3: beats where beat 1's voice durationSec goes from 2.0 to 3.5, with words shifted.
    - Scene 1 grows by 45 frames and every later scene's `startFrame` shifts by 45.
    - A headline retimed to `{ kind: 'word', word: 2, offsetFrames: 3 }` gets `revealFrame = word2.startFrame + 3` in both compiles.
    - A scene-cued reveal keeps `sceneStart + offset`.
    - The spec parses, with no overlapping words.
  - A word cue beyond the word count falls back to scene start and lists the op in `dropped`.
- [ ] **Step 3: Run the tests and confirm they fail:** `pnpm --filter @adforge/core test project upgrade` and `pnpm --filter @adforge/renderer-hyperframes test v2-identity`.
- [ ] **Step 4: Implement:**
  - the schemas;
  - `upgradeSpec`;
  - the project modules;
  - `compose.ts` emitting v2 (each element absolutely positioned from its box, shown from `revealFrame` via its own `data-start`, with z as stacking order), plus an option `{ assetUrl?: (key) => string }` that defaults to `assetPath`;
  - `buildSpec` re-expressed through `compileProject`;
  - `render.ts` taking v2;
  - every caller of the old `VideoSpec` type updated (grep). `variants.spec` rows already stored as v1 are read through `upgradeSpec` where they are re-rendered.
- [ ] **Step 5: Run the tests and confirm they pass,** then `pnpm test` (24/24) and `pnpm typecheck`.
- [ ] **Step 6: Commit**: `feat(core): VideoSpec v2 element layers, upgradeSpec, Project/EditOp/compileProject/classifyEdit`

---

### Task 2: Recipes, recipeKey, RecipeGraph, and recording in generateAds (Opus implements, Opus reviews)

**Files:**
- Create: `packages/core/src/recipe/{recipe,graph,index}.ts`, `packages/db/drizzle/0016_recipes.sql` (via drizzle-kit, then hand-add RLS and grants like 0013/0015)
- Modify: `packages/db/src/schema.ts`, `packages/pipeline/src/heavy.ts`, `packages/pipeline/src/record.ts`
- Test: `packages/core/test/recipe.test.ts`, `packages/db/test/recipes-rls.test.ts`, `packages/pipeline/test/recipes-recorded.test.ts`

**Interfaces:**
- **Produces:**
  - `Recipe = { kind: 'plate' | 'cutout' | 'broll' | 'tts' | 'align'; provider: string; model: string; version: string; request: JsonValue; seed?: number; orgId: string }`.
    - `request` is the provider request **without** `idempotencyKey`.
    - Media inputs are referenced by storage key: TTS `{ text, language, emotion, voiceBible? }`; align `{ audioKey, text, language }`; plate `{ prompt, width, height, seed? }`; cutout `{ imageKey }`; broll `{ ...videoRequest, imageKey }`.
    - `version` is the ComfyUI workflow hash for comfy kinds, and the configured engine and model id for TTS and align. Derive it from what `buildConfigSnapshot` already records.
  - `canonicalJson(v): string` (sorted keys, no whitespace) and `recipeKey(r: Recipe): string` (`sha256(canonicalJson(r))`, hex).
  - `assetTag`: `plate:<beat>`, `cutout`, `broll`, `voice:<beat>`, `align:<beat>`.
  - `RecipeGraph.fromVariant(variant: DirectorVariant): RecipeGraph`, with:
    - `dependents(tag): string[]`, transitive downstream tags (`voice:b → [align:b]`, `cutout → []`, `plate:b → [broll]` when b is the broll beat);
    - `invalidated(ops: EditOp[]): string[]`, the sorted tags whose recipes change. It returns `[]` for free ops; for `setField vo|emotion` on beat b, `[align:b, voice:b]`; for `setField scene` on b or `regenerate plate:b`, `[plate:b]` plus dependents.

    Callers turn tags into recipe keys by building the new recipe.
  - Table `recipes(key text pk, org_id uuid not null references orgs, kind text not null, recipe jsonb not null, output_key text not null, created_at timestamptz default now())`, with an index on `(org_id, kind)`.
    - RLS: org members can SELECT.
    - No INSERT/UPDATE/DELETE grant to `authenticated`.
    - The worker inserts through the owner connection.
  - `recordRecipe(db, recipe: Recipe, outputKey: string): Promise<string>`, in `record.ts`. It does an insert with `on conflict (key) do nothing` and returns the key.
  - `findRecipe(db, key): Promise<{ outputKey: string } | null>`.
- **In `heavy.ts`,** after each successful plate, cutout, broll, TTS and align call, `recordRecipe` is called with the request actually sent, minus `idempotencyKey`, inside the same step. The job-scoped idempotency keys stay as they are: they still guard provider retries. Recipes are the cross-revision cache.

- [ ] **Step 1: Write the failing tests:**
  - Review Focus 1: identical recipes give identical keys; same request, different `orgId` gives different keys; key order in `request` doesn't change the key.
  - `invalidated([move, resize, setText, setStyle, retime, lock])` → `[]`.
  - `invalidated([setField beat 1 vo])` → `['align:1', 'voice:1']` exactly.
  - `invalidated([setField beat 0 scene])` → `['plate:0']`, plus `broll` when beat 0 is the broll beat.
  - Ops on different beats give the union.
  - RLS: a member of org B cannot SELECT org A's recipe; `authenticated` cannot INSERT. This uses the existing Postgres-gated RLS harness, with the PGlite path for the grant check.
  - Pipeline: with the fake providers, a generateAds run records exactly one recipe per generated asset (plates per beat, 1 cutout, TTS and align per beat, broll when on), each with `output_key` equal to the stored asset key; a second identical run inserts no duplicates.
- [ ] **Step 2: Run them and confirm they fail.** Then **Step 3: implement.** Then **Step 4: run them and confirm they pass,** plus `pnpm test`, `pnpm typecheck` and `pnpm db:check` (PGlite and Postgres parity).
- [ ] **Step 5: Commit**: `feat(core,db,pipeline): content-addressed recipes and the recipe graph`

---

### Task 3: Revisions, lock, and approve-requires-lock (Sonnet implements, Opus reviews: RLS and grants)

**Files:**
- Create: `packages/db/drizzle/0017_variant_revisions.sql`, `apps/web/lib/server/revisions-api.ts`, routes under `apps/web/app/api/variants/[id]/revisions/route.ts` (GET list, POST create), `.../revisions/[rev]/lock/route.ts` (POST lock / DELETE unlock)
- Modify: `packages/db/src/schema.ts`, `apps/web/lib/data/jobs.ts` (`approveVariant`), `packages/pipeline/src/orchestrate.ts` (write revision 0)
- Test: `apps/web/test/revisions-api.test.ts`, `packages/db/test/revisions-rls.test.ts`, `packages/pipeline/test/revision-zero.test.ts`

**Interfaces:**
- **Consumes:** `EditOp`, `classifyEdit`, `ProjectBase`, `BeatAssets` (Task 1).
- **Produces:**
  - `variants.project_base jsonb`, the `ProjectBase` written at the `spec:<n>` step.
  - Table `variant_revisions(id uuid pk, org_id, variant_id, parent_id uuid null, ops jsonb not null, beats jsonb not null, spec jsonb null, status ('ready'|'pending'|'failed') not null, locked boolean not null, error jsonb, render_asset_id uuid null, created_at)`.
    - `ops` holds this revision's **own** ops; the effective ops are the chain from revision 0.
    - Composite FK `(variant_id, org_id) → variants(id, org_id)`.
    - RLS: org members SELECT.
    - Users INSERT through `withUser`, with a column-level INSERT grant on `(id, org_id, variant_id, parent_id, ops, beats, status, locked)` only — never `spec`, `render_asset_id` or `error` (see the ruling below for `beats`/`status`).
    - The worker updates `spec`, `status`, `beats`, `error` and `render_asset_id` through the owner connection.
  - Revision 0 is created in `orchestrate.ts` right after `spec:<n>` succeeds: `ops: []`, `beats` = the beat assets used, `spec` = the compiled spec, `status: 'ready'`, `locked: true`.
  - `currentRevision(db, variantId)` is the newest by `created_at` (ties broken by id).
  - **Routes** (session, same-origin and membership as B2/B3; JSON bodies through the shared capped reader):
    - `GET /api/variants/:id/revisions` → the chain list `{ id, parentId, ops, status, locked, createdAt }[]`.
    - `POST /api/variants/:id/revisions { parentId, ops: EditOp[] (1–50) }`:
      - 404 when the parent isn't in this variant;
      - 409 when the parent is locked and the ops aren't `[unlock]` alone, or when `ops` contains `lock` or `unlock` (use the lock routes);
      - 422 for a structural op (`structural edits arrive with Director v2`).
      - Otherwise it creates `{ parentId, ops, beats: parent.beats, status: 'pending', locked: false }` and sends `adforge/variant.edit { revisionId }`, returning 202 `{ revisionId }`.
    - `POST .../revisions/:rev/lock` sets `locked = true`, but only when the status is `ready`; otherwise 409.
    - `DELETE .../revisions/:rev/lock` → 409. Unlocking is done by creating a child revision (an edit), so a locked revision is immutable forever.
  - **Approve** requires `currentRevision(variant).locked` (else 409 `lock the current revision before approving`). For legacy variants with no revisions, approve behaves as today.
- **Ruling for implementers:** `beats` is copied server-side from the parent row, `status` is forced to `'pending'` and `locked` to `false`, inside the same `withUser` transaction; none of these come from the request body. Only the worker (owner connection) moves `status` to `ready`/`failed`. `POST lock` runs as the user with a column-level UPDATE grant on `locked` only, guarded by `status = 'ready'` in the WHERE clause.

- [ ] **Step 1: Write the failing tests:**
  - **Revision chain:** rev0 → rev1 → rev2, and GET returns all 3 with parent links.
  - **Review Focus 4:**
    - posting ops to a locked parent gives 409 and no row;
    - approve with an unlocked current revision gives 409;
    - after `POST lock` the same approve gives 200.
  - **Review Focus 5:** two concurrent POSTs from the same parent give 2 sibling revisions with intact ops; `currentRevision` is the later one.
  - **Structural op:** 422 and no row.
  - **Foreign org:** a variant from another org gives 404 (RLS).
  - **Grants:** `authenticated` cannot UPDATE `spec`/`status` or INSERT `render_asset_id`.
  - **Pipeline:** a fake-provider generateAds run writes exactly one locked revision 0 per completed variant with `ops []`, `beats` and `spec` set, and `variants.project_base` set.
- [ ] **Step 2: Run them and confirm they fail.** Then **Step 3: implement**, with the migration through drizzle-kit and hand-added RLS and grants. Then **Step 4: run them and confirm they pass,** plus `pnpm test`, `pnpm typecheck` and `pnpm db:check`.
- [ ] **Step 5: Commit**: `feat(db,web,pipeline): variant revisions, lock, approve-requires-lock`

---

### Task 4: Regeneration executor and export (Sonnet implements, Opus reviews: idempotency)

**Files:**
- Create: `packages/pipeline/src/edit.ts`
- Modify: `packages/pipeline/src/inngest.ts` (two functions, plus one heavy function `heavy-voiceLines`), `packages/pipeline/src/heavy.ts`
- Test: `packages/pipeline/test/edit.test.ts`

**Interfaces:**
- **Consumes:** Task 1 `compileProject` and `classifyEdit`; Task 2 `RecipeGraph`, `recipeKey`, `recordRecipe` and `findRecipe`; Task 3 revisions.
- **Produces:**
  - Inngest `variant-edit`, triggered by `adforge/variant.edit { revisionId }`, retries 2, idempotent per `revisionId`. Its steps, in order:
    1. `load`: the revision, its chain to revision 0, and the variant's `project_base`. Effective ops = the concatenated chain.
    2. `plan`: `tags = graph.invalidated(revision.ops)`. Only **this** revision's ops invalidate, because the parent's beats are already current.
    3. For each invalidated voice beat, build the new TTS recipe from the effective VO text, emotion and the same voice bible the job used: `configSnapshot.voice` records its `tag@version` (or `config-defaults`); re-resolve that exact row through the existing `voiceBible` lookup in heavy.ts (export it).
       - On a `findRecipe` hit, reuse its `outputKey` and run align the same way.
       - On a miss, `step.invoke` `heavy-voiceLines { revisionId, lines: [{ beat, text, language, emotion, voiceBible? }] }`. It synthesizes, aligns and records the recipe and provider calls on the job's `jobId`, under idempotency keys `<revisionId>:tts:<beat>` and `<revisionId>:align:<beat>`.
    4. `shot` tags (plates): C2 executes plate regeneration the same way, through the existing image provider and a recipe built with the setting text from `setField scene`, appended after the scene text. Its prompt compiler arrives in C3.
    5. `compile`: `beats` = parent beats with the regenerated entries replaced; then `compileProject({ base, ops: effective }, beats)`. Write `spec`, `beats` and `status: 'ready'`, and store `dropped` in `error` as `{ dropped }` when non-empty.
    6. On failure, set `status: 'failed'` with the error.
  - Inngest `variant-export`, triggered by `adforge/variant.export { revisionId }`. It renders a `ready` revision's spec through the existing heavy render, with idempotency key `<revisionId>:render`, and sets `render_asset_id`.
  - Route: `POST /api/variants/:id/revisions/:rev/export` → 202. It lives in the Task 3 API file; add it there.
- **Org scope:** both functions resolve the org from the revision row, like `orgForEvent`. Extend `orgForEvent` with `revisionId`, and re-enter the scope inside every step callback (B3 Task 1 pattern).

- [ ] **Step 1: Write the failing tests** (fake providers with call counters, PGlite, the existing fake step and invoke harness):
  - **Free ops only** (`move`, `setStyle captions`, `setText`, `retime`): **0** TTS, 0 align, 0 image calls; the spec reflects all of them.
  - **One VO edit** (`setField beat 1 vo`): exactly **1** TTS and **1** align call, and 0 image calls. Beat 1's voice key changes, later scenes shift by the new duration, and a word-cued reveal follows (Review Focus 3).
  - **The same VO edit again** in a new revision from the same parent: 0 calls (recipe hit).
  - **The same VO text in another org:** 1 TTS and 1 align (Review Focus 1, end to end).
  - **A retry of the step** after the TTS succeeded: no second TTS call (idempotency key).
  - **An op on a missing layer:** the revision is ready, with `error.dropped` listing it.
  - **Export:** a single render call; `render_asset_id` set; a second event for the same revision makes no extra render.
- [ ] **Step 2: Run them and confirm they fail.** Then **Step 3: implement.** Then **Step 4: run them and confirm they pass,** plus `pnpm test` and `pnpm typecheck`.
- [ ] **Step 5: Commit**: `feat(pipeline): variant.edit executor with recipe cache hits; variant.export`

---

### Task 5: In-browser preview (Sonnet implements, Sonnet reviews)

**Files:**
- Create: `apps/web/lib/preview.ts` (spec → composition HTML for the browser), `apps/web/app/jobs/[id]/preview.tsx` (client component)
- Modify: `apps/web/app/jobs/[id]/page.tsx`, `apps/web/lib/data/jobs.ts` (the job view carries each variant's current revision `{ id, status, locked, spec }`), `apps/web/package.json` (`@hyperframes/player`: `0.8.106` exact)
- Test: `apps/web/test/preview.test.ts`
- Docs first: read `@hyperframes/player` 0.8.106's README from `node_modules` (the shipped docs, not memory). Add a short `docs/providers/hyperframes-player.md` covering the mount API, how a composition HTML string or URL is provided, seek, and determinism notes.

**Interfaces:**
- **Consumes:** `composeHtml(spec, { assetUrl })` (Task 1), and the current revision's spec (Task 3/4).
- **Produces:**
  - `previewHtml(spec: VideoSpec, mediaUrl: (key) => string): string`, which is `composeHtml` with `assetUrl = mediaUrl`. GSAP and font URLs point at static files served by the web app; copy them to `apps/web/public/hf/` at build time with a script, not committed binaries, or use the player's own runtime loading if its docs provide that.
  - `<VariantPreview spec mediaUrl>` mounts the player with `previewHtml`. It has play/pause and seek, and is visible for `ready` revisions only, next to the existing MP4 player. No editing UI yet (C7).
  - Media URLs come from `ctx.storage.urlFor` exactly as the job view does today, so tenancy is unchanged.

- [ ] **Step 1: Write the failing tests:**
  - `previewHtml` contains every element's `assetUrl(key)` and no `assets/` relative paths;
  - every element's `data-start` equals `secs(revealFrame)`;
  - the job view returns the current revision's spec for a completed variant;
  - a variant without revisions shows no preview.
- [ ] **Step 2: Run them and confirm they fail.** Then **Step 3: implement.** Then **Step 4: run them and confirm they pass,** plus `pnpm test` and `pnpm --filter @adforge/web typecheck`.
- [ ] **Step 5: Commit**: `feat(web): in-browser HyperFrames preview of the current revision`

---

### Task 6: ADR 0019 and architecture note (Worker implements via the room, Sonnet reviews)

The controller writes a fact brief (the amendments above, plus the decisions recorded in the ledger) and dispatches a free OpenCode worker in a clean worktree. Files: `docs/decisions/0019-c2-editable-composition.md` (in the format of 0018) and a two-line pointer in `docs/architecture.md` §5 ("VideoSpec v2: see ADR 0019"). Commit: `docs: ADR 0019 editable composition and recipe cache`.

---

### E2e: `pnpm e2e:edit` (Sonnet writes it, the controller runs it once)

`apps/worker/src/e2e-edit.ts` uses the dev profile and the dev DB the worker already uses.
- **Services:** voice (Whisper) and voice-qwen, Inngest dev and the worker. **No ComfyUI.**
- **Setup:** it seeds revision 0 directly, without `generateAds`:
  - the C1 library photo and cutout for the Krishna product;
  - a 1080×1920 solid-gradient plate PNG generated with sharp;
  - a 2-scene `DirectorVariant` fixture;
  - one real TTS and one real alignment per beat, recorded as recipes;
  - `variants.project_base` and a locked revision 0.

  Every storage put runs inside `withStorageOrg`.
- **Steps:**
  1. Snapshot the `provider_calls` count by kind.
  2. Through the web API handlers, with an in-process ctx and a fake session as in `e2e-r2.ts`, POST one revision with three ops: `move s0.product`, `setField beat 1 vo` (new text) and `setStyle captions { weight: 'chunky' }`.
  3. Wait for `ready`.
  4. POST export and wait for `render_asset_id`.
  5. Render the preview HTML in headless Chrome (puppeteer, already installed) and screenshot frames 0, mid and last−1 at 240×426.
  6. Extract the same frames from the exported MP4 with ffmpeg.
- **Pass:**
  - the provider-call delta outside `render` is exactly `tts: 1, align: 1`;
  - the compiled spec shows all three ops (the product box moved, beat 1's voice key changed, captions weight chunky);
  - every sampled preview frame matches the MP4 frame within a mean absolute pixel difference of 4/255 (video encoding is lossy).
- **Cleanup:** stop every service it started and confirm VRAM is back to baseline.

The report goes to the plan's SDD workspace as `e2e-report.md`.
