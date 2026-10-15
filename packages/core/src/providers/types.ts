/** Everything that crosses a provider boundary. Vendor SDK types never appear here. */

export interface MediaRef {
  /** Storage key. Layers reference asset ids; storage resolves keys. */
  id: string;
  /** ALWAYS an internal URL (`${ADFORGE_PUBLIC_URL}/media/<key>`), never a vendor URL. */
  url: string;
  mime: string;
  sha256: string;
  bytes: number;
  width?: number;
  height?: number;
  durationSec?: number;
}

export interface Money {
  amountUsd: number;
  estimated: boolean;
}

export interface JobHandle {
  provider: string;
  externalId: string;
  pollAfterMs: number;
  /** Vendor payload, for debugging only. */
  raw?: unknown;
}

export type ProviderErrorCode =
  | 'AUTH'
  | 'RATE_LIMIT'
  | 'INVALID_INPUT'
  | 'CONTENT_POLICY'
  | 'TIMEOUT'
  | 'UPSTREAM'
  | 'UNKNOWN';

const RETRYABLE: ReadonlySet<ProviderErrorCode> = new Set(['RATE_LIMIT', 'TIMEOUT', 'UPSTREAM']);

/** One source of truth for retry policy, so `retryable` can't disagree with the error code. */
export function isRetryable(code: ProviderErrorCode): boolean {
  return RETRYABLE.has(code);
}

/** INVALID_INPUT is a bug in our adapter — it should have failed Zod validation locally. */
export class ProviderError extends Error {
  constructor(
    readonly provider: string,
    readonly code: ProviderErrorCode,
    message: string,
    readonly raw?: unknown,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}

export type ProviderResult<T> =
  | { status: 'pending'; handle: JobHandle }
  | { status: 'done'; value: T; cost: Money; latencyMs: number }
  | { status: 'failed'; error: ProviderError; retryable: boolean };

export interface PutOptions {
  mime: string;
  width?: number;
  height?: number;
  durationSec?: number;
}

export interface StorageProvider {
  readonly id: string;
  put(bytes: Uint8Array, opts: PutOptions): Promise<MediaRef>;
  read(key: string): Promise<Uint8Array>;
}

export interface ImageGenRequest {
  prompt: string;
  width: number;
  height: number;
  seed?: number;
  idempotencyKey: string;
}

export interface ImageProvider {
  readonly id: string;
  generate(req: ImageGenRequest): Promise<ProviderResult<MediaRef>>;
}

export interface CutoutRequest {
  image: MediaRef;
  idempotencyKey: string;
}

/** Returns an RGBA PNG of the subject with the background removed. */
export interface CutoutProvider {
  readonly id: string;
  cutout(req: CutoutRequest): Promise<ProviderResult<MediaRef>>;
}

export interface VideoGenRequest {
  mode: 'text_to_video' | 'image_to_video' | 'reference_to_video' | 'first_last_frame';
  prompt: string;
  images?: MediaRef[];
  firstFrame?: MediaRef;
  lastFrame?: MediaRef;
  durationSec: number;
  aspectRatio: '9:16' | '16:9' | '1:1';
  resolution: '480p' | '720p' | '1080p';
  seed?: number;
  idempotencyKey: string;
}

export interface VideoCapabilities {
  modes: VideoGenRequest['mode'][];
  maxDurationSec: number;
  resolutions: VideoGenRequest['resolution'][];
  typicalLatencyMs: number;
}

export interface VideoProvider {
  readonly id: string;
  readonly capabilities: VideoCapabilities;
  submit(req: VideoGenRequest): Promise<JobHandle>;
  poll(handle: JobHandle): Promise<ProviderResult<MediaRef>>;
}
