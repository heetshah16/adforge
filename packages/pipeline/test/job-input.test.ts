import { describe, expect, it } from 'vitest';
import { MAX_BODY, parseJobUpload } from '../src/job-input';

const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);
const JPG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1]);
const WEBP = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);
const file = (bytes: Uint8Array<ArrayBuffer>, type: string, name = 'p.png') => new File([bytes], name, { type });
const three = () => [file(PNG, 'image/png'), file(JPG, 'image/jpeg', 'p.jpg'), file(WEBP, 'image/webp', 'p.webp')];
function form(over: Record<string, unknown> = {}, photos: File[] = three()) {
  const f = new FormData();
  const fields = { name: 'Glow Rx Serum', price: '₹899', description: 'Niacinamide serum.', language: 'en', broll: 'on', ...over };
  for (const [k, v] of Object.entries(fields)) if (v !== undefined) f.append(k, String(v));
  for (const p of photos) f.append('photos', p);
  return f;
}

describe('parseJobUpload', () => {
  it('accepts png/jpeg/webp and returns fields + photo bytes', async () => {
    const r = await parseJobUpload(form({ brand: 'Glow Rx' }));
    expect(r).toMatchObject({ ok: true, fields: { name: 'Glow Rx Serum', brand: 'Glow Rx', language: 'en', broll: true } });
    if (r.ok) expect(r.photos.map((p) => p.type)).toEqual(['image/png', 'image/jpeg', 'image/webp']);
  });
  it('omits brand and broll defaults', async () => {
    const r = await parseJobUpload(form({ brand: undefined, broll: undefined }));
    expect(r.ok && r.fields.brand).toBeUndefined();
    expect(r.ok && r.fields.broll).toBe(false);
  });
  it.each([
    ['missing name', { name: '' }, three(), /invalid fields/],
    ['bad language', { language: 'fr' }, three(), /invalid fields/],
    ['2 photos', {}, three().slice(0, 2), /3–5 photos, got 2/],
    ['6 photos', {}, [...three(), ...three()], /3–5 photos, got 6/],
    ['a gif', {}, [file(PNG, 'image/gif'), ...three().slice(1)], /unsupported type/],
    ['an 11 MB photo', {}, [file(new Uint8Array(11 * 1024 * 1024), 'image/png'), ...three().slice(1)], /10 MB/],
    ['a png that is really text', {}, [file(new Uint8Array([1, 2, 3, 4]), 'image/png'), ...three().slice(1)], /not a real image\/png/],
    ['a RIFF that is not webp', {}, [file(new Uint8Array(12).fill(0).map((_, i) => [0x52, 0x49, 0x46, 0x46][i] ?? 0), 'image/webp'), ...three().slice(1)], /not a real image\/webp/],
  ])('rejects %s with 400', async (_l, over, photos, msg) => {
    const r = await parseJobUpload(form(over, photos));
    expect(r).toMatchObject({ ok: false, status: 400 });
    if (!r.ok) expect(r.error).toMatch(msg);
  });
  it('413 when the photos together exceed the body cap', async () => {
    expect(MAX_BODY).toBe(30 * 1024 * 1024);
    expect(await parseJobUpload(form({}, three()), { maxBody: 5 })).toMatchObject({ ok: false, status: 413 });
  });
});
