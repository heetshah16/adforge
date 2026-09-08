# AdForge — Spec Addendum B: Motion Economics & Distribution

Extends `adforge-app-spec.md` and Addendum A.

Two parts:
- **B1–B4:** what Remotion can and cannot do for motion, and how to cut video-model spend by ~65% without losing quality.
- **B5–B10:** publishing to TikTok, Reels and Shorts, plus the metrics loop. Replaces email delivery entirely.

---

# B1. WHAT REMOTION CAN AND CANNOT DO

**Remotion interpolates properties you define. It has no model of the world.**

Given a still, it can move the *camera*: translate, scale, rotate, crop, mask, blur, colour-grade, composite. Every frame is a deterministic function of `useCurrentFrame()`.

What it cannot do is invent **content motion**. It does not know:
- what exists behind an occluded region
- how a subject deforms as it moves (a hand closing, fabric settling, liquid pouring)
- what a face looks like turned 15° from the one photo you have

So the question isn't "Remotion or gen-AI." It's: **does this shot need the camera to move, or the world to move?**

That distinction is worth money, because in a product ad most shots only need the camera.

| Shot intent | World moves? | Tool |
|---|---|---|
| Slow push into the label | No | Remotion |
| Dolly across a kitchen counter | No — needs parallax | Remotion + depth |
| Rack focus foreground→product | No | Remotion + depth blur |
| Hand picking up the jar | **Yes** | Video model |
| Oil pouring into a pan | **Yes** | Video model |
| Steam rising, fabric moving | **Yes** | Video model |
| Talent turning to camera | **Yes** | Video model |

## The interpolation trap

Generating two keyframes and interpolating between them **does not work** for shots where content changes. RIFE and FILM assume the two frames are temporally adjacent — a few hundred milliseconds apart, same scene, same objects. Feed them two independently generated keyframes 4 seconds apart and you get morphing mush: objects dissolving into each other rather than moving.

Frame interpolation is for **frame-rate upscaling** (24→60fps on already-continuous footage), not for motion synthesis. Use it to smooth video-model output, never to replace it.

---

# B2. THE 2.5D UNLOCK

This is the technique your intuition was circling, and it's genuinely large.

<cite index="33-1">The 2.5D parallax technique uses a depth map to separate an image into layers corresponding to different distances from the camera, then moves those layers at different rates to simulate the parallax of a lateral camera move.</cite> <cite index="34-1">Monocular depth estimation models like Depth-Anything-V2 predict depth from a single image using texture gradients, perspective lines, occlusion and relative object sizes — no stereo camera or LiDAR needed.</cite>

The result is a real dolly move with correct parallax, rendered deterministically in Remotion. It reads as a camera move, not a Ken Burns zoom, and it costs a fraction of a cent.

## Pipeline

```
keyframe (still)
   ↓ Depth Anything V2            ~$0.003
depth map
   ↓ SAM 2 segmentation           ~$0.004
N layers (fg / mid / bg + product)
   ↓ inpaint occluded regions     ~$0.02   ← ONCE, cached
clean layers with alpha
   ↓ Remotion + Three.js
depth-displaced camera move        $0 marginal
```

**The inpainting step is the one people skip and then wonder why it looks broken.** When you displace layers, you expose background that was never photographed — a hole behind the product. <cite index="36-1">Inpainting extends the edges of image slices to prevent gaps when layers separate.</cite> Do it once per keyframe, cache it, and every subsequent camera move on that frame is free.

## Camera moves this supports

Lateral pan, dolly in/out with correct foreground/background rate difference, elevation change, subtle orbit (±15° before the illusion breaks), rack focus using the depth map as a blur mask.

<cite index="37-1">Depth guides proper parallax by determining each pixel's displacement from its relative depth; for a dolly-in, foreground elements stay stable while the background compresses.</cite>

**Where it breaks:** orbits beyond ~15–20°, anything requiring genuinely unseen geometry (the back of the product), and scenes with fine occlusion detail like hair or foliage. Those go to a video model.

---

# B3. MOTION TIERS

Parallel to Addendum A's fidelity tiers. Assigned per shot; both tiers together determine cost.

| Tier | Method | Cost/shot | Use when |
|---|---|---|---|
| **M0** | Remotion 2D transform (pan, zoom, crop, mask) | ~$0 | Flat subject, graphic beats, text moments |
| **M1** | Remotion + depth parallax | ~$0.03 (cached after first) | Camera move through a scene, no content motion |
| **M2** | Video model, `image_to_video`, short | ~$0.35 (4s @ ~$0.09/s) | Subtle content motion — steam, drift, ambient life |
| **M3** | Video model, `first_last_frame` or `reference_to_video` | ~$0.60+ | Real physical events, talent performance |

Assigned by the cinematographer's `cameraMove` and a new required field:

```ts
contentMotion: z.enum(['none','ambient','significant'])
```

- `none` → M0 or M1 (M1 if `cameraMove.type` implies depth traversal)
- `ambient` → M2
- `significant` → M3

**Composable with fidelity tiers.** A T0/M1 shot — real product cutout, depth-parallax background plate, camera dollying past — is the workhorse of this system: brand-safe, cinematic, essentially free after the first render.

## Realistic distribution

For a 4-beat product ad, expect roughly:

- 1 beat M3 (the demonstration or human moment)
- 1 beat M2 (ambient texture)
- 2 beats M0/M1 (hook card, product hero, CTA)

## Revised cost per variant

| Stage | Addendum A | With motion tiers |
|---|---|---|
| LLM (strategy, direction, cinematography) | $0.05 | $0.05 |
| Keyframes + gate retries | $0.34 | $0.34 |
| Gate checks | $0.08 | $0.08 |
| Depth + segmentation + inpaint | — | $0.09 |
| Motion | $1.50 | **$0.50** |
| TTS + render | $0.15 | $0.18 |
| **Per variant** | **$2.12** | **$1.24** |
| **Per job (3 variants)** | **$6.36** | **$3.72** |

**~41% cheaper, and the M0/M1 shots are more controllable** — deterministic, reproducible, no drift, no retry lottery. Video models are only where they earn their keep.

## Build implication

`packages/renderer-remotion/src/motion/` needs:

- `kenBurns.ts` — M0, 2D transforms
- `depthParallax.tsx` — M1, Three.js displacement shader driven by a depth texture
- `rackFocus.tsx` — depth-mask blur
- `DepthLayerStack.tsx` — composites inpainted layers with per-layer z

`depthParallax` is the one non-trivial component in the whole renderer. Budget real time for it and validate against reference footage — a parallax move that's subtly wrong reads as cheap in a way viewers notice but can't name.

---

# B4. WHAT THIS MEANS FOR PROVIDER CHOICE

Video models are now used for *fewer, harder* shots. That changes selection criteria: prefer control and physical plausibility over cost-per-second, since you're buying far fewer seconds.

`first_last_frame` support becomes the top capability filter — it's the only mode where both ends of the shot are pre-approved by the gate. Wan 2.7's start/end-frame control is specifically valuable here; Seedance's multi-reference conditioning matters more for talent continuity.

Add to `VideoCapabilities`:

```ts
supportsFirstLastFrame: boolean;
supportsDepthConditioning: boolean;   // depth map as control input
motionControlVocabulary: 'prompt' | 'structured';
```

<cite index="38-1">Models supporting depth conditioning interpret depth maps as additional input channels alongside the prompt, which lets them move foreground elements faster than background and handle occlusion correctly.</cite> Since you're already computing depth maps for M1, feeding them to M2/M3 costs nothing extra and materially improves motion coherence.

---

# B5. DISTRIBUTION — THE HARD TRUTH FIRST

You're right that email is not the product. But publishing is **not** a small addition, and it isn't gated on engineering.

Three platforms, three independent app-review regimes, each measured in weeks:

| Platform | Gate | Timeline |
|---|---|---|
| TikTok | Content Posting API audit. Unaudited: `SELF_ONLY` visibility, max 5 users | 2–6 weeks, rejected without a documented use case |
| Instagram | Business/Creator account + linked Facebook Page; Advanced Access on `instagram_content_publish` for non-owned accounts | 2–6 weeks, multiple rounds likely |
| YouTube | Free quota works, but see B7 | Days, unless you need a quota extension |

**Recommendation: ship v1 on an aggregator, abstract it, migrate later.**

Blotato, Ayrshare, Postproxy and Zernio all wrap these three behind one API and carry the app reviews themselves. You get publishing in days instead of a quarter. Behind `DistributionProvider`, swapping to direct APIs later is one adapter — and you'll know by then which platforms actually matter to your users, which is the information that justifies the review effort.

Going direct first means 6–18 weeks of calendar before anyone can publish anything. That is the wrong order for a product still finding its shape.

---

# B6. PLATFORM CONSTRAINTS

## TikTok

- Unaudited apps: `SELF_ONLY` visibility, 5 users maximum
- ~15 posts/day per creator, **shared across all API clients** using Direct Post — not per app
- 6 requests/minute per user token
- Two modes: **Direct Post** (publishes immediately) and **Upload to Inbox** (lands in the user's drafts for them to finish and post). Inbox has looser requirements and is a good v1 default — it also sidesteps the "did an AI post this on my behalf" trust problem
- Creator info must be fetched before posting to respect their privacy settings

## Instagram Reels

<cite index="27-1">Publishing takes three steps: POST to `/{ig-user-id}/media` with `media_type=REELS` and a public `video_url`, poll `/{container-id}?fields=status_code` until `FINISHED`, then POST to `/{ig-user-id}/media_publish` with the `creation_id`. Reels eligibility requires 9:16, 5–90 seconds, H.264 or HEVC, and a Business account.</cite>

- `video_url` **must be publicly reachable** — Instagram fetches it. Your R2 bucket needs a public path or long-lived signed URLs
- <cite index="25-1">`share_to_feed=true` puts it in both feed and Reels tab; `thumb_offset` in milliseconds picks the cover frame</cite>
- <cite index="25-1">Insights require ≥1,000 followers, and only organic engagement is counted</cite> — which means **your smallest users get no metrics at all**. Design the dashboard to degrade gracefully rather than showing zeros
- Publish cap is **contested across sources**: 25, 50, or 100 per rolling 24h depending on who you read. Don't hardcode it — read the `X-App-Usage` and `X-Business-Use-Case-Usage` headers on every response and back off on what they report
- <cite index="30-1">Meta replaced flat call caps with a Business Use Case formula of roughly 4,800 × impressions per 24 hours</cite>, so a low-traffic account gets a very small budget. Small accounts hit limits first — exactly your target user

## YouTube Shorts

- Vertical, ≤3 minutes, uploaded via `videos.insert`; Shorts classification is automatic
- 10,000 quota units/day per Google Cloud project, resetting midnight Pacific, **no paid tier** — the only path to more is a manual audit form
- **Upload cost is contested.** Multiple July 2026 sources still quote 1,600 units, while others report a cut to ~100 units effective December 2025. At 1,600 that's 6 uploads/day; at 100 it's ~100. **Verify against the official quota calculator before sizing anything** — this single number decides whether you need a quota extension
- <cite index="19-1">Since June 1, 2026, `search.list` bills to its own dedicated daily bucket capped at ~100 calls/day</cite>. Irrelevant for publishing, relevant if you ever add competitor research

---

# B7. THE DISTRIBUTION ABSTRACTION

```ts
export interface PublishTarget {
  platform: 'tiktok' | 'instagram_reels' | 'youtube_shorts';
  accountId: string;
  mode: 'direct' | 'draft' | 'scheduled';
  scheduledFor?: Date;
}

export interface PublishRequest {
  video: MediaRef;
  caption: string;
  hashtags: string[];
  coverFrameMs?: number;
  target: PublishTarget;
  disclosure: { aiGenerated: boolean; brandedContent: boolean };
  idempotencyKey: string;
}

export interface DistributionProvider extends Capability {
  readonly constraints: {
    maxDurationSec: number;
    aspectRatios: string[];
    maxCaptionChars: number;
    maxHashtags: number;
    codecs: string[];
    requiresPublicUrl: boolean;
    supportsScheduling: boolean;
    supportsDraft: boolean;
  };
  connect(userId: string): Promise<OAuthUrl>;
  listAccounts(userId: string): Promise<SocialAccount[]>;
  validate(req: PublishRequest): ValidationResult;   // LOCAL, before upload
  publish(req: PublishRequest): Promise<ProviderResult<PublishedPost>>;
  fetchMetrics(postId: string, since?: Date): Promise<MetricSnapshot[]>;
}
```

**`validate()` runs locally against `constraints` before a byte is uploaded.** Same discipline as the render payloads: a platform rejection should be a test failure, not a runtime surprise. Caption length, duration, aspect ratio, codec are all checkable offline.

**`disclosure` is not optional.** Synthetic presenters in paid ads carry FTC exposure in the US, and each platform has its own AI-content flag. Set them.

## Publish-time re-encode

Each platform has different codec and duration ceilings. Don't render three times — render one master and transcode per target with FFmpeg. Add a `transcodeForTarget` step between render and publish, cached by `(assetId, platform)`.

---

# B8. METRICS — CANONICAL, NOT UNIFIED

The platforms do not measure the same things and pretending otherwise produces a dashboard that lies.

```ts
export const MetricSnapshot = z.object({
  postId: z.string(),
  platform: Platform,
  capturedAt: z.date(),

  // Canonical — present everywhere, comparable
  views: z.number(),              // NOTE: definitions differ, see below
  likes: z.number(),
  comments: z.number(),
  shares: z.number(),
  saves: z.number().optional(),

  // Retention — the metric that actually matters for short-form
  avgWatchTimeSec: z.number().optional(),
  completionRate: z.number().optional(),
  retentionCurve: z.array(z.number()).optional(),

  // Platform-native, untouched
  raw: z.record(z.unknown()),
});
```

**Store `raw` always.** Metric fields get deprecated on short notice, and a raw archive is the difference between a schema migration and permanent data loss.

**Never claim cross-platform view parity.** A TikTok view, an Instagram play and a YouTube view have different thresholds. Label them per platform in the UI, and only compare *within* a platform. Cross-platform, compare engagement *rates*, not counts.

**Poll on a decay schedule:** hourly for 24h, every 6h to day 7, daily to day 30, then stop. A fixed poll interval wastes rate limit on posts nobody is watching any more — and on Instagram, rate limit is proportional to the account's impressions, so your smallest users have the least to spare.

---

# B9. THE FEEDBACK LOOP — THIS IS THE ACTUAL PRODUCT

Everything above is table stakes. This is not, and it falls out of the architecture for free.

You generate three variants that differ on **known, typed dimensions** — `format`, `hook_archetype`, `visual_treatment` — for a product with a known `archetype`. When metrics come back, you can attribute performance to those dimensions.

```
performance_attribution
  variantId, productArchetype, format, hookArchetype, visualTreatment,
  platform, views, completionRate, engagementRate, capturedAt
```

After a few hundred posts you can answer questions nobody else can:

- *For `remedy` products on TikTok, `objection_lead` hooks retain 18% better than `curiosity_gap`.*
- *`sensory_tease` underperforms on Shorts and overperforms on Reels.*
- *`split_compare` treatment dies after 2 seconds on every platform.*

Feed that back into the Director as a prior: "For this archetype on this platform, these hooks have historically won — weight toward them but keep one exploratory variant."

**This is a compounding moat.** A competitor wrapping a video model has no typed creative dimensions to attribute against, so they cannot learn. You designed the vocabulary in the Make build without knowing that's what it was for.

Keep one of three variants **deliberately exploratory** — always sampling outside the current best-known combination. Otherwise you converge early on a local maximum and the system stops learning.

---

# B10. BUILD ORDER

Insert after Milestone 11.

| # | Milestone | Exit criteria |
|---|---|---|
| 12 | `DistributionProvider` + aggregator adapter | Publish one video to one platform via aggregator |
| 13 | OAuth account linking UI | User connects TikTok/IG/YT, accounts listed |
| 14 | Transcode-per-target + local `validate()` | Platform rejection is a test failure, not a runtime error |
| 15 | Scheduling + draft mode | Queue for a time; TikTok inbox mode works |
| 16 | Metrics ingestion + decay polling | 30-day curve per post, `raw` archived |
| 17 | Attribution dashboard | Performance sliced by format × hook × archetype |
| 18 | Prior feedback into Director | Historical winners weight generation; one exploratory variant retained |
| 19 | Direct platform APIs | Replace aggregator per platform, once volume justifies review |

**Milestone 14 before 15.** Ship validation before scheduling, or your first scheduled batch fails silently at 3am with no one watching.

---

# B11. WHAT REPLACES EMAIL

- **In-app review** — `@remotion/player`, all three variants side by side with their `strategic_bet` visible, no render cost to preview
- **One-tap publish or schedule** to any connected account
- **Push/webhook on completion**, not email
- **Post-performance view** — the retention curve per variant, and which hook won

Email survives in exactly one place: a weekly digest of *what performed*, because that's the message a seller actually wants to receive.
