import './load-env';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { REPO_ROOT } from '@adforge/core/config/env';
import { PIPELINE } from '@adforge/core/config/pipeline';

/**
 * B4 hosted queue, end to end against the Vercel production deployment + Inngest Cloud (production env) + dev Supabase/R2 (until B6). GPU-FREE: ComfyUI, voice, voice-qwen and vision
 * are never started, so both jobs are EXPECTED to fail at preflight (that is a PASS condition).
 * Run: E2E_BASE_URL=https://<production-url> E2E_SESSION_COOKIE='<Cookie header value>' pnpm e2e:hosted-queue (INNGEST_ENV must stay unset)
 * plus the worker's prod-profile env in .env (ADFORGE_ENV=prod, DATABASE_URL, R2_*, INNGEST_SIGNING_KEY, INNGEST_EVENT_KEY, ADFORGE_WORKER_ID=gpu-dev-1).
 * Prints statuses, positions, ETAs, stages and job ids only. Never secrets, cookies or signed URLs.
 */
const REQUIRED = ['E2E_BASE_URL', 'E2E_SESSION_COOKIE', 'ADFORGE_ENV', 'DATABASE_URL', 'INNGEST_SIGNING_KEY', 'INNGEST_EVENT_KEY', 'ADFORGE_WORKER_ID', 'R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY'];
const missing = REQUIRED.filter((k) => !process.env[k]);
if (missing.length) { console.error(`Missing env: ${missing.join(', ')}`); process.exit(2); }
if (process.env.ADFORGE_ENV !== 'prod') { console.error('ADFORGE_ENV must be prod'); process.exit(2); }
if (process.env.INNGEST_ENV) { console.error('INNGEST_ENV must be unset: only the Inngest production environment is used'); process.exit(2); }
if (process.platform !== 'win32') { console.error('This check uses taskkill/Get-NetTCPConnection: Windows only'); process.exit(2); }
const BASE = process.env.E2E_BASE_URL!.replace(/\/+$/, '');
if (!BASE.startsWith('https://')) { console.error('E2E_BASE_URL must be https'); process.exit(2); }
const COOKIE = process.env.E2E_SESSION_COOKIE!;

const checks: [string, boolean][] = [];
const check = (name: string, ok: boolean, note = '') => { checks.push([name, ok]); console.log(`  ${ok ? 'PASS' : 'FAIL'} ${name}${note ? ` - ${note}` : ''}`); };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Queue = { position: number; etaRange: [number, number] | 'paused' } | null;
type View = { job: { id: string; status: string; progress: { stage: string; status: string }[] }; queue?: Queue };
const TERMINAL = new Set(['completed', 'failed']);

const api = (path: string, init: RequestInit = {}) => fetch(`${BASE}${path}`, {
  ...init, signal: AbortSignal.timeout(15_000),
  headers: { cookie: COOKIE, origin: BASE, ...(init.body ? { 'content-type': 'application/json' } : {}), ...init.headers },
});

async function submitJob(label: string): Promise<string> {
  // Unique per run: a random 4x4 patch changes the pixels, so the sha and key are new.
  const base = readFileSync(join(REPO_ROOT, 'fixtures', 'eval-products', 'krishna-hing-ras', '1-tins.jpg'));
  const [r, g, b] = randomBytes(3);
  const patch = await sharp({ create: { width: 4, height: 4, channels: 3, background: { r: r!, g: g!, b: b! } } }).png().toBuffer();
  const photo = await sharp(base).composite([{ input: patch, left: 0, top: 0 }]).jpeg({ quality: 92 }).toBuffer();
  const mintRes = await api('/api/uploads', { method: 'POST', body: JSON.stringify({ mime: 'image/jpeg', bytes: photo.length, sha256: createHash('sha256').update(photo).digest('hex') }) });
  const m = (await mintRes.json().catch(() => ({}))) as { key?: string; url?: string; headers?: Record<string, string>; exists?: boolean };
  if (!mintRes.ok || !m.key) throw new Error(`${label}: mint failed (HTTP ${mintRes.status})`);
  if (!m.exists) {
    if (!m.url) throw new Error(`${label}: mint returned no upload url`);
    const put = await fetch(m.url, { method: 'PUT', headers: { ...m.headers, origin: BASE }, body: photo, signal: AbortSignal.timeout(120_000) });
    if (!put.ok && put.status !== 412) throw new Error(`${label}: R2 PUT failed (HTTP ${put.status})`);
  }
  const res = await api('/api/jobs', { method: 'POST', body: JSON.stringify({ name: `e2e hosted queue ${label}`, price: '199', description: 'B4 hosted-queue e2e job; expected to fail at preflight.', language: 'en', broll: false, photoKeys: [m.key] }) });
  const body = (await res.json().catch(() => ({}))) as { jobId?: string };
  if (res.status !== 202 || !body.jobId) throw new Error(`${label}: create job failed (HTTP ${res.status})`);
  return body.jobId;
}

async function view(id: string): Promise<View> {
  const res = await api(`/api/jobs/${encodeURIComponent(id)}`);
  if (!res.ok) throw new Error(`job ${id}: HTTP ${res.status}`);
  return (await res.json()) as View;
}
const failedStage = (v: View) => v.job.progress.find((p) => p.status === 'failed')?.stage ?? 'none';

/** Polls until fn returns a value or the deadline passes. Transient errors count as "not yet". */
async function until<T>(ms: number, everyMs: number, fn: () => Promise<T | undefined>): Promise<T | undefined> {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(everyMs)) {
    const v = await fn().catch(() => undefined);
    if (v !== undefined) return v;
  }
  return undefined;
}

// --- worker child process (hidden; output discarded so nothing secret can reach this console) ---
let worker: ChildProcess | undefined;
function startWorker() {
  worker = spawn('pnpm', ['--filter', '@adforge/worker', 'start'], { cwd: REPO_ROOT, shell: true, windowsHide: true, stdio: 'ignore', env: process.env });
}
function stopWorker() {
  if (worker?.pid) { try { execFileSync('taskkill', ['/PID', String(worker.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* already gone */ } }
  worker = undefined;
}
/** LISTEN sockets (addr:port) owned by the worker's process tree; `exposed` = the non-loopback ones. */
function treeListeners(rootPid: number): { all: string[]; exposed: string[] } {
  const ps = [
    `$ids=@(${rootPid});$more=$true`,
    'while($more){$more=$false;Get-CimInstance Win32_Process|Where-Object{$ids -contains $_.ParentProcessId -and $ids -notcontains $_.ProcessId}|ForEach-Object{$ids+=$_.ProcessId;$more=$true}}',
    'Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue|Where-Object{$ids -contains $_.OwningProcess}|ForEach-Object{"$($_.LocalAddress):$($_.LocalPort)"}',
  ].join('\n');
  const out = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps]).toString().split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  return { all: out, exposed: out.filter((a) => !/^(127\.0\.0\.1|::1):/.test(a)) };
}

const freshSec = PIPELINE.jobs.heartbeatFreshSec;
const ids: string[] = [];
try {
  // 1. Worker is STOPPED: submit two jobs. Nothing can dispatch them, so they stay queued.
  for (const l of ['a', 'b']) ids.push(await submitJob(l));
  check('two jobs created through the deployment', ids.length === 2, ids.join(', '));

  // 2. Core queue assertion: adjacent positions (leftover queued jobs on the shared DB shift the absolute ones), both 'paused'. Waits out a stale heartbeat (heartbeatFreshSec + margin).
  const paused = await until((freshSec + 60) * 1000, 5_000, async () => {
    const vs = await Promise.all(ids.map(view));
    return vs.every((v) => v.queue?.etaRange === 'paused') ? vs : undefined;
  });
  const now = paused ?? await Promise.all(ids.map(view));
  const p = now.map((v) => v.queue?.position ?? 0).sort((x, y) => x - y);
  console.log(`  statuses before worker start: ${now.map((v) => `${v.job.status}/${v.queue ? (v.queue.etaRange === 'paused' ? 'paused' : 'eta') : 'no-queue'}`).join(' ')}`);
  check("adjacent positions (n, n+1), both etaRange 'paused', jobs still queued", !!paused && p[0]! >= 1 && p[1] === p[0]! + 1 && now.every((v) => v.job.status === 'queued'),
    paused ? `positions ${p.join('/')}` : 'never paused: another worker heartbeat is probably fresh (stop it) or the job view lacks queue');

  // 3. Start the worker; both jobs dispatch and reach a terminal state (failed at preflight is expected: no ComfyUI).
  if (paused) {
    startWorker();
    console.log('  worker started');
    let etaLogged = false;
    const done = await until(360_000, 3_000, async () => {
      const vs = await Promise.all(ids.map(view));
      const eta = vs.find((v) => v.queue && v.queue.etaRange !== 'paused');
      if (eta && !etaLogged) { etaLogged = true; console.log(`  numeric ETA observed (not asserted): position ${eta.queue!.position} eta ${JSON.stringify(eta.queue!.etaRange)}`); }
      return vs.every((v) => TERMINAL.has(v.job.status)) ? vs : undefined;
    });
    check('both jobs dispatch and reach a terminal state within 6 min', !!done, done ? done.map((v) => `${v.job.id}: ${v.job.status} at stage ${failedStage(v)}`).join('; ') : 'timed out');
    if (done) check('jobs failed at preflight (no ComfyUI; expected)', done.every((v) => v.job.status === 'failed' && failedStage(v) === 'preflight'), done.map((v) => `${v.job.status}/${failedStage(v)}`).join(' '));
    // No inbound port, checked while the worker is still running.
    const l = treeListeners(worker!.pid!);
    check('worker process tree has no non-loopback listener', l.exposed.length === 0, `${l.all.length} listener(s) total${l.exposed.length ? `, exposed: ${l.exposed.join(' ')}` : ''}`);
    check('worker process tree opens no listener at all (prod)', l.all.length === 0, l.all.join(' '));
  }
} catch (e) {
  check('run completed', false, e instanceof Error ? e.message : String(e));
} finally {
  stopWorker();
}
await sleep(1500);
let leftover = -1;
try {
  leftover = Number(execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command',
    "(Get-CimInstance Win32_Process|Where-Object{$_.CommandLine -like '*worker*src*main.ts*' -and $_.ProcessId -ne $PID}|Measure-Object).Count"]).toString().trim());
} catch { /* count unknown -> fails below */ }
check('no worker process left running', leftover === 0, `${leftover} found`);
console.log(`\n${checks.every((c) => c[1]) ? 'PASS' : 'FAIL'}`);
process.exit(checks.length && checks.every((c) => c[1]) ? 0 : 1);
