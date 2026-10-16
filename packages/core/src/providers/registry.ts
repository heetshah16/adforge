import type { CutoutProvider, ImageProvider, LLMProvider, RendererProvider, StorageProvider, VideoProvider } from './types';

interface ProviderMap {
  storage: StorageProvider;
  image: ImageProvider;
  cutout: CutoutProvider;
  video: VideoProvider;
  renderer: RendererProvider;
  llm: LLMProvider;
}
export type ProviderKind = keyof ProviderMap;

/** Providers register by id; env (`ADFORGE_PROVIDER_*`) chooses which id a pipeline uses. */
export class ProviderRegistry {
  readonly #byKind = new Map<ProviderKind, Map<string, ProviderMap[ProviderKind]>>();

  register<K extends ProviderKind>(kind: K, impl: ProviderMap[K]): void {
    const ids = this.#byKind.get(kind) ?? new Map();
    if (ids.has(impl.id)) throw new Error(`${kind} provider "${impl.id}" already registered`);
    ids.set(impl.id, impl);
    this.#byKind.set(kind, ids);
  }

  get<K extends ProviderKind>(kind: K, id: string): ProviderMap[K] {
    const ids = this.#byKind.get(kind);
    const impl = ids?.get(id);
    if (!impl) {
      const known = ids && ids.size > 0 ? [...ids.keys()].join(', ') : '(none)';
      throw new Error(`No ${kind} provider "${id}". Registered: ${known}`);
    }
    return impl as ProviderMap[K];
  }
}
