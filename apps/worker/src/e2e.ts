import { readFileSync, readdirSync } from 'node:fs';
import { extname, join } from 'node:path';
import { REPO_ROOT } from '@adforge/core/config/env';

/** Posts one of the user's eval products to the running worker and waits for three MP4s. */
const slug = process.argv[2];
const broll = process.argv.includes('--broll');
if (!slug) { console.error('usage: pnpm e2e:pipeline <eval-product-slug> [--broll]'); process.exit(1); }
const base = process.env.ADFORGE_WORKER_URL ?? 'http://127.0.0.1:3001';
const dir = join(REPO_ROOT, 'fixtures', 'eval-products', slug);
const meta = JSON.parse(readFileSync(join(dir, 'product.json'), 'utf8')) as Record<string, string>;
const TYPES: Record<string, string> = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' };

const form = new FormData();
meta.price = meta.price!.replace(/\s*\(.*\)\s*$/, ''); // fixture notes like "(estimate ...)" exceed the 40-char price limit
for (const k of ['name', 'price', 'description', 'language']) form.append(k, meta[k]!);
if (broll) form.append('broll', 'on');
for (const f of readdirSync(dir).filter((f) => extname(f).toLowerCase() in TYPES)) {
  form.append('photos', new File([readFileSync(join(dir, f))], f, { type: TYPES[extname(f).toLowerCase()]! }));
}

const t0 = Date.now();
const res = await fetch(`${base}/api/jobs`, { method: 'POST', body: form });
if (res.status !== 202) { console.error('create failed', res.status, await res.text()); process.exit(1); }
const { jobId } = (await res.json()) as { jobId: string };
console.log(`job ${jobId} (b-roll ${broll ? 'on' : 'off'}) — Inngest UI: http://127.0.0.1:8288`);

const deadline = Date.now() + (broll ? 75 : 45) * 60_000;
let last = '';
for (;;) {
  const j = (await (await fetch(`${base}/api/jobs/${jobId}`)).json()) as {
    job: { status: string; progress: { stage: string; status: string; detail?: string }[]; error: unknown; costUsd: number };
    variants: { variantNo: number; formatSlug: string; hookSlug: string; status: string; renderUrl: string | null; strategicBet: string }[];
  };
  const p = j.job.progress.at(-1);
  const line = p ? `${p.stage}:${p.status}${p.detail ? ` (${p.detail})` : ''}` : j.job.status;
  if (line !== last) { console.log(`  [${((Date.now() - t0) / 60_000).toFixed(1)}m] ${line}`); last = line; }
  if (j.job.status === 'completed' || j.job.status === 'failed') {
    console.log(`\n${j.job.status.toUpperCase()} in ${((Date.now() - t0) / 60_000).toFixed(1)} min, ~$${j.job.costUsd.toFixed(4)}`, j.job.error ?? '');
    for (const v of j.variants) console.log(`  V${v.variantNo} ${v.formatSlug} + ${v.hookSlug} [${v.status}] ${v.renderUrl ?? ''}\n     bet: ${v.strategicBet}`);
    process.exit(j.job.status === 'completed' && j.variants.filter((v) => v.status === 'completed').length === 3 ? 0 : 1);
  }
  if (Date.now() > deadline) { console.error('TIMED OUT waiting for the job'); process.exit(1); }
  await new Promise((r) => setTimeout(r, 5000));
}
