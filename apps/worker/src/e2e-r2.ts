import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { REPO_ROOT, parseEnv } from '@adforge/core/config/env';
import { withStorageOrg } from '@adforge/core/providers/storage-scope';
import type { MediaRef } from '@adforge/core/providers/types';
import type { VideoSpec } from '@adforge/core/spec/video-spec';
import { openPostgres } from '@adforge/db/client';
import { memberships, orgs, users } from '@adforge/db/schema';
import { seedOperator } from '@adforge/db/seed/seed';
import { withUser } from '@adforge/db/with-user';
import { normalizeStored } from '@adforge/pipeline/normalize';
import { CachedStorage } from '@adforge/provider-local-storage';
import { R2Storage } from '@adforge/provider-r2';
import { HyperframesRenderer } from '@adforge/renderer-hyperframes';
// The handlers are plain functions over a ctx and the worker has no Next runtime, so they are imported by path (cross-app, deliberate).
import { mediaHandler, type MediaCtx } from '../../web/lib/server/media-api';
import { mintUploadHandler, type UploadsCtx } from '../../web/lib/server/uploads-api';

/**
 * B3 end to end against the REAL dev R2 bucket (adforge-dev, hardcoded) and the dev Supabase DB. No GPU, LLM or Inngest.
 * Run: ADFORGE_ENV=prod ADFORGE_PROVIDER_STORAGE=r2 DATABASE_URL=... R2_*=... pnpm e2e:r2   (FFmpeg on PATH)
 * Never prints secrets or signed URLs: hostnames and statuses only.
 */
try { process.loadEnvFile(join(REPO_ROOT, '.env')); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
const env = parseEnv(process.env);
const BUCKET = 'adforge-dev'; // never prod
const ORIGIN = env.ADFORGE_UI_ORIGIN;
const checks: [string, boolean, string][] = [];
const check = (name: string, ok: boolean, note = '') => { checks.push([name, ok, note]); console.log(`  ${ok ? 'PASS' : 'FAIL'} ${name}${note ? ` - ${note}` : ''}`); };
const host = (u: string) => new URL(u).host;

/** Counts inner reads: the "second render hits only the cache" check. */
class CountingR2 extends R2Storage {
  reads = 0;
  override async read(key: string) { this.reads++; return super.read(key); }
}

function silentWav(frames: number): Uint8Array {
  const rate = 24000, n = Math.round((frames / 30) * rate);
  const b = Buffer.alloc(44 + n * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * 2, 28);
  b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(n * 2, 40);
  return b;
}

const chromeCount = () => {
  const out = process.platform === 'win32'
    ? execFileSync('tasklist', ['/FI', 'IMAGENAME eq chrome-headless-shell.exe', '/NH']).toString()
    : execFileSync('ps', ['-eo', 'args']).toString();
  return out.split('\n').filter((l) => l.includes('chrome-headless-shell')).length;
};

const { db, close } = await openPostgres(env.DATABASE_URL!, { migrate: false });
const tmp = await mkdtemp(join(tmpdir(), 'adforge-e2e-r2-'));
const cacheDir = join(tmp, 'cache');
let strangerOrgId: string | undefined;
let strangerUserId: string | undefined;
try {
  const operator = await seedOperator(db);
  const inner = new CountingR2({
    accountId: env.R2_ACCOUNT_ID!, accessKeyId: env.R2_ACCESS_KEY_ID!, secretAccessKey: env.R2_SECRET_ACCESS_KEY!,
    bucket: BUCKET, publicUrl: env.ADFORGE_PUBLIC_URL, timeoutMs: env.R2_TIMEOUT_MS,
  });
  const storage = new CachedStorage(inner, cacheDir);

  // A second org + user, via the owner connection, for the 403 check. Removed in finally.
  const stranger = await db.transaction(async (tx) => {
    const [o] = await tx.insert(orgs).values({ name: 'e2e-r2 stranger' }).returning();
    const [u] = await tx.insert(users).values({ email: `e2e-r2-${Date.now()}@adforge.invalid` }).returning();
    await tx.insert(memberships).values({ orgId: o!.id, userId: u!.id, role: 'owner' });
    return { orgId: o!.id, userId: u!.id };
  });
  strangerOrgId = stranger.orgId; strangerUserId = stranger.userId;

  const session = (u: { userId: string; orgId: string }) => async () => ({ userId: u.userId, orgId: u.orgId, email: 'e2e@adforge.invalid', isAdmin: false });
  const uploadsCtx: UploadsCtx = { auth: session(operator), siteUrl: ORIGIN, r2: true, store: inner };
  const mediaCtx = (u: { userId: string; orgId: string }): MediaCtx => ({
    auth: session(u), run: (uid, fn) => withUser(db, uid, fn), r2: true, ttlSec: env.ADFORGE_MEDIA_TTL_SEC,
    presignGet: (key, ttl, o) => inner.presignGet(key, ttl, o),
  });

  // 1. mint + CORS preflight + browser-style PUT
  const photo = readFileSync(join(REPO_ROOT, 'fixtures', 'eval-products', 'krishna-hing-ras', '1-tins.jpg'));
  const sha = createHash('sha256').update(photo).digest('hex');
  const mintRes = await mintUploadHandler(uploadsCtx, new Request(`${ORIGIN}/api/uploads`, {
    method: 'POST', headers: { origin: ORIGIN, 'content-type': 'application/json' },
    body: JSON.stringify({ mime: 'image/jpeg', bytes: photo.length, sha256: sha }),
  }));
  const mint = (await mintRes.json()) as { key: string; url?: string; headers?: Record<string, string>; exists: boolean };
  check('mint ok, key is org-prefixed', mintRes.status === 200 && mint.key.startsWith(`${operator.orgId}/`), `status ${mintRes.status}`);
  if (mint.url) {
    const pre = await fetch(mint.url, { method: 'OPTIONS', headers: { origin: ORIGIN, 'access-control-request-method': 'PUT', 'access-control-request-headers': Object.keys(mint.headers ?? {}).join(',') } });
    const allow = pre.headers.get('access-control-allow-origin');
    check('CORS preflight allows the UI origin', pre.ok && (allow === ORIGIN || allow === '*'), `${pre.status} on ${host(mint.url)}, allow-origin=${allow}`);
    const put = await fetch(mint.url, { method: 'PUT', headers: { ...mint.headers, origin: ORIGIN }, body: photo });
    check('presigned PUT of the eval photo', put.ok, `status ${put.status}`);
  } else {
    console.log('  (photo already in the bucket: mint said exists, so preflight and PUT were skipped)');
  }
  check('uploaded photo is in the bucket', (await inner.head(mint.key))?.bytes === photo.length);

  // 2. normalize (reads the uploaded key back through the cache, writes the normalized photo)
  const plate = await withStorageOrg(operator.orgId, () => normalizeStored(storage, mint.key, 1));

  // 3. render 240x426, 5 frames, plate = the normalized photo
  const frames = 5;
  const voice = await withStorageOrg(operator.orgId, () => storage.put(silentWav(frames), { mime: 'audio/wav' }));
  const spec: VideoSpec = {
    id: 'e2e-r2', width: 240, height: 426, fps: 30, durationInFrames: frames,
    theme: { primary: '#000000', accent: '#ffffff' },
    scenes: [{ startFrame: 0, durationInFrames: frames, motion: 'slow_zoom_in', layers: [{ type: 'plate', key: plate.id }, { type: 'text', content: 'R2 ok', position: 'top_third', weight: 'bold', scrim: true }] }],
    audio: { voice: [{ key: voice.id, startFrame: 0, durationInFrames: frames }] },
    captions: { position: 'bottom_center', words: [{ text: 'ok', startFrame: 0, endFrame: frames }] },
  };
  const renderer = new HyperframesRenderer({ storage, workDir: join(tmp, 'work') });
  const render = () => withStorageOrg(operator.orgId, () => renderer.render({ spec, idempotencyKey: 'e2e-r2' }));
  const r1 = await render();
  if (r1.status !== 'done') throw new Error(`render ${r1.status}${r1.status === 'failed' ? `: ${r1.error.message}` : ''}`);
  const mp4: MediaRef = r1.value;
  check('render produced an org-prefixed mp4', mp4.id.startsWith(`${operator.orgId}/`) && mp4.mime === 'video/mp4', `${mp4.bytes} bytes`);

  const refs: MediaRef[] = [plate, voice, mp4];
  check('every MediaRef.url is ADFORGE_PUBLIC_URL/media/<key>', refs.every((r) => r.url === `${env.ADFORGE_PUBLIC_URL}/media/${r.id}` && storage.urlFor(r.id) === r.url));
  check('no R2 hostname in any MediaRef.url', refs.every((r) => !r.url.includes('r2.cloudflarestorage.com')));
  check('cache dir has the photo, the normalized plate and the mp4', [mint.key, plate.id, mp4.id].every((k) => existsSync(join(cacheDir, ...k.split('/')))));

  // 4. media handler: owner 302 -> R2 bytes; ?download=1 -> attachment; stranger 403
  const owner = await mediaHandler(mediaCtx(operator), mp4.id.split('/'));
  const loc = owner.headers.get('location') ?? '';
  check('owner gets 302 to an R2 host', owner.status === 302 && host(loc).endsWith('.r2.cloudflarestorage.com'), `${owner.status} -> ${loc ? host(loc) : 'none'}`);
  const got = loc ? new Uint8Array(await (await fetch(loc)).arrayBuffer()) : new Uint8Array();
  check('redirect target returns the mp4 bytes', createHash('sha256').update(got).digest('hex') === mp4.sha256, `${got.length} bytes`);
  const dl = await mediaHandler(mediaCtx(operator), mp4.id.split('/'), true);
  const dlLoc = dl.headers.get('location') ?? '';
  const dlRes = dlLoc ? await fetch(dlLoc) : null;
  const disp = dlRes?.headers.get('content-disposition') ?? '';
  await dlRes?.arrayBuffer();
  check('download=1 target answers Content-Disposition: attachment', disp.toLowerCase().startsWith('attachment'), `${dlRes?.status} "${disp.split(';')[0]}"`);
  const denied = await mediaHandler(mediaCtx(stranger), mp4.id.split('/'));
  check('user of another org gets 403 and no Location', denied.status === 403 && !denied.headers.get('location'), String(denied.status));

  // 5. warm cache: a second render does no inner reads
  const before = inner.reads;
  const second = await render();
  check('second render succeeds', second.status === 'done');
  check('second render does 0 inner reads', inner.reads === before, `${inner.reads - before} reads`);
} catch (e) {
  check('run completed', false, e instanceof Error ? e.message : String(e));
} finally {
  await rm(tmp, { recursive: true, force: true }).catch(() => {});
  if (strangerOrgId && strangerUserId) {
    await db.delete(memberships).where(eq(memberships.orgId, strangerOrgId)).catch(() => {});
    await db.delete(users).where(eq(users.id, strangerUserId)).catch(() => {});
    await db.delete(orgs).where(eq(orgs.id, strangerOrgId)).catch(() => {});
  }
  await close();
}
await new Promise((r) => setTimeout(r, 1500)); // let Chrome exit
const left = chromeCount();
check('no chrome-headless-shell left running', left === 0, `${left} found`);
console.log(`\n${checks.every((c) => c[1]) ? 'PASS' : 'FAIL'}`);
process.exit(checks.length && checks.every((c) => c[1]) ? 0 : 1);
