import { describe, expect, it } from 'vitest';
import { ProviderRegistry } from '../src/providers/registry';
import type { StorageProvider } from '../src/providers/types';

const fake = (id: string): StorageProvider => ({
  id,
  put: async () => { throw new Error('unused'); },
  read: async () => new Uint8Array(),
});

describe('ProviderRegistry', () => {
  it('returns a registered provider by kind and id', () => {
    const r = new ProviderRegistry();
    const p = fake('local');
    r.register('storage', p);
    expect(r.get('storage', 'local')).toBe(p);
  });

  it('rejects duplicate registration', () => {
    const r = new ProviderRegistry();
    r.register('storage', fake('local'));
    expect(() => r.register('storage', fake('local'))).toThrow(/already registered/);
  });

  it('names the registered ids when an id is unknown', () => {
    const r = new ProviderRegistry();
    r.register('storage', fake('local'));
    r.register('storage', fake('r2'));
    expect(() => r.get('storage', 'gcs')).toThrow('No storage provider "gcs". Registered: local, r2');
  });

  it('reports an empty kind clearly', () => {
    expect(() => new ProviderRegistry().get('video', 'comfyui')).toThrow(
      'No video provider "comfyui". Registered: (none)',
    );
  });
});
