import { describe, expect, it } from 'vitest';
import type { JobView } from '../lib/api';
import { STAGES, briefSummary, isTerminal, nextPollDelay, stageRows, validateUpload, variantCards } from '../lib/view';

const file = (name: string, type: string, mb: number) => ({ name, type, size: mb * 1024 * 1024 });
const ok = { name: 'Serum', price: '₹899', description: 'Niacinamide.', language: 'en', files: [1, 2, 3].map((i) => file(`${i}.png`, 'image/png', 1)) };

describe('validateUpload', () => {
  it('accepts a valid upload', () => expect(validateUpload(ok)).toEqual([]));
  it('requires 3–5 photos of allowed types, each ≤ 5 MB', () => {
    expect(validateUpload({ ...ok, files: ok.files.slice(0, 2) }).join()).toMatch(/3–5 photos/);
    expect(validateUpload({ ...ok, files: Array.from({ length: 6 }, (_, i) => file(`${i}.png`, 'image/png', 1)) }).join()).toMatch(/3–5 photos/);
    expect(validateUpload({ ...ok, files: [...ok.files.slice(0, 2), file('big.png', 'image/png', 6)] }).join()).toMatch(/big\.png.*5 MB/);
    expect(validateUpload({ ...ok, files: [...ok.files.slice(0, 2), file('a.gif', 'image/gif', 1)] }).join()).toMatch(/a\.gif/);
  });
  it('requires name, price, description and a known language', () => {
    const e = validateUpload({ ...ok, name: ' ', price: '', description: '', language: 'fr' }).join();
    expect(e).toMatch(/name/);
    expect(e).toMatch(/price/);
    expect(e).toMatch(/description/);
    expect(e).toMatch(/language/);
  });
});

describe('stageRows', () => {
  it('shows every stage in order with its latest status', () => {
    const rows = stageRows([
      { stage: 'preflight', status: 'running', at: 't1' },
      { stage: 'preflight', status: 'done', at: 't2' },
      { stage: 'broll', status: 'skipped', at: 't3' },
      { stage: 'render', status: 'running', at: 't4', detail: 'variant 2' },
    ]);
    expect(rows.map((r) => r.stage)).toEqual([...STAGES]);
    expect(rows.find((r) => r.stage === 'preflight')!.status).toBe('done');
    expect(rows.find((r) => r.stage === 'broll')!.status).toBe('skipped');
    expect(rows.find((r) => r.stage === 'render')).toMatchObject({ status: 'running', detail: 'variant 2' });
    expect(rows.find((r) => r.stage === 'voice')!.status).toBe('pending');
  });
});

describe('polling', () => {
  it('stops on terminal statuses and backs off after errors', () => {
    expect(isTerminal('completed')).toBe(true);
    expect(isTerminal('failed')).toBe(true);
    expect(isTerminal('running')).toBe(false);
    expect([0, 1, 2, 3, 9].map(nextPollDelay)).toEqual([3000, 6000, 12000, 15000, 15000]);
  });
});

const view = (statuses: string[], errors: unknown[] = []): JobView => ({
  job: { id: 'j', status: 'completed', progress: [], brief: null, error: null, costUsd: 0, createdAt: 'x', completedAt: 'y' },
  variants: statuses.map((status, i) => ({
    variantNo: i + 1, formatSlug: 'problem_solution', formatFamily: 'narrative_arc', hookSlug: 'curiosity_gap', hookFamily: 'tension',
    visualTreatment: 'macro_texture', strategicBet: `bet ${i + 1}`, isExploratory: i === 2, status: status as JobView['variants'][number]['status'],
    error: errors[i] ?? null,
    renderUrl: status === 'failed' ? null : `http://127.0.0.1:3001/media/v${i + 1}.mp4`,
  })),
});

describe('variantCards', () => {
  it('renders a partial job as two playable cards and one failed card', () => {
    const cards = variantCards(view(['completed', 'approved', 'failed']));
    expect(cards.map((c) => [c.status, c.canApprove, !!c.videoUrl])).toEqual([
      ['completed', true, true],
      ['approved', false, true],
      ['failed', false, false],
    ]);
    expect(cards[0]!.title).toBe('problem_solution × curiosity_gap');
    expect(cards[0]!.families).toBe('narrative_arc · tension');
    expect(cards[2]!.title).toContain('exploratory');
  });
  it('surfaces the worker failure reason, else a generic message', () => {
    const cards = variantCards(view(['failed', 'failed', 'failed'], [{ why: 'render timed out' }, null, { why: 5 }]));
    expect(cards[0]!.failureReason).toBe('render timed out');
    expect(cards[1]!.failureReason).toMatch(/failed/);
    expect(cards[2]!.failureReason).toMatch(/failed/);
  });
});

describe('briefSummary', () => {
  it('reads the Strategist brief safely, including Devanagari text', () => {
    expect(briefSummary({ archetype_primary: 'remedy', archetype_secondary: 'trust', rationale: 'असली कारण', core_objection: 'price' }))
      .toEqual({ archetypes: 'remedy + trust', rationale: 'असली कारण', objection: 'price' });
    expect(briefSummary(null)).toBeNull();
    expect(briefSummary({ nope: 1 })).toBeNull();
  });
});
