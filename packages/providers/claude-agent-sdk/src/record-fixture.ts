import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { z } from 'zod';
import { query } from '@anthropic-ai/claude-agent-sdk';

const schema = z.toJSONSchema(z.object({ verdict: z.enum(['yes', 'no']) }), { target: 'draft-7' });
const abort = new AbortController();
const timer = setTimeout(() => abort.abort(), 120_000);
let result: unknown;
try {
  for await (const m of query({
    prompt: 'Is the sky usually blue on a clear day? Answer through the schema.',
    options: {
      model: 'claude-sonnet-5-5', effort: 'low', systemPrompt: 'Answer briefly.', tools: [], maxTurns: 4,
      settingSources: [], strictMcpConfig: true, mcpServers: {}, skills: [], persistSession: false, cwd: tmpdir(), abortController: abort,
      outputFormat: { type: 'json_schema', schema: schema as Record<string, unknown> },
    } as Parameters<typeof query>[0]['options'],
  })) {
    if ((m as { type?: string }).type === 'result') result = m;
  }
} finally {
  clearTimeout(timer);
}
if (!result) throw new Error('no result message');
writeFileSync(new URL('../fixtures/result-success.live.json', import.meta.url), JSON.stringify(result, null, 2) + '\n');
console.log('recorded', (result as { subtype: string }).subtype);
