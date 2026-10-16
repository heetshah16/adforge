import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { REPO_ROOT, parseEnv } from '@adforge/core/config/env';
import { direct } from '@adforge/core/llm/direct';
import { strategize } from '@adforge/core/llm/strategize';
import { Language } from '@adforge/core/vocab/enums';
import { shortlist } from '@adforge/core/vocab/shortlist';
import { openDb } from '@adforge/db/client';
import { loadRegistry } from '@adforge/db/registry';
import { ClaudeAgentProvider } from './adapter';

try {
  process.loadEnvFile(join(REPO_ROOT, '.env'));
} catch (e) {
  if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
}
const env = parseEnv(process.env);
const MIME = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' } as const;
const root = join(REPO_ROOT, 'fixtures', 'eval-products');
const products = readdirSync(root).filter((d) => statSync(join(root, d)).isDirectory());
if (products.length < 2) {
  console.error(`Need 2 products in ${root} (product.json + 3–5 photos each). Found ${products.length}.`);
  process.exit(1);
}

const { db, close } = await openDb(env.ADFORGE_DATA_DIR);
const registry = await loadRegistry(db).finally(close);
const llm = new ClaudeAgentProvider();
let ok = true;

for (const slug of products) {
  const dir = join(root, slug);
  const raw = JSON.parse(readFileSync(join(dir, 'product.json'), 'utf8')) as { name: string; price: string; description: string; language: string };
  const meta = { name: raw.name, price: raw.price, description: raw.description }; // drop extra fields (e.g. _source)
  const language = Language.parse(raw.language);
  const images = readdirSync(dir)
    .filter((f) => extname(f).toLowerCase() in MIME)
    .map((f) => {
      const bytes = readFileSync(join(dir, f));
      if (bytes.byteLength > 5 * 1024 * 1024) throw new Error(`${slug}/${f} is over 5 MB — resize it`);
      return { mime: MIME[extname(f).toLowerCase() as keyof typeof MIME], data: new Uint8Array(bytes) };
    });
  console.log(`\n=== ${slug} (${images.length} photos, ${language}) ===`);

  const t0 = Date.now();
  const s = await strategize({ product: meta, images }, registry, {
    llm, model: env.ADFORGE_LLM_STRATEGIST, effort: env.ADFORGE_LLM_EFFORT_STRATEGIST, idempotencyKey: `e2e:${slug}:strategize`,
  });
  if (s.status !== 'done') { console.error('STRATEGIZE FAILED', s.status === 'failed' ? `${s.error.code} ${s.error.message}` : s.status); ok = false; continue; }
  const brief = s.value.value;
  console.log(`strategist ${((Date.now() - t0) / 1000).toFixed(1)}s ~$${s.cost.amountUsd.toFixed(4)} cacheRead=${s.value.usage.cacheReadTokens}`);
  console.log(`  ${brief.archetype_primary} + ${brief.archetype_secondary} (${brief.confidence}) — ${brief.rationale}`);
  console.log(`  objection: ${brief.core_objection}`);

  const list = shortlist({ archetypePrimary: brief.archetype_primary, archetypeSecondary: brief.archetype_secondary }, registry);
  const t1 = Date.now();
  const d = await direct({ product: meta, brief, shortlist: list, registry, language }, {
    llm, model: env.ADFORGE_LLM_DIRECTOR, effort: env.ADFORGE_LLM_EFFORT_DIRECTOR, idempotencyKey: `e2e:${slug}:direct`,
  });
  console.log(`director ${((Date.now() - t1) / 1000).toFixed(1)}s status=${d.status}${'repairs' in d ? ` repairs=${d.repairs}` : ''}`);
  for (const c of d.calls) {
    if (c.result.status !== 'done') continue;
    const u = c.result.value.usage;
    console.log(`  [call ${c.idempotencyKey}] ${(c.result.latencyMs / 1000).toFixed(1)}s ~$${c.result.cost.amountUsd.toFixed(4)} in=${u.inputTokens} out=${u.outputTokens} cacheRead=${u.cacheReadTokens} cacheCreate=${u.cacheCreationTokens}`);
  }
  if (d.status === 'failed') { console.error('  ', d.error.code, d.error.message); ok = false; continue; }
  for (const v of d.output.variants) {
    const fam = (slugs: { slug: string; family: string | null }[], s: string) => slugs.find((x) => x.slug === s)?.family;
    console.log(`  V${v.variant_no} ${v.format}(${fam(registry.formats, v.format)}) + ${v.hook_archetype}(${fam(registry.hooks, v.hook_archetype)}) [${v.visual_treatment}]`);
    console.log(`     hook: "${v.hook_text}"  bet: ${v.strategic_bet}`);
  }
  if (d.status === 'ok') {
    // Saved outside the repo so the P6 voice e2e can voice real Director output.
    const outDir = join(env.ADFORGE_DATA_DIR, 'e2e', 'directions');
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, `${slug}.json`), JSON.stringify({ slug, language, output: d.output }, null, 2));
  }
  if (d.status === 'violations') { console.error('  VIOLATIONS:', d.violations.map((x) => x.message)); ok = false; }
}
console.log(ok ? '\nLLM E2E OK' : '\nLLM E2E FAILED');
process.exit(ok ? 0 : 1);
