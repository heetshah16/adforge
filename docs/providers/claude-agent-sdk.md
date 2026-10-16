# Claude Agent SDK — provider reference

**Fetched:** 2026-10-16 from `code.claude.com/docs/en/agent-sdk/structured-outputs` and `…/agent-sdk/typescript`. **Pinned:** `@anthropic-ai/claude-agent-sdk` 0.3.287.

- **`query({ prompt, options })`** returns an async generator of `SDKMessage`. `prompt` is a `string`, or an `AsyncIterable<SDKUserMessage>` for multimodal input.
- **`SDKUserMessage`** = `{ type: 'user', message: MessageParam /* Anthropic SDK */, parent_tool_use_id: string | null, … }`. Images go in `message.content` as Anthropic image blocks: `{ type: 'image', source: { type: 'base64', media_type, data } }`.
- **Options we use:**
  - `model` (alias or full id) and `effort` (`'low'|'medium'|'high'|'xhigh'|'max'`);
  - `systemPrompt` (a string is a custom prompt) and `tools: []`;
  - `maxTurns`, `settingSources: []` (no user, project or local settings, so no CLAUDE.md) and `persistSession: false`;
  - `cwd` and `abortController`;
  - `outputFormat: { type: 'json_schema', schema }`, where the schema is JSON Schema **draft-07** (`z.toJSONSchema(s, { target: 'draft-7' })`).
- **Result message** (`type: 'result'`):
  - `subtype: 'success'` carries `structured_output?`.
  - The error subtypes are `'error_max_turns' | 'error_during_execution' | 'error_max_budget_usd' | 'error_max_structured_output_retries'`, with `errors: string[]`.
  - Both carry `duration_ms`, `is_error`, `total_cost_usd` (an estimate), `usage` (main loop) and `modelUsage` (per model).
- **Treat `subtype: 'success'` without `structured_output` as a failure.**
- A single-shot `query()` **throws after yielding an error result**, so we capture the result before handling the throw.
- **Auth:** the SDK uses the local Claude Code login (subscription) or `ANTHROPIC_API_KEY`. Assistant errors include `authentication_failed`, `oauth_org_not_allowed` and `cloud_credential_error`.
