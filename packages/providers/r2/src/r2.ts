import { createHash } from 'node:crypto';
import { AwsClient } from 'aws4fetch';
import { z } from 'zod';
import { classifyFailure, readClassified } from '@adforge/core/providers/http';
import { MIME_EXT, STORAGE_KEY_RE, orgKey, parseKey } from '@adforge/core/providers/storage-key';
import { storageOrg } from '@adforge/core/providers/storage-scope';
import { ProviderError, type MediaRef, type ProviderErrorCode, type PutOptions, type StorageProvider } from '@adforge/core/providers/types';
import { R2Config } from './config';

const P = 'r2';
const LABEL = 'R2';
/** R2 presigned URLs live 1 second to 7 days (docs/providers/r2.md). */
const Ttl = z.number().int().min(1).max(604_800);
const PresignPutOpts = z.object({ mime: z.string().refine((m) => m in MIME_EXT, 'unsupported mime'), bytes: z.number().int().positive(), ttlSec: Ttl });

function assertKey(key: string): void {
  if (!STORAGE_KEY_RE.test(key)) throw new Error(`not a storage key: ${key}`);
}

/** The one status classifier: 429 rate limit, 401/403 bad credentials/signature, other 4xx our bug, rest the service's. */
function classify(status: number): ProviderErrorCode {
  if (status === 429) return 'RATE_LIMIT';
  if (status === 401 || status === 403) return 'AUTH';
  return status < 500 ? 'INVALID_INPUT' : 'UPSTREAM';
}

/** Maps a HEAD response to its metadata: 404 is absence, not an error. */
export function headFromResponse(status: number, headers: Headers): { bytes: number; mime: string } | null {
  if (status === 404) return null;
  if (status !== 200) throw new ProviderError(P, classify(status), `${LABEL} HEAD -> HTTP ${status}`, { status });
  const len = headers.get('content-length');
  const mime = headers.get('content-type');
  if (len === null || !/^\d+$/.test(len) || !mime) throw new ProviderError(P, 'UPSTREAM', `${LABEL} HEAD response lacks a valid content-length/content-type`, { status });
  return { bytes: Number(len), mime };
}

export class R2Storage implements StorageProvider {
  readonly id = 'r2';
  private readonly cfg: R2Config;
  private readonly aws: AwsClient;

  /** `datetime` pins the signing clock (tests only): form `20261019T000000Z`. */
  constructor(
    cfg: z.input<typeof R2Config>,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly datetime?: () => string,
  ) {
    const parsed = R2Config.parse(cfg);
    this.cfg = parsed;
    // retries: 0, the timeout and retry policy are ours (aws4fetch's default is 10 retries).
    this.aws = new AwsClient({ accessKeyId: parsed.accessKeyId, secretAccessKey: parsed.secretAccessKey, service: 's3', region: 'auto', retries: 0 });
  }

  urlFor(key: string): string {
    assertKey(key);
    return `${this.cfg.publicUrl.replace(/\/$/, '')}/media/${key}`;
  }

  private endpoint(key: string): URL {
    assertKey(key);
    return new URL(`https://${this.cfg.accountId}.r2.cloudflarestorage.com/${this.cfg.bucket}/${key}`);
  }

  private sign(url: URL, method: string, headers: Record<string, string>, body: Uint8Array | undefined, signQuery = false) {
    // allHeaders: aws4fetch skips content-type by default; we want it signed (R2 then rejects a different type).
    // Uint8Array is a valid BodyInit at runtime; the DOM lib (web's tsconfig) types it over ArrayBufferLike, so the cast is needed there.
    return this.aws.sign(url.toString(), { method, headers, body: body as RequestInit['body'], aws: { allHeaders: true, signQuery, datetime: this.datetime?.() } });
  }

  /** One signed request under a deadline covering the body. 404 returns only when allow404 (HEAD); other non-2xx throw. */
  private async send(method: string, key: string, headers: Record<string, string> = {}, body?: Uint8Array, allow404 = false): Promise<{ status: number; headers: Headers; body: Uint8Array }> {
    const signed = await this.sign(this.endpoint(key), method, headers, body);
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), this.cfg.timeoutMs);
    const what = `${method} ${key}`;
    try {
      let res: Response;
      try {
        res = await this.fetchImpl(signed.url, { method, headers: signed.headers, body: body as RequestInit['body'], signal: ctl.signal });
      } catch (e) {
        throw classifyFailure(P, LABEL, e, what, this.cfg.timeoutMs);
      }
      const buf = await readClassified(P, LABEL, what, this.cfg.timeoutMs, async () => new Uint8Array(await res.arrayBuffer()));
      if (res.ok || (allow404 && res.status === 404)) return { status: res.status, headers: res.headers, body: buf };
      // Only R2's error <Code>: the body can echo request details.
      const code = /<Code>([A-Za-z0-9]+)<\/Code>/.exec(new TextDecoder().decode(buf))?.[1];
      throw new ProviderError(P, classify(res.status), `${LABEL} ${what} -> HTTP ${res.status}${code ? ` ${code}` : ''}`, { status: res.status, code });
    } finally {
      clearTimeout(timer);
    }
  }

  async head(key: string): Promise<{ bytes: number; mime: string } | null> {
    const r = await this.send('HEAD', key, {}, undefined, true);
    return headFromResponse(r.status, r.headers);
  }

  async put(bytes: Uint8Array, opts: PutOptions): Promise<MediaRef> {
    const org = storageOrg();
    if (!org) throw new Error('missing storage org scope: R2Storage.put must run inside withStorageOrg');
    const ext = MIME_EXT[opts.mime];
    if (!ext) throw new Error(`Unsupported mime type: ${opts.mime}`);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const key = orgKey(org, sha256, ext);
    // Content-addressed + locked prod bucket (no overwrite): skip the PUT when the object exists.
    if (!(await this.head(key))) {
      try {
        // If-None-Match: * makes the write atomic (a racing loser gets 412); the payload hash is signed.
        await this.send('PUT', key, { 'content-type': opts.mime, 'if-none-match': '*', 'x-amz-content-sha256': sha256 }, bytes);
      } catch (e) {
        // A racer (or a locked bucket) already holds this content-addressed key: fine if it is the same size.
        const status = (e as ProviderError).raw && ((e as ProviderError).raw as { status?: number }).status;
        if (!(e instanceof ProviderError) || ![403, 409, 412].includes(status as number)) throw e;
        if ((await this.head(key))?.bytes !== bytes.byteLength) throw e;
      }
    }
    return { id: key, url: this.urlFor(key), mime: opts.mime, sha256, bytes: bytes.byteLength, width: opts.width, height: opts.height, durationSec: opts.durationSec };
  }

  async read(key: string): Promise<Uint8Array> {
    return (await this.send('GET', key)).body;
  }

  /**
   * URL + headers for a browser PUT. Signed: content-type, content-length (= bytes), x-amz-checksum-sha256 (base64 of the
   * key's sha, so a wrong body is a 400 BadDigest) and if-none-match: * (a repeat PUT is a 412). Measured in docs/providers/r2.md.
   * content-length is not returned: browsers set it themselves.
   */
  async presignPut(key: string, o: { mime: string; bytes: number; ttlSec: number }): Promise<{ url: string; headers: Record<string, string> }> {
    const v = PresignPutOpts.parse(o);
    const url = this.endpoint(key);
    url.searchParams.set('X-Amz-Expires', String(v.ttlSec));
    const sha = /\/([0-9a-f]{64})\.[a-z0-9]+$/.exec(key)![1]!;
    const headers = { 'content-type': v.mime, 'x-amz-checksum-sha256': Buffer.from(sha, 'hex').toString('base64'), 'if-none-match': '*' };
    const signed = await this.sign(url, 'PUT', { ...headers, 'content-length': String(v.bytes) }, undefined, true);
    return { url: signed.url, headers };
  }

  async presignGet(key: string, ttlSec: number, opts?: { download?: boolean }): Promise<string> {
    const url = this.endpoint(key);
    url.searchParams.set('X-Amz-Expires', String(Ttl.parse(ttlSec)));
    if (opts?.download) {
      const k = parseKey(key)!; // endpoint() already rejected non-keys
      url.searchParams.set('response-content-disposition', `attachment; filename="adforge-${k.sha}.${k.ext}"`);
    }
    return (await this.sign(url, 'GET', {}, undefined, true)).url;
  }
}
