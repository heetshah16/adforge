# 0019 — C2: editable composition and recipe cache

**Status:** accepted · 2026-10-20

## Decision
- An ad is an editable project: a base (the Director variant and theme, stored as `variants.project_base`) plus an ordered list of edit operations. `compileProject(project, beats)` turns it into `VideoSpec` v2. It is pure and deterministic, and it never calls a provider or an LLM.
- `VideoSpec` v2 has element layers (plate, broll, product, logo, headline, stat, chip, badge, cta_button), each with a stable `layerId`, a box (fractions of the frame), a z order and an absolute `revealFrame`; scenes gain `transitionIn` (only `cut` for now) and audio gains empty `music` and `sfx` tracks. The element and transition lists are closed enums: adding a value is a PR.
- The IR stays frames-only. Reveal cues (`scene` or `word` plus an offset in frames) live in the project's edit ops; `compileProject` resolves them to `revealFrame`, so a word-cued reveal follows its word when the voice line changes.
- Old v1 specs are upgraded by the pure `upgradeSpec`; a same-run render test proves an upgraded v1 spec renders frame-identical to the old compositor's HTML (no machine-specific stored hashes).
- Edit operations: move, resize, setText, setStyle, retime, setField (vo, emotion, scene, format), regenerate (plate:<beat>, voice:<beat>), lock, unlock. `classifyEdit` sorts them into free, voice, shot and structural.
- An operation that cannot apply is skipped and reported with a reason (missing_target, invalid, wrong_target, cue_out_of_range). The edit API rejects a newly posted operation that would be skipped for any reason except missing_target (422).
- Every generated asset has a recipe: the provider request actually sent (minus the idempotency key), the provider, model and version, an optional seed, and the org id. Its key is the sha256 of canonical JSON. Recipes are stored in `recipes` (members can read; only the worker writes).
- A recipe key includes the org id, so a cache hit never crosses orgs.
- `RecipeGraph` maps operations to the asset tags they invalidate: free edits invalidate nothing; a voice-line edit invalidates exactly that line's TTS and alignment; a scene edit or plate regenerate invalidates that plate (and drops the b-roll on that beat — C2 does not regenerate b-roll).
- Regenerate is never a cache no-op: a plate regenerate uses a seed derived from the revision id; a voice regenerate adds a revision-id nonce to the recipe.
- Revisions: `variant_revisions` holds a chain per variant. Revision 0 is the original generation and is created locked. A locked revision is immutable forever; editing it means posting `[unlock, ...edits]`, which creates an unlocked child. Approve requires the variant's current revision to be locked, and an approved variant cannot be edited. A database foreign key keeps every parent inside the same variant.
- The executor (`adforge/variant.edit`) regenerates only what this revision's own operations invalidate, reuses recipe-cache hits, re-flows the timeline and recompiles. Retryable provider failures retry inside the heavy step; non-retryable ones fail the revision.
- Export (`adforge/variant.export`) renders a ready revision through the existing heavy render, one export at a time per revision.
- Structural edits (format, add/remove beats) are stored but not executed in C2; they return 422 until Director v2 (C3). Hinglish voice-line edits also return 422 until C3.
- The review page previews the current revision in the browser with `@hyperframes/player` 0.8.106, using the same composition HTML as the render; media comes from `storage.urlFor` (`/media/*` under R2).
- Status codes of the revisions API: 400 = body or op schema, including the op refines; 409 = state conflicts (lock op posted, misplaced unlock, locked parent without a leading unlock, approved variant, non-ready parent, approve on an unlocked or unrendered current revision); 422 = semantic (a newly dropped op other than missing_target, structural edit, Hinglish VO edit, a bare unlock); 503 = the event could not be enqueued.
- Migrations 0016 (recipes), 0017 (variant_revisions and the recipes.kind CHECK) and 0018 (chain FK) are applied on the shared dev database and are never edited.
- RLS: members SELECT recipes and revisions; they INSERT revisions only as pending, unlocked and non-root (column grants); they UPDATE only `locked` from false to true, on ready rows. Everything else is the worker's.
- The current revision is the newest non-failed one; a legacy variant without revisions approves as before. Approving an edited variant (a revision with a parent) requires its export, and the job view's `renderUrl` is that export once it exists.
- The janitor fails an edit still pending after 2 hours (the variant-edit finish timeout, one shared constant) and does not free the GPU holders while any edit is pending.
- The POST 422 pre-check compiles against the parent's beats, so a word cue posted together with a VO edit is judged against the old words (known limitation). An edit or regenerate naming a beat the variant lacks is `invalid`, hence 422.

## Consequences
- A layout or style edit costs nothing; a voice-line edit costs one TTS and one alignment call.
- Text boxes render only x, y and width (text grows from the top, like v1); a headline resize changes its width.
- Resizing a product keeps its bottom-centre anchor in place.
- Recipe versions do not see model weights swapped inside the voice, vision or ComfyUI services under the same name; the upgrade path is for services to report model ids through /health.
- A failed export is visible only in `provider_calls` until the editor UI (C7) surfaces it.
- The real job-page preview mount in a browser is untested until the C7/B4 Playwright e2e; the e2e script compares a standalone player page with the export.
- The frame-identity test compares two renders on the same machine, so Chrome or FFmpeg upgrades do not break it.
