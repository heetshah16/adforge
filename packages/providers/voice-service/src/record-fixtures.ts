import { writeFileSync } from 'node:fs';
import { VoiceClient } from './client';
import { voiceParams } from './params';

const c = new VoiceClient(process.env.ADFORGE_VOICE_URL ?? 'http://127.0.0.1:8190', fetch, 300_000);
console.log(await c.health());
const s = await c.synthesize(voiceParams('Nobody tells you how your cooking oil is made.', 'en', 0.6));
writeFileSync(new URL('../fixtures/synthesize.live.json', import.meta.url), JSON.stringify({ durationSec: s.durationSec.toFixed(6), bytes: s.bytes.length }, null, 2) + '\n');
const a = await c.align(s.bytes, 'en');
writeFileSync(new URL('../fixtures/align.live.json', import.meta.url), JSON.stringify(a, null, 2) + '\n');
console.log('recorded', s.durationSec, a.words.length, await c.unload());
