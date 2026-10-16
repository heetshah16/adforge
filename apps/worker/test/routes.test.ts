import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { assets, jobs } from '@adforge/db/schema';
import { makeRoutes } from '../src/routes';
import { makeDeps } from '../../../packages/pipeline/test/fakes';
import type { LocalDiskStorage } from '@adforge/provider-local-storage';

const PNG: Uint8Array<ArrayBuffer> = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);
const file = (bytes: Uint8Array<ArrayBuffer>, type: string, name = 'p.png') => new File([bytes], name, { type });
function form(over: Record<string, unknown> = {}) {
  const f = new FormData();
  const fields = { name: 'Glow Rx Serum', price: '₹899', description: 'Niacinamide serum.', language: 'en', broll: 'on', ...over };
  for (const [k, v] of Object.entries(fields)) if (v !== undefined && k !== 'photos') f.append(k, String(v));
  const photos = (over.photos as File[] | undefined) ?? [1, 2, 3].map((i) => file(new Uint8Array([...PNG, i]), 'image/png'));
  for (const p of photos) f.append('photos', p);
  return f;
}
const post = (body: FormData, headers?: Record<string, string>) => new Request('http://w/api/jobs', { method: 'POST', body, headers });

async function setup() {
  const m = await makeDeps();
  const sent: unknown[] = [];
  const routes = makeRoutes({ deps: m.deps, storage: m.deps.storage as LocalDiskStorage, sendEvent: async (name, data) => { sent.push({ name, data }); } });
  return { ...m, routes, sent };
}

describe('createJob', () => {
  it('stores photos, creates the job and sends the event', async () => {
    const s = await setup();
    try {
      const res = await s.routes.createJob(post(form({ brand: 'Glow Rx' })));
      expect(res.status).toBe(202);
      const { jobId } = (await res.json()) as { jobId: string };
      const [j] = await s.deps.db.select().from(jobs).where(eq(jobs.id, jobId));
      expect(j!.inputSpec).toMatchObject({ product: { name: 'Glow Rx Serum', brand: 'Glow Rx' }, language: 'en', broll: true });
      expect((j!.inputSpec as { photoKeys: string[] }).photoKeys).toHaveLength(3);
      expect(s.sent).toEqual([{ name: 'adforge/job.requested', data: { jobId } }]);
    } finally { await s.close(); }
  });

  it('omits brand when not given', async () => {
    const s = await setup();
    try {
      const { jobId } = (await (await s.routes.createJob(post(form()))).json()) as { jobId: string };
      const [j] = await s.deps.db.select().from(jobs).where(eq(jobs.id, jobId));
      expect((j!.inputSpec as { product: object }).product).not.toHaveProperty('brand');
    } finally { await s.close(); }
  });

  it.each([
    ['too few photos', { photos: [file(PNG, 'image/png')] }, /photos/],
    ['too many photos (6)', { photos: Array.from({ length: 6 }, (_, i) => file(new Uint8Array([...PNG, i]), 'image/png')) }, /photos/],
    ['a 6 MB photo', { photos: [file(new Uint8Array(6 * 1024 * 1024), 'image/png'), file(PNG, 'image/png'), file(PNG, 'image/png')] }, /5 MB/],
    ['a 10 MB photo', { photos: [file(new Uint8Array(10 * 1024 * 1024), 'image/png'), file(PNG, 'image/png'), file(PNG, 'image/png')] }, /5 MB/],
    ['an exe renamed png', { photos: [file(new Uint8Array([77, 90, 0, 0]), 'image/png', 'evil.png'), file(PNG, 'image/png'), file(PNG, 'image/png')] }, /not a real/],
    ['an exe declared as exe', { photos: [file(new Uint8Array([77, 90, 0, 0]), 'application/x-msdownload', 'evil.exe'), file(PNG, 'image/png'), file(PNG, 'image/png')] }, /unsupported type/],
    ['a RIFF that is not WEBP', { photos: [file(new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 65, 86, 73, 32]), 'image/webp'), file(PNG, 'image/png'), file(PNG, 'image/png')] }, /not a real/],
    ['a prototype-key mime (__proto__)', { photos: [file(PNG, '__proto__'), file(PNG, 'image/png'), file(PNG, 'image/png')] }, /unsupported type/],
    ['a missing name', { name: undefined }, /name/],
    ['an unknown language', { language: 'fr' }, /language/],
  ])('rejects %s with 400 and stores nothing', async (_label, over, msg) => {
    const s = await setup();
    try {
      const res = await s.routes.createJob(post(form(over)));
      expect(res.status).toBe(400);
      expect(JSON.stringify(await res.json())).toMatch(msg);
      expect(await s.deps.db.$count(jobs)).toBe(0);
      expect(await s.deps.db.$count(assets)).toBe(0);
      expect(s.sent).toEqual([]);
    } finally { await s.close(); }
  });

  it('rejects a declared body over 30 MB with 413 before parsing', async () => {
    const s = await setup();
    try {
      const res = await s.routes.createJob(post(form(), { 'content-length': String(31 * 1024 * 1024) }));
      expect(res.status).toBe(413);
      expect(await s.deps.db.$count(jobs)).toBe(0);
    } finally { await s.close(); }
  });

  it('rejects a non-multipart body with 400', async () => {
    const s = await setup();
    try {
      const res = await s.routes.createJob(new Request('http://w/api/jobs', { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } }));
      expect(res.status).toBe(400);
    } finally { await s.close(); }
  });
});

describe('getJob and getMedia', () => {
  it('returns the job and 404s an unknown id', async () => {
    const s = await setup();
    try {
      const { jobId } = (await (await s.routes.createJob(post(form()))).json()) as { jobId: string };
      const ok = await s.routes.getJob(new Request(`http://w/api/jobs/${jobId}`));
      expect(ok.status).toBe(200);
      expect(await ok.json()).toMatchObject({ job: { id: jobId, status: 'queued' }, variants: [] });
      expect((await s.routes.getJob(new Request('http://w/api/jobs/00000000-0000-0000-0000-000000000000'))).status).toBe(404);
      expect((await s.routes.getJob(new Request('http://w/api/jobs/not-a-uuid'))).status).toBe(404);
    } finally { await s.close(); }
  });

  it('serves stored media by key and rejects traversal', async () => {
    const s = await setup();
    try {
      const ref = await s.deps.storage.put(PNG, { mime: 'image/png' });
      const ok = await s.routes.getMedia(new Request(`http://w/media/${ref.id}`));
      expect(ok.status).toBe(200);
      expect(ok.headers.get('content-type')).toBe('image/png');
      for (const bad of ['..%2F..%2Fetc%2Fpasswd', '../../etc/passwd', '%2e%2e%2f%2e%2e%2fsecret', 'ab%2F..%2F..%2Fx.png', '%E0%A4%A']) {
        expect((await s.routes.getMedia(new Request(`http://w/media/${bad}`))).status, bad).toBe(400);
      }
      expect((await s.routes.getMedia(new Request(`http://w/media/ab/${'b'.repeat(64)}.png`))).status).toBe(404);
    } finally { await s.close(); }
  });

  it('health is ok', async () => {
    const s = await setup();
    try { expect(await (await s.routes.health()).json()).toEqual({ ok: true }); } finally { await s.close(); }
  });
});
