import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT, dataDirWarnings, parseEnv } from '../src/config/env';

describe('parseEnv', () => {
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

  it('fails on a malformed LLM model id', () => {
    expect(() => parseEnv({ ADFORGE_LLM_DIRECTOR: 'claude opus' })).toThrow(/ADFORGE_LLM_DIRECTOR/);
    expect(parseEnv({ ADFORGE_LLM_DIRECTOR: 'anthropic/claude-opus-5' }).ADFORGE_LLM_DIRECTOR).toBe(
      'anthropic/claude-opus-5',
    );
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

describe('dataDirWarnings', () => {
  it('warns when the data dir is inside OneDrive', () => {
    expect(dataDirWarnings('C:\\Users\\a\\OneDrive\\Desktop\\adforge\\.data')).toHaveLength(1);
  });
  it('is silent outside OneDrive', () => {
    expect(dataDirWarnings('C:\\adforge-data')).toEqual([]);
  });
});
