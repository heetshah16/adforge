import { writeFileSync } from 'node:fs';
import { QwenClient, qwenParams } from './qwen';

// Records ONE live Qwen /synthesize (duration + byte count only). Start voice-qwen first; unloads afterwards.
const c = new QwenClient(process.env.ADFORGE_QWEN_TTS_URL ?? 'http://127.0.0.1:8191', fetch, 600_000);
console.log(await c.ttsHealth());
const s = await c.synthesize(qwenParams('Nobody tells you how your cooking oil is made.', 0.6));
writeFileSync(new URL('../fixtures/qwen-synthesize.live.json', import.meta.url), JSON.stringify({ durationSec: s.durationSec.toFixed(6), bytes: s.bytes.length }, null, 2) + '\n');
console.log('recorded', s.durationSec, s.bytes.length, await c.unload());
