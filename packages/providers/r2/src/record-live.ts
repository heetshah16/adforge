// Records one live HEAD response into test/fixtures/head.live.json. Needs R2_* in the repo .env. Never prints secrets.
import { writeFileSync } from 'node:fs';
import { AwsClient } from 'aws4fetch';
import { R2Config } from './config';
import { R2Storage } from './r2';
import { withStorageOrg } from '@adforge/core/providers/storage-scope';

process.loadEnvFile(new URL('../../../../.env', import.meta.url));
const env = process.env;
// Hardcoded: a stray env var must never point the recorder at prod.
const BUCKET = 'adforge-dev';
const r2 = new R2Storage(
  R2Config.parse({
    accountId: env.R2_ACCOUNT_ID,
    accessKeyId: env.R2_ACCESS_KEY_ID,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    bucket: BUCKET,
    publicUrl: 'http://localhost:3000',
  }),
);
const TEST_ORG = '00000000-0000-4000-8000-000000000001';
// 1x1 transparent PNG
const PNG = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64'));

const ref = await withStorageOrg(TEST_ORG, () => r2.put(PNG, { mime: 'image/png', width: 1, height: 1 }));
const head = await r2.head(ref.id);
if (!head) throw new Error('HEAD found nothing after put');
const back = await r2.read(ref.id);
if (back.byteLength !== PNG.byteLength) throw new Error('GET returned different bytes');
const signed = await fetch(await r2.presignGet(ref.id, 60));
if (!signed.ok) throw new Error(`presigned GET -> HTTP ${signed.status}`);
const dl = await fetch(await r2.presignGet(ref.id, 60, { download: true }));
console.log('download Content-Disposition:', dl.headers.get('content-disposition'));
await dl.arrayBuffer();

// Re-issue the HEAD raw to capture its status and non-secret headers (account-identifying headers are dropped).
const KEEP = ['content-type', 'content-length', 'etag', 'last-modified', 'accept-ranges', 'server'];
const aws = new AwsClient({ accessKeyId: env.R2_ACCESS_KEY_ID!, secretAccessKey: env.R2_SECRET_ACCESS_KEY!, service: 's3', region: 'auto', retries: 0 });
const res = await aws.fetch(`https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${BUCKET}/${ref.id}`, { method: 'HEAD' });
const headers = Object.fromEntries(KEEP.flatMap((h) => (res.headers.get(h) ? [[h, res.headers.get(h)!]] : [])));
writeFileSync(new URL('../test/fixtures/head.live.json', import.meta.url), JSON.stringify({ status: res.status, headers }, null, 2) + '\n');

// M4 probe: is a signed content-length enforced on a presigned PUT? (matching -> expect 2xx, mismatched -> expect 403)
const probe = async (signedLen: number) => {
  const u = new URL(`https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${BUCKET}/${ref.id}`);
  u.searchParams.set('X-Amz-Expires', '60');
  const req = await aws.sign(u.toString(), { method: 'PUT', headers: { 'content-type': 'image/png', 'content-length': String(signedLen) }, aws: { signQuery: true, allHeaders: true } });
  return (await fetch(req.url, { method: 'PUT', headers: { 'content-type': 'image/png' }, body: PNG })).status;
};
console.log(`content-length probe: matching=${await probe(PNG.byteLength)} mismatched=${await probe(PNG.byteLength + 1)}`);
console.log(`recorded: key=${ref.id} head=${JSON.stringify(head)} presignedGet=${signed.status}`);
