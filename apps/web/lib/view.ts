import type { JobView } from './api';

export const STAGES = ['preflight', 'normalize', 'strategize', 'direct', 'plates', 'broll', 'voice', 'render', 'finalize'] as const;
const LABELS: Record<(typeof STAGES)[number], string> = {
  preflight: 'Checking services', normalize: 'Checking photos', strategize: 'Reading the product', direct: 'Writing three variants', plates: 'Generating scenes',
  broll: 'AI b-roll', voice: 'Voice-over + captions', render: 'Rendering videos', finalize: 'Finishing',
};
const TYPES = ['image/png', 'image/jpeg', 'image/webp'];
const MAX = 10 * 1024 * 1024;

export function validateUpload(i: { name: string; price: string; description: string; language: string; files: { name: string; type: string; size: number }[] }): string[] {
  const e: string[] = [];
  if (!i.name.trim()) e.push('Product name is required.');
  if (!i.price.trim()) e.push('Enter the product price.');
  if (!i.description.trim()) e.push('A one-paragraph description is required.');
  if (!['en', 'hi', 'hinglish'].includes(i.language)) e.push('Choose a voice-over language.');
  if (i.files.length < 3 || i.files.length > 5) e.push(`Add 3–5 photos (you added ${i.files.length}).`);
  for (const f of i.files) {
    if (!TYPES.includes(f.type)) e.push(`${f.name}: use PNG, JPEG or WebP.`);
    else if (f.size > MAX) e.push(`${f.name}: larger than 10 MB.`);
  }
  return e;
}

type Row = { stage: string; label: string; status: 'pending' | 'running' | 'done' | 'failed' | 'skipped'; detail?: string };
export function stageRows(progress: JobView['job']['progress']): Row[] {
  return STAGES.map((stage) => {
    const last = [...progress].reverse().find((p) => p.stage === stage);
    return { stage, label: LABELS[stage], status: last?.status ?? 'pending', ...(last?.detail ? { detail: last.detail } : {}) };
  });
}

export const isTerminal = (s: string) => s === 'completed' || s === 'failed';
export const nextPollDelay = (errors: number) => Math.min(15_000, 3_000 * 2 ** errors);

const why = (e: unknown): string | null => {
  const w = e && typeof e === 'object' ? (e as Record<string, unknown>).why : null;
  return typeof w === 'string' && w ? w : null;
};

export function variantCards(view: JobView) {
  const terminal = isTerminal(view.job.status);
  return view.variants.map((v) => ({
    variantNo: v.variantNo,
    title: `${v.formatSlug} × ${v.hookSlug}${v.isExploratory ? ' (exploratory)' : ''}`,
    families: `${v.formatFamily ?? '?'} · ${v.hookFamily ?? '?'}`,
    bet: v.strategicBet,
    status: v.status,
    canApprove: v.status === 'completed',
    preview: v.revision?.status === 'ready' && v.revision.spec ? { spec: v.revision.spec, assetUrls: v.revision.assetUrls, locked: v.revision.locked } : null,
    videoUrl: v.status === 'completed' || v.status === 'approved' ? v.renderUrl : null,
    ...(v.status === 'failed' ? { failureReason: why(v.error) ?? 'This variant failed — see the job log.' } : {}),
    ...(terminal && v.status !== 'failed' && !(['completed', 'approved'].includes(v.status) && v.renderUrl) ? { placeholder: 'Not rendered' } : {}),
  }));
}

/** Partial-success notes (e.g. "b-roll unavailable") the pipeline stores in job.error.warnings, shown even when completed. */
export function jobWarnings(view: JobView): string[] {
  const w = (view.job.error as { warnings?: unknown } | null)?.warnings;
  return Array.isArray(w) ? w.filter((x): x is string => typeof x === 'string') : [];
}

const str = (x: unknown) => (typeof x === 'string' && x ? x : null);
const firstViolation = (x: unknown) => str((((x as { violations?: unknown })?.violations as { message?: unknown }[] | undefined)?.[0])?.message);

export function failMessage(job: JobView['job']): string {
  const e = (job.error ?? {}) as { reason?: unknown; why?: unknown; message?: unknown };
  const r = e.reason;
  const s = str(r) ?? str(e.why) ?? (r && typeof r === 'object' ? str((r as { message?: unknown }).message) ?? firstViolation(r) : null)
    ?? str(e.message) ?? firstViolation(e) ?? str([...job.progress].reverse().find((p) => p.status === 'failed')?.detail);
  return s ? `This job failed: ${s}` : 'This job failed — see the worker log.';
}

export function briefSummary(brief: unknown): { archetypes: string; rationale: string; objection: string } | null {
  if (!brief || typeof brief !== 'object') return null;
  const b = brief as Record<string, unknown>;
  if (typeof b.archetype_primary !== 'string' || typeof b.rationale !== 'string') return null;
  return {
    archetypes: [b.archetype_primary, b.archetype_secondary].filter(Boolean).join(' + '),
    rationale: b.rationale,
    objection: typeof b.core_objection === 'string' ? b.core_objection : '',
  };
}
