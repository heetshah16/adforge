import { and, eq } from 'drizzle-orm';
import { direct } from '@adforge/core/llm/direct';
import { strategize } from '@adforge/core/llm/strategize';
import type { DirectorVariant, StrategistOutput } from '@adforge/core/llm/schemas';
import { buildSpec } from '@adforge/core/spec/build-spec';
import type { VideoSpec } from '@adforge/core/spec/video-spec';
import { shortlist, type Shortlist } from '@adforge/core/vocab/shortlist';
import { loadRegistry } from '@adforge/db/registry';
import { jobs, providerCalls, variants } from '@adforge/db/schema';
import { markProgress, setJobStatus } from './progress';
import { recordCall } from './record';
import { buildConfigSnapshot } from './snapshot';
import type { JobInput, PipelineDeps, StepLike } from './types';
import { toWire } from './wire';

class Retry extends Error {}
type Out = { status: 'completed' | 'failed'; warnings: string[] };

export async function generateAds(jobId: string, step: StepLike, deps: PipelineDeps): Promise<Out> {
  const { db } = deps;
  const fail = async (stage: string, reason: unknown): Promise<Out> => {
    await step.run(`fail:${stage}`, async () => {
      await markProgress(db, jobId, stage, 'failed', typeof reason === 'string' ? reason : ((reason as { message?: string })?.message ?? JSON.stringify(reason)));
      await setJobStatus(db, jobId, { status: 'failed', error: { stage, reason }, completedAt: new Date() });
      return true;
    });
    return { status: 'failed', warnings: [] };
  };

  const input = await step.run('load', async () => {
    const [j] = await db.select().from(jobs).where(eq(jobs.id, jobId));
    if (!j) throw new Error(`job ${jobId} not found`);
    await setJobStatus(db, jobId, { status: 'running' });
    return j.inputSpec as JobInput;
  });

  const pre = await step.run('preflight', async () => {
    await markProgress(db, jobId, 'preflight', 'running');
    try {
      await deps.comfy.preflight();
      const h = await deps.voice.health();
      if (!h.ok || !h.sm120) return { error: `voice service unhealthy (ok=${h.ok}, sm120=${h.sm120})` };
    } catch (e) {
      return { error: (e as Error).message };
    }
    await setJobStatus(db, jobId, { configSnapshot: buildConfigSnapshot({ env: deps.env, workflowHashes: deps.comfy.workflowHashes }) });
    await markProgress(db, jobId, 'preflight', 'done');
    return { ok: true as const };
  });
  if ('error' in pre) return fail('preflight', pre.error);

  // --- LLM stages (not in the heavy lane) ----------------------------------------------------
  const brief = await step.run('strategize', async () => {
    await markProgress(db, jobId, 'strategize', 'running');
    const registry = await loadRegistry(db);
    const images = await Promise.all(
      input.photoKeys.map(async (k) => ({ mime: (k.endsWith('.png') ? 'image/png' : k.endsWith('.webp') ? 'image/webp' : 'image/jpeg') as 'image/png', data: await deps.storage.read(k) })),
    );
    const r = await strategize({ product: input.product, images }, registry, {
      llm: deps.llm, model: deps.env.ADFORGE_LLM_STRATEGIST, effort: deps.env.ADFORGE_LLM_EFFORT_STRATEGIST, idempotencyKey: `${jobId}:strategize`,
    });
    const w = toWire(r);
    await recordCall(db, { jobId, kind: 'llm', provider: deps.llm.id, model: deps.env.ADFORGE_LLM_STRATEGIST, idempotencyKey: `${jobId}:strategize`, result: w, latencyMs: r.status === 'done' ? r.latencyMs : undefined, costUsd: r.status === 'done' ? r.cost.amountUsd : 0 });
    if (!w.ok && w.retryable) throw new Retry(w.message);
    if (w.ok) { await setJobStatus(db, jobId, { brief: w.value.value }); await markProgress(db, jobId, 'strategize', 'done'); }
    return w.ok ? { brief: w.value.value } : { error: w };
  });
  if ('error' in brief) return fail('strategize', brief.error);

  const list = await step.run('shortlist', async () => {
    const registry = await loadRegistry(db);
    const s = shortlist({ archetypePrimary: brief.brief.archetype_primary, archetypeSecondary: brief.brief.archetype_secondary }, registry);
    await setJobStatus(db, jobId, { shortlist: s });
    return s;
  });

  const direction = await step.run('direct', async () => {
    await markProgress(db, jobId, 'direct', 'running');
    const registry = await loadRegistry(db);
    const d = await direct({ product: input.product, brief: brief.brief as StrategistOutput, shortlist: list as Shortlist, registry, language: input.language }, {
      llm: deps.llm, model: deps.env.ADFORGE_LLM_DIRECTOR, effort: deps.env.ADFORGE_LLM_EFFORT_DIRECTOR, idempotencyKey: `${jobId}:direct`,
    });
    // One provider_calls row per Director call (first + repair), with real cost and latency (P5 final review I2).
    for (const c of d.calls) {
      await recordCall(db, {
        jobId, kind: 'llm', provider: deps.llm.id, model: deps.env.ADFORGE_LLM_DIRECTOR, idempotencyKey: c.idempotencyKey,
        result: toWire(c.result),
        latencyMs: c.result.status === 'done' ? c.result.latencyMs : undefined,
        costUsd: c.result.status === 'done' ? c.result.cost.amountUsd : 0,
      });
    }
    if (d.status === 'failed') {
      if (d.retryable) throw new Retry(d.error.message);
      return { error: { code: d.error.code, message: d.error.message } };
    }
    if (d.status === 'violations') return { error: { violations: d.violations } };
    const exp = (list as Shortlist).experimental;
    for (const v of d.output.variants) {
      await db.insert(variants).values({
        jobId, variantNo: v.variant_no, formatSlug: v.format, hookSlug: v.hook_archetype, archetypeSlug: brief.brief.archetype_primary,
        visualTreatment: v.visual_treatment, strategicBet: v.strategic_bet,
        isExploratory: !!exp && v.variant_no === 3, direction: v, status: 'running',
      }).onConflictDoNothing();
    }
    await markProgress(db, jobId, 'direct', 'done', `repairs=${d.repairs}`);
    return { variants: d.output.variants };
  });
  if ('error' in direction) return fail('direct', direction.error);
  const vs = direction.variants as DirectorVariant[];
  const warnings: string[] = [];
  const oneVariant = (n: number) => and(eq(variants.jobId, jobId), eq(variants.variantNo, n));
  const failVariant = async (n: number, why: string) => {
    warnings.push(`variant ${n}: ${why}`);
    await step.run(`variant-failed:${n}`, async () => {
      await db.update(variants).set({ status: 'failed', error: { why } }).where(oneVariant(n));
      return true;
    });
  };

  // --- heavy lane, batched by model -----------------------------------------------------------
  await step.run('mark:plates', () => markProgress(db, jobId, 'plates', 'running').then(() => true));
  const plates = await step.heavy('plates', 'heavy:plates', { jobId, variants: vs, photoKey: input.photoKeys[0]! });
  await step.run('mark:plates:done', () => markProgress(db, jobId, 'plates', 'done').then(() => true));

  let broll: Record<string, { beat: number; key: string; durationSec: number } | null> = {};
  if (input.broll) {
    await step.run('mark:broll', () => markProgress(db, jobId, 'broll', 'running').then(() => true));
    broll = await step.heavy('broll', 'heavy:broll', { jobId, variants: vs, plates: plates.plates });
    for (const v of vs) if (!broll[v.variant_no]) warnings.push(`variant ${v.variant_no}: b-roll unavailable, using plate`);
    await step.run('mark:broll:done', () => markProgress(db, jobId, 'broll', 'done').then(() => true));
  } else {
    await step.run('mark:broll:skipped', () => markProgress(db, jobId, 'broll', 'skipped').then(() => true));
  }

  await step.run('mark:voice', () => markProgress(db, jobId, 'voice', 'running').then(() => true));
  const voice = await step.heavy('voice', 'heavy:voice', { jobId, language: input.language, variants: vs });
  await step.run('mark:voice:done', () => markProgress(db, jobId, 'voice', 'done').then(() => true));

  let completed = 0;
  for (const v of vs) {
    const n = v.variant_no;
    const beats = v.scenes.map((_, b) => ({ plate: plates.plates[`${n}:${b}`], voice: voice[`${n}:${b}`] }));
    if (!plates.cutout || beats.some((x) => !x.plate || !x.voice)) {
      await failVariant(n, 'missing plate, cutout or voice');
      continue;
    }
    // A spec that won't build is deterministic — retrying can't fix it, so it fails this variant only.
    const built = await step.run(`spec:${n}`, async () => {
      try {
        const spec = buildSpec({
          id: `${jobId}-v${n}`,
          variant: v,
          beats: beats.map((x, b) => ({
            plate: x.plate!, cutout: plates.cutout!, voice: { key: x.voice!.key, durationSec: x.voice!.durationSec }, words: x.voice!.words,
            ...(broll[n]?.beat === b ? { broll: { key: broll[n]!.key, durationSec: broll[n]!.durationSec } } : {}),
          })),
        });
        await db.update(variants).set({ spec }).where(oneVariant(n));
        return { spec };
      } catch (e) {
        return { error: e instanceof Error ? e.message : String(e) };
      }
    });
    if ('error' in built) { await failVariant(n, `spec failed: ${built.error}`); continue; }
    await step.run(`mark:render:${n}`, () => markProgress(db, jobId, 'render', 'running', `variant ${n}`).then(() => true));
    const out = await step.heavy('render', `heavy:render:${n}`, { jobId, variantNo: n, spec: built.spec as VideoSpec });
    if ('error' in out) { await failVariant(n, `render failed: ${out.error}`); continue; }
    await step.run(`variant-done:${n}`, async () => {
      await db.update(variants).set({ status: 'completed', renderAssetId: out.assetId }).where(oneVariant(n));
      return true;
    });
    completed++;
  }

  return step.run('finalize', async () => {
    const calls = await db.select({ c: providerCalls.costUsd }).from(providerCalls).where(eq(providerCalls.jobId, jobId));
    const cost = calls.reduce((s, x) => s + (x.c ?? 0), 0);
    const status = completed > 0 ? 'completed' : 'failed';
    await setJobStatus(db, jobId, { status, costUsd: cost, completedAt: new Date(), error: warnings.length ? { warnings } : null });
    await markProgress(db, jobId, 'finalize', status === 'completed' ? 'done' : 'failed', `${completed}/3 variants`);
    return { status, warnings } as Out;
  });
}
