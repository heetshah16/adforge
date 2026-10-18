import type { Env } from '@adforge/core/config/env';
import type { ProductInput } from '@adforge/core/llm/render';
import type {
  AlignedWord, CaptionAligner, CutoutProvider, DepthProvider, ImageProvider, LLMProvider, LumaProvider, OcrProvider, RendererProvider, StorageProvider, TTSProvider, VideoProvider,
} from '@adforge/core/providers/types';
import type { Language } from '@adforge/core/vocab/enums';
import type { Db } from '@adforge/db/client';
import type { HEAVY } from './heavy';
export type HeavyTasks = typeof HEAVY;

export interface JobInput { product: ProductInput; language: Language; broll: boolean; photoKeys: string[] }
export type BeatKey = `${number}:${number}`;            // `${variantNo}:${beatIndex}`
export interface PlateResult { cutout: string | null; plates: Record<string, string | null> }
/** Per distinct plate key: its luma grid and stored depth map, or why the vision pass failed (best-effort). */
export type PlateVisionResult = Record<string, { lumaGrid: number[][]; depthKey: string } | { error: string }>;
export type BrollResult = Record<string, { beat: number; key: string; durationSec: number } | null>;   // by variantNo
export type VoiceResult = Record<string, { key: string; durationSec: number; words: AlignedWord[] } | null>;
export type RenderResult = { key: string; assetId: string } | { error: string };
export interface StepLike {
  run<T>(id: string, fn: () => Promise<T>): Promise<T>;
  heavy<K extends keyof HeavyTasks>(task: K, id: string, payload: Parameters<HeavyTasks[K]>[1]): Promise<Awaited<ReturnType<HeavyTasks[K]>>>;
}
export interface PipelineDeps {
  db: Db;
  storage: StorageProvider;
  comfy: { image: ImageProvider; cutout: CutoutProvider; video: VideoProvider; preflight(): Promise<void>; free(): Promise<void>; systemStats(): Promise<{ vramUsedBytes: number; vramTotalBytes: number }>; workflowHashes: Record<string, string> };
  voice: { tts: TTSProvider & { idFor?(language: Language): string }; aligner: CaptionAligner; health(): Promise<{ ok: boolean; sm120: boolean }>; unload(): Promise<unknown> };
  vision: { ocr: OcrProvider; depth: DepthProvider; luma: LumaProvider; unload(): Promise<unknown> };
  renderer: RendererProvider;
  llm: LLMProvider;
  env: Env;
  sleep(ms: number): Promise<void>;
}
