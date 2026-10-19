import { afterEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { variantRevisions, variants } from '@adforge/db/schema';
import { generateAds } from '../src/orchestrate';
import { makeDeps, memoStep, newJob } from './fakes';

let close: (() => Promise<void>) | undefined;
afterEach(async () => { await close?.(); close = undefined; });

describe('revision 0', () => {
  it('a completed run leaves exactly one locked ready revision 0 per variant, plus project_base; a rerun adds none', async () => {
    const m = await makeDeps(); close = m.close;
    const id = await newJob(m.deps);
    await generateAds(id, memoStep(m.deps), m.deps);
    await generateAds(id, memoStep(m.deps), m.deps).catch(() => undefined); // fresh step cache: re-runs the step bodies
    const vs = await m.deps.db.select().from(variants).where(eq(variants.jobId, id));
    expect(vs).toHaveLength(3);
    for (const v of vs) {
      expect(v.projectBase).toMatchObject({ id: `${id}-v${v.variantNo}`, theme: expect.any(Object), variant: { variant_no: v.variantNo } });
      const revs = await m.deps.db.select().from(variantRevisions).where(eq(variantRevisions.variantId, v.id));
      expect(revs).toHaveLength(1);
      expect(revs[0]).toMatchObject({ parentId: null, ops: [], status: 'ready', locked: true, orgId: v.orgId, spec: v.spec });
      expect((revs[0]!.beats as unknown[]).length).toBeGreaterThan(0);
    }
  });
});
