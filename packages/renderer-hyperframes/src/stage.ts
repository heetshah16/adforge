import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import type { StorageProvider } from '@adforge/core/providers/types';
import type { VideoSpec } from '@adforge/core/spec/video-spec';
import { assetPath, FONT_FILES } from './compose';

const require = createRequire(import.meta.url);

export class MissingAssetError extends Error {
  constructor(readonly key: string, cause: unknown) {
    super(`Render asset missing from storage: ${key}`, { cause });
    this.name = 'MissingAssetError';
  }
}

export function specKeys(spec: VideoSpec): string[] {
  const keys = new Set<string>();
  for (const scene of spec.scenes) for (const l of scene.layers) if ('key' in l) keys.add(l.key);
  for (const a of [...spec.audio.voice, ...spec.audio.music, ...spec.audio.sfx]) keys.add(a.key);
  return [...keys];
}

/** Everything the composition references, copied locally: render needs no network and no storage access. */
export async function stageProject(spec: VideoSpec, storage: StorageProvider, dir: string): Promise<void> {
  // Read everything first, so a missing key fails before anything is written.
  const assets: [string, Uint8Array][] = [];
  for (const key of specKeys(spec)) {
    try {
      assets.push([key, await storage.read(key)]);
    } catch (e) {
      throw new MissingAssetError(key, e);
    }
  }

  await mkdir(join(dir, 'assets', 'fonts'), { recursive: true });
  for (const [key, bytes] of assets) await writeFile(join(dir, assetPath(key)), bytes);
  await copyFile(require.resolve('gsap/dist/gsap.min.js'), join(dir, 'assets', 'gsap.min.js'));
  for (const f of FONT_FILES) {
    const pkgDir = dirname(require.resolve(`${f.pkg}/package.json`));
    await copyFile(join(pkgDir, f.src), join(dir, 'assets', 'fonts', f.file));
  }
}
