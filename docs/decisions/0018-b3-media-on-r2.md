# 0018 — B3: media on R2

**Status:** accepted · 2026-10-19

## Decision
- Prod media lives in a private R2 bucket. Keys are `org/<orgId>/<2-hex>/<sha256>.<ext>`; dev keys stay `<2-hex>/<sha256>.<ext>` on local disk.
- The org that owns a storage write comes from an AsyncLocalStorage scope set per Inngest handler and re-entered inside every step callback (Inngest runs step callbacks outside the handler's async context). Provider request types stay org-free. R2Storage.put throws `missing storage org scope` outside a scope.
- R2 client is aws4fetch 1.0.20 (zero dependencies, SigV4 signing and presigning), not the AWS SDK. Its built-in retries are off (`retries: 0`); our own retry policy applies.
- Server PUTs send `If-None-Match: *` and the payload sha256. A 403/409/412 on PUT counts as success only if a re-HEAD shows the same size (write-once bucket lock, racing duplicate puts).
- R2 errors map: 401/403 → AUTH, 429 → RATE_LIMIT, other 4xx → INVALID_INPUT, 5xx/network → UPSTREAM; errors carry only the R2 `<Code>`, never body text.
- Browsers upload straight to R2 with a presigned PUT minted by `POST /api/uploads`. The signature covers content-type, content-length, `x-amz-checksum-sha256` (from the key's sha) and `If-None-Match: *`. Measured on 2026-10-19: wrong size → 403, wrong bytes → 400 BadDigest, repeat upload → 412. The mint HEADs first and returns `exists: true` for an already-stored file.
- Job create accepts photo keys only if they belong to the caller's org and the 2-hex shard matches the sha; a dev-shaped key is rejected in prod. It HEAD-checks type and size (≤ 10 MB) before writing any row.
- The worker re-validates every uploaded photo before first use: size cap, sha256 recomputed over the stored bytes, magic bytes (PNG/JPEG/WebP; HEIC rejected), ≤ 8192 px per side and ≤ 50 megapixels, EXIF rotation applied, converted to sRGB, re-encoded (PNG stays PNG; JPEG/WebP → JPEG q92 on white), all metadata stripped.
- Media is served by `GET /media/<key>`: session required, the caller must be a member of the key's org (checked under RLS), then a 302 to a signed R2 GET (TTL `ADFORGE_MEDIA_TTL_SEC`) with `Cache-Control: private, max-age=TTL−60`. `?download=1` signs `response-content-disposition: attachment`. Signed URLs never appear in page JSON.
- The player re-requests `/media/<key>` when a signed URL expires (up to 3 times per incident), keeping the playback position.
- The GPU worker reads media through a local read-through disk cache; cache writes are best-effort and never fail a read or write.
- Amendments to the roadmap: R2 has no bucket versioning, so prod uses a 30-day bucket lock instead; uploads return `{ key, url, headers, exists }` (presigned PUT) not POST-policy `fields`; the B3 e2e is GPU-free; the photo cap is 10 MB.

## Consequences
- A storage write outside an Inngest handler (scripts, web routes) must wrap itself in `withStorageOrg` or it fails in prod.
- The worker's old dev HTTP routes (`/media`, multipart job create) only work with local storage and are removed in B4.
- Prod bucket CORS must be set when the site domain exists (B4).
- In dev, keys carry no org, so dev cannot check key ownership; accepted for dev only.
- A private 302 may be reused by another user who signs in on the same browser profile within the TTL; low risk, accepted.
- Deleting media inside the 30-day lock is impossible by design.
