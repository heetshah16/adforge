// Usage: node scripts/supabase-auth-config.mjs <project-ref> [--site-url <url>] [--prod]
// Applies AdForge's auth + Data API settings through the Supabase Management API.
// Reads SUPABASE_TOKEN from repo-root .env.supabase. Prints field names and non-secret values only.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const ref = args.find((a) => /^[a-z0-9]{20}$/.test(a));
const opt = (n) => args[args.indexOf(n) + 1];
const prod = args.includes('--prod');
if (!ref) {
  console.error('usage: node scripts/supabase-auth-config.mjs <project-ref> [--site-url <url>] [--prod]');
  process.exit(2);
}
const site = (args.includes('--site-url') ? opt('--site-url') : 'http://localhost:3000').replace(/\/$/, '');

// .env.supabase uses "KEY = value" with spaces.
const envText = readFileSync(fileURLToPath(new URL('../.env.supabase', import.meta.url)), 'utf8');
const token = envText
  .split(/\r?\n/)
  .map((l) => l.match(/^\s*SUPABASE_TOKEN\s*=\s*(.*?)\s*$/))
  .find(Boolean)?.[1]
  .replace(/^["']|["']$/g, '');
if (!token) throw new Error('SUPABASE_TOKEN missing in .env.supabase');

const base = `https://api.supabase.com/v1/projects/${ref}`;
async function call(path, method, body) {
  const r = await fetch(base + path, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) throw new Error(`${method} ${path} -> ${r.status} ${(await r.text()).slice(0, 200)}`);
  return r.json();
}

// {{ .RedirectTo }} is the emailRedirectTo / invite redirectTo = <ADFORGE_SITE_URL>/auth/confirm.
// Do not use {{ .ConfirmationURL }}: it goes through Supabase's /verify and skips our /auth/confirm.
const link = (type) => `{{ .RedirectTo }}?token_hash={{ .TokenHash }}&type=${type}`;
const desiredAuth = {
  site_url: site,
  uri_allow_list: `${site}/auth/confirm`, // exact entries only, comma-separated, no wildcards
  disable_signup: prod, // ADR 0015 recommends false even in prod: provision enforces the invite gate
  mailer_autoconfirm: false, // "Confirm email" ON: the invite gate trusts claims.email
};
// Supabase rejects template edits (400) on projects using the default email provider.
// They apply only once custom SMTP is set (B6). Until then the default templates stay.
const desiredTemplates = {
  mailer_subjects_magic_link: 'Your AdForge sign-in link',
  mailer_templates_magic_link_content: `<h2>Your sign-in link</h2>\n<p>Follow the link below to sign in. It expires shortly and works once.</p>\n<p><a href="${link('email')}">Sign in</a></p>`,
  mailer_subjects_invite: "You've been invited to AdForge",
  mailer_templates_invite_content: `<h2>You've been invited</h2>\n<p>Follow the link below to accept your invitation.</p>\n<p><a href="${link('invite')}">Accept invitation</a></p>`,
};
// '' = expose no schema through PostgREST/GraphQL. The app uses Drizzle over a direct connection only.
const desiredRest = { db_schema: '' };

async function apply(path, desired) {
  const before = await call(path, 'GET');
  const changed = Object.keys(desired).filter((k) => before[k] !== desired[k]);
  if (changed.length) await call(path, 'PATCH', Object.fromEntries(changed.map((k) => [k, desired[k]])));
  const after = await call(path, 'GET');
  const bad = Object.keys(desired).filter((k) => after[k] !== desired[k]);
  console.log(`${path}: changed [${changed.join(', ') || 'none'}]`);
  if (bad.length) throw new Error(`${path}: not applied: ${bad.join(', ')}`);
  return after;
}

const hasSmtp = Boolean((await call('/config/auth', 'GET')).smtp_host);
if (!hasSmtp) console.log('WARNING: no custom SMTP; email templates NOT applied (default templates cannot carry token_hash links)');
const a = await apply('/config/auth', hasSmtp ? { ...desiredAuth, ...desiredTemplates } : desiredAuth);
await apply('/postgrest', desiredRest);
console.log(`verified: site_url=${a.site_url} uri_allow_list=${a.uri_allow_list} disable_signup=${a.disable_signup} mailer_autoconfirm=${a.mailer_autoconfirm} db_schema=''`);
