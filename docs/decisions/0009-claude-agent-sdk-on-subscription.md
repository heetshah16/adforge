# 0009 — Claude via the Agent SDK on the user's subscription (local POC)

**Status:** accepted · 2026-10-16 · supersedes architecture.md §8's OpenRouter routing for the POC

## Decision
- **Provider:** `LLMProvider` id `claude-agent-sdk`, wrapping `@anthropic-ai/claude-agent-sdk` 0.3.287. One `query()` per call:
  - tools disabled (`tools: []`), `maxTurns: 4`;
  - isolation: `settingSources: []`, `strictMcpConfig: true`, `mcpServers: {}`, `skills: []`, `cwd: os.tmpdir()`, `persistSession: false`;
  - structured output through `outputFormat` (JSON Schema draft-07 from Zod), re-validated with Zod;
  - an abort deadline (`PIPELINE.llm.timeoutMs`, 300 s).
- **Models (env):** Strategist `claude-sonnet-5-5` (effort medium), Director `claude-opus-5-5` (effort high); the defaults worked on the subscription, no fallback was needed. Effort is set per role; there are no sampling parameters.
- **Vocabulary in the schema itself:** archetype, format and hook enums are built from the registry and shortlist per call, so the model cannot emit an unknown or off-shortlist slug. The code checks remain the second net.
- **Usage and cost:** `usage` token counts are main-loop only; `modelUsage` has the per-model breakdown. Cost uses `total_cost_usd`.
- **API key:** `ANTHROPIC_API_KEY` is stripped from the SDK subprocess env (`env` replaces the environment, so we pass `process.env` minus the key), so a stray key can never silently switch a subscription run to API billing.
- **Errors:** usage or rate limits → `RATE_LIMIT` (retryable); auth → `AUTH` (not retryable); a timeout → `TIMEOUT`; other failures → `UPSTREAM`.

## Isolation finding
`settingSources: []` alone still loaded the user's MCP servers and plugins: about 31k cache-creation tokens and ~$0.125 per trivial call. (Measured at commit 64c2ebc.) Adding `strictMcpConfig: true`, `mcpServers: {}` and `skills: []` cut that to ~1.2k tokens and ~$0.006. A small `claude-haiku-4-5` CLI-internal helper call still appears in `modelUsage` regardless.

## Scope limit
Subscription credentials are for the user's own local use (Anthropic policy as of 2026). **Before anyone else runs AdForge,** add an API-key `LLMProvider` (the Anthropic SDK direct, or the Agent SDK with `ANTHROPIC_API_KEY`) and switch `ADFORGE_PROVIDER_LLM`.

## Measured (`pnpm e2e:llm`, 2 real products, 3-4 photos each)
| Product | Strategist | Director | Repairs | Est. cost |
|---|---|---|---|---|
| krishna-hing-ras (hi) | 7.1 s, $0.045 | 90.8 s (62.1 s + 26.2 s repair) | 1 | ~$0.35 |
| krishna-special-hing (en) | 7.5 s, $0.041 | 56.4 s | 0 | ~$0.22 |

Cache (read / creation tokens): Strategist 0 / 9114 on the first product and 2924 / 8148 on the second. Director 0 / 7218 on the first product, its repair call 6816 / 3437, and 0 / 7152 on the second product. Costs are the SDK's estimate, not billing.

## Consequences
Caching under the SDK is uneven. The Strategist's frozen prefix is read across products (2924 tokens), and a Director repair reads the first call's prefix (6816 tokens). The Director's zero cross-product cache reads came from our own per-call output schema, not from the SDK: the schema sits in the cache prefix ahead of the system prompt, and it contained the language literal and the shortlist slugs. The language is now an enum (identical across languages), so jobs with the same shortlist share the prefix. Keeping the shortlist slugs in the schema is a deliberate trade-off: a hard off-shortlist guarantee versus about 7k cached tokens when shortlists differ. `cacheReadTokens` is logged per call. The Director dominates cost and latency (~1 min per call).
