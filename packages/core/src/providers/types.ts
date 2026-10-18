import type { ZodType } from 'zod';
import type { VideoSpec } from '../spec/video-spec';
import type { Language } from '../vocab/enums';

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
  /** The only place an internal media URL is built. MediaRef.url must come from here. */
  urlFor(key: string): string;
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

export interface RenderRequest {
  spec: VideoSpec;
  idempotencyKey: string;
}

/** Receives our VideoSpec IR, never provider-shaped JSON. Returns the stored MP4. */
export interface RendererProvider {
  readonly id: string;
  render(req: RenderRequest): Promise<ProviderResult<MediaRef>>;
}

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export type LLMContent =
  | { type: 'text'; text: string }
  | { type: 'image'; mime: 'image/png' | 'image/jpeg' | 'image/webp'; data: Uint8Array };
export interface LLMRequest<T> {
  system: string;
  user: LLMContent[];
  schema: ZodType<T>;
  model: string;
  effort: Effort;
  idempotencyKey: string;
  timeoutMs: number;
}
export interface LLMUsage { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheCreationTokens: number }
/** The brand's locked voice (library kind 'voice'): the speaker verbatim, and the instruct every beat's style line follows. */
export interface VoiceBible { speaker: string; baseInstruct: string }
export interface TTSRequest { text: string; language: Language; emotion: number; idempotencyKey: string; voiceBible?: VoiceBible }
export interface TTSProvider { readonly id: string; synthesize(req: TTSRequest): Promise<ProviderResult<MediaRef>> }
export interface AlignedWord { text: string; startSec: number; endSec: number }
export interface AlignRequest { audio: MediaRef; text: string; language: Language; idempotencyKey: string }
export interface CaptionAligner { readonly id: string; align(req: AlignRequest): Promise<ProviderResult<{ words: AlignedWord[] }>> }
/** box = [x, y, w, h] as fractions of the image. */
export interface OcrItem { text: string; box: [number, number, number, number]; conf: number }
/** estimate() resolves to a stored 16-bit PNG (larger = nearer). */
/** `key` is a reserved idempotency key (unused today; kept for symmetry with other providers' requests). */
export interface DepthProvider { readonly id: string; estimate(image: MediaRef, key: string): Promise<ProviderResult<MediaRef>> }
export interface OcrProvider { readonly id: string; read(image: MediaRef, langs?: ('en' | 'hi')[]): Promise<ProviderResult<OcrItem[]>> }
/** grid() resolves to n x n mean Rec.709 luma per cell, 0..255. */
export interface LumaProvider { readonly id: string; grid(image: MediaRef, n?: number): Promise<ProviderResult<number[][]>> }
export interface LLMResult<T> { value: T; usage: LLMUsage }
export interface LLMProvider { readonly id: string; generate<T>(req: LLMRequest<T>): Promise<ProviderResult<LLMResult<T>>> }
