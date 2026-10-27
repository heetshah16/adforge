import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT, dataDirWarnings, parseEnv } from '../src/config/env';

const R2 = {
  R2_ACCOUNT_ID: 'a'.repeat(32),
  R2_ACCESS_KEY_ID: 'AKID',
  R2_SECRET_ACCESS_KEY: 'SECRET',
  R2_BUCKET: 'adforge-media',
};
const PROD = { ADFORGE_ENV: 'prod', ADFORGE_WORKER_ID: 'gpu-box-1', DATABASE_URL: 'postgresql://u:p@h:5432/d', ADFORGE_PROVIDER_STORAGE: 'r2', ...R2 };

describe('parseEnv', () => {
  it('defaults to the dev profile with no DATABASE_URL', () => {
    const env = parseEnv({});
    expect(env.ADFORGE_ENV).toBe('dev');
    expect(env.DATABASE_URL).toBeUndefined();
  });

  it('requires DATABASE_URL in prod', () => {
    expect(() => parseEnv({ ADFORGE_ENV: 'prod', ADFORGE_PROVIDER_STORAGE: 'r2', ...R2 })).toThrow(/DATABASE_URL/);
    const env = parseEnv(PROD);
    expect(env.ADFORGE_ENV).toBe('prod');
  });

  it('ADFORGE_WORKER_ID is required in prod, optional in dev, and must match ^[a-z0-9-]{3,40}$', () => {
    const { ADFORGE_WORKER_ID: _omit, ...noId } = PROD;
    expect(() => parseEnv(noId)).toThrow(/ADFORGE_WORKER_ID/);
    expect(() => parseEnv({ ...PROD, ADFORGE_WORKER_ID: 'Bad_ID' })).toThrow(/ADFORGE_WORKER_ID/);
    expect(parseEnv({}).ADFORGE_WORKER_ID).toBeUndefined();
  });

  it('prod with ADFORGE_PROVIDER_STORAGE=local fails to parse', () => {
    expect(() => parseEnv({ ...PROD, ADFORGE_PROVIDER_STORAGE: 'local' })).toThrow(/ADFORGE_PROVIDER_STORAGE/);
  });

  it('r2 without R2_BUCKET fails, naming it', () => {
    const { R2_BUCKET: _, ...noBucket } = R2;
    expect(() => parseEnv({ ADFORGE_PROVIDER_STORAGE: 'r2', ...noBucket })).toThrow(/R2_BUCKET/);
  });

  it.each(['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET'])('r2 requires %s', (k) => {
    const { [k]: _, ...rest } = R2 as Record<string, string>;
    expect(() => parseEnv({ ADFORGE_PROVIDER_STORAGE: 'r2', ...rest })).toThrow(new RegExp(k));
  });

  it('r2 defaults: 30s timeout, 900s media TTL; the TTL is range-checked', () => {
    const env = parseEnv({ ADFORGE_PROVIDER_STORAGE: 'r2', ...R2 });
    expect(env.R2_TIMEOUT_MS).toBe(30_000);
    expect(env.ADFORGE_MEDIA_TTL_SEC).toBe(900);
    expect(() => parseEnv({ ADFORGE_MEDIA_TTL_SEC: '59' })).toThrow(/ADFORGE_MEDIA_TTL_SEC/);
    expect(() => parseEnv({ ADFORGE_MEDIA_TTL_SEC: '3601' })).toThrow(/ADFORGE_MEDIA_TTL_SEC/);
  });

  it('local storage needs no R2 vars', () => {
    expect(parseEnv({}).ADFORGE_PROVIDER_STORAGE).toBe('local');
  });

  it('rejects a non-postgres DATABASE_URL', () => {
    expect(() => parseEnv({ DATABASE_URL: 'http://x' })).toThrow(/DATABASE_URL/);
  });

  it('defaults the voice providers and URL', () => {
    const env = parseEnv({});
    expect(env.ADFORGE_PROVIDER_TTS).toBe('chatterbox');
    expect(env.ADFORGE_PROVIDER_ALIGNER).toBe('whisper');
    expect(env.ADFORGE_VOICE_URL).toBe('http://127.0.0.1:8190');
    expect(() => parseEnv({ ADFORGE_PROVIDER_TTS: 'kokoro' })).toThrow(/ADFORGE_PROVIDER_TTS/);
  });

  it('defaults the vision URL and strips trailing slashes', () => {
    expect(parseEnv({}).ADFORGE_VISION_URL).toBe('http://127.0.0.1:8192');
    expect(parseEnv({ ADFORGE_VISION_URL: 'http://h:1//' }).ADFORGE_VISION_URL).toBe('http://h:1');
  });

  it('applies defaults to an empty environment', () => {
    const env = parseEnv({});
    expect(env.COMFYUI_URL).toBe('http://127.0.0.1:8188');
    expect(env.ADFORGE_PROVIDER_IMAGE).toBe('comfyui');
    expect(env.ADFORGE_COMFY_WORKFLOW_PLATE).toBe('plate-flux-schnell');
    expect(env.ADFORGE_LLM_EFFORT_DIRECTOR).toBe('high');
  });

  it('treats empty strings as unset', () => {
    expect(parseEnv({ COMFYUI_URL: '' }).COMFYUI_URL).toBe('http://127.0.0.1:8188');
  });

  it('fails on an unknown provider id, naming the variable', () => {
    expect(() => parseEnv({ ADFORGE_PROVIDER_IMAGE: 'fal' })).toThrow(/ADFORGE_PROVIDER_IMAGE/);
  });

  it('fails on a malformed URL', () => {
    expect(() => parseEnv({ COMFYUI_URL: 'localhost:8188' })).toThrow(/COMFYUI_URL/);
  });

  it('defaults the LLM provider and Claude model ids, and rejects malformed ids', () => {
    const env = parseEnv({});
    expect(env.ADFORGE_PROVIDER_LLM).toBe('claude-agent-sdk');
    expect(env.ADFORGE_LLM_STRATEGIST).toBe('claude-sonnet-5-5');
    expect(env.ADFORGE_LLM_DIRECTOR).toBe('claude-opus-5-5');
    expect(() => parseEnv({ ADFORGE_LLM_DIRECTOR: 'claude opus' })).toThrow(/ADFORGE_LLM_DIRECTOR/);
    expect(() => parseEnv({ ADFORGE_LLM_DIRECTOR: 'anthropic/claude-opus-5' })).toThrow(/ADFORGE_LLM_DIRECTOR/);
    expect(parseEnv({ ADFORGE_LLM_DIRECTOR: 'sonnet' }).ADFORGE_LLM_DIRECTOR).toBe('sonnet');
  });

  it('default data dir resolves under the repo root', () => {
    expect(parseEnv({}).ADFORGE_DATA_DIR).toBe(join(REPO_ROOT, '.data'));
  });

  it('absolute data dir passes through', () => {
    const abs = resolve('/adforge-data'); // absolute on both Windows and POSIX
    expect(parseEnv({ ADFORGE_DATA_DIR: abs }).ADFORGE_DATA_DIR).toBe(abs);
  });

  it('relative data dir is not cwd-dependent', () => {
    expect(parseEnv({ ADFORGE_DATA_DIR: 'data/x' }).ADFORGE_DATA_DIR).toBe(join(REPO_ROOT, 'data', 'x'));
  });
});

describe('ADFORGE_PUBLIC_URL', () => {
  it('strips trailing slashes', () => {
    expect(parseEnv({ ADFORGE_PUBLIC_URL: 'http://localhost:3000/' }).ADFORGE_PUBLIC_URL).toBe('http://localhost:3000');
  });
});

describe('ADFORGE_PUBLIC_URL / ADFORGE_UI_ORIGIN defaults', () => {
  it('media is served by the worker; the UI is on 3000', () => {
    const e = parseEnv({});
    expect(e.ADFORGE_PUBLIC_URL).toBe('http://127.0.0.1:3001');
    expect(e.ADFORGE_UI_ORIGIN).toBe('http://localhost:3000');
    for (const u of ['http://localhost:3000/', 'http://localhost:3000/some/path?x=1', 'HTTP://LOCALHOST:3000']) expect(parseEnv({ ADFORGE_UI_ORIGIN: u }).ADFORGE_UI_ORIGIN).toBe('http://localhost:3000');
  });
});

describe('dataDirWarnings', () => {
  it('warns when the data dir is inside OneDrive', () => {
    expect(dataDirWarnings('C:\\Users\\a\\OneDrive\\Desktop\\adforge\\.data')).toHaveLength(1);
  });
  it('is silent outside OneDrive', () => {
    expect(dataDirWarnings('C:\\adforge-data')).toEqual([]);
  });
});
