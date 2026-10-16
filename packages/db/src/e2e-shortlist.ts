import { join } from 'node:path';
import { REPO_ROOT, parseEnv } from '@adforge/core/config/env';
import { assertVariantDiversity } from '@adforge/core/vocab/diversity';
import { shortlist } from '@adforge/core/vocab/shortlist';
import { openDb } from './client';
import { loadRegistry } from './registry';

try {
  process.loadEnvFile(join(REPO_ROOT, '.env'));
} catch (e) {
  if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
}
const env = parseEnv(process.env);
const { db, close } = await openDb(env.ADFORGE_DATA_DIR);
let ok = true;
try {
  const registry = await loadRegistry(db);
  for (const [p, s] of [['remedy', 'trust'], ['indulgence', 'identity'], ['utility', 'upgrade']] as const) {
    const list = shortlist({ archetypePrimary: p, archetypeSecondary: s }, registry);
    console.log(`\n${p} + ${s}`);
    console.log('  formats:', list.formats.map((f) => `${f.slug}(${f.family},${f.score})`).join(' '));
    console.log('  hooks:  ', list.hooks.map((h) => `${h.slug}(${h.family})`).join(' '));
    console.log('  experimental:', list.experimental?.slug ?? '—');
  }
  const pass = assertVariantDiversity(
    [
      { hookSlug: 'pattern_break', formatSlug: 'problem_solution' },
      { hookSlug: 'stat_shock', formatSlug: 'ugc_testimonial' },
      { hookSlug: 'curiosity_gap', formatSlug: 'objection_kill' },
    ],
    registry,
  );
  const fail = assertVariantDiversity(
    [
      { hookSlug: 'pattern_break', formatSlug: 'problem_solution' },
      { hookSlug: 'confession', formatSlug: 'before_after' },
      { hookSlug: 'stat_shock', formatSlug: 'problem_solution' },
    ],
    registry,
  );
  console.log('\npassing trio violations:', pass);
  console.log('failing trio violations:', fail.map((v) => v.message));
  ok = pass.length === 0 && fail.some((v) => v.rule === 'hook_family') && fail.some((v) => v.rule === 'format_family');
} finally {
  await close();
}
console.log(ok ? '\nSHORTLIST E2E OK' : '\nSHORTLIST E2E FAILED');
process.exit(ok ? 0 : 1);
