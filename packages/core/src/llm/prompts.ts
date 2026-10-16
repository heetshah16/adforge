import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

/** Byte-frozen system prompts (prompt-cache friendly). The hash goes into jobs.configSnapshot. */
export function loadPrompt(name: 'strategist' | 'director'): { text: string; sha256: string } {
  const raw = readFileSync(new URL(`../prompts/${name}.md`, import.meta.url));
  return { text: raw.toString('utf8'), sha256: createHash('sha256').update(raw).digest('hex') };
}
