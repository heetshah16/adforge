import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT, dataDirWarnings, parseEnv } from '../src/config/env';

describe('parseEnv', () => {
  it('defaults the voice providers and URL', () => {
    const env = parseEnv({});
    expect(env.ADFORGE_PROVIDER_TTS).toBe('chatterbox');
    expect(env.ADFORGE_PROVIDER_ALIGNER).toBe('whisper');
    expect(env.ADFORGE_VOICE_URL).toBe('http://127.0.0.1:8190');
    expect(() => parseEnv({ ADFORGE_PROVIDER_TTS: 'kokoro' })).toThrow(/ADFORGE_PROVIDER_TTS/);
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
    expect(parseEnv({ ADFORGE_DATA_DIR: 'C:\\adforge-data' }).ADFORGE_DATA_DIR).toBe('C:\\adforge-data');
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
