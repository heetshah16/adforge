import { describe, expect, it } from 'vitest';
import { parseEnv } from '../src/config/env';
import { POC_ONLY_PROVIDERS, assertProviderPolicy } from '../src/providers/policy';

const pocOnly = new Set(['claude-agent-sdk']);
const prodEnv = () => parseEnv({ ADFORGE_ENV: 'prod', DATABASE_URL: 'postgresql://u:p@h:5432/d' });

describe('assertProviderPolicy', () => {
  it('allows POC-only providers in dev', () => {
    expect(() => assertProviderPolicy(parseEnv({}), pocOnly)).not.toThrow();
  });

  it('refuses POC-only providers in prod, naming the key', () => {
    const run = () => assertProviderPolicy(prodEnv(), pocOnly);
    expect(run).toThrow(/claude-agent-sdk.*POC-only/);
    expect(run).toThrow(/ADFORGE_PROVIDER_LLM/);
  });

  it('passes in prod with the real (empty) POC-only set', () => {
    expect(POC_ONLY_PROVIDERS.size).toBe(0);
    expect(() => parseEnv({ ADFORGE_ENV: 'prod', DATABASE_URL: 'postgresql://u:p@h:5432/d' })).not.toThrow();
  });
});
