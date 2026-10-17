import type { Env } from '../config/env';

/** Provider ids that exist only for the local POC and must never boot in prod. B6 adds 'claude-agent-sdk'. */
export const POC_ONLY_PROVIDERS: ReadonlySet<string> = new Set();

export function assertProviderPolicy(env: Env, pocOnly: ReadonlySet<string> = POC_ONLY_PROVIDERS): void {
  if (env.ADFORGE_ENV !== 'prod') return;
  for (const [key, id] of Object.entries(env)) {
    if (key.startsWith('ADFORGE_PROVIDER_') && pocOnly.has(String(id))) {
      throw new Error(`${key}=${id} is POC-only and refused in prod`);
    }
  }
}
