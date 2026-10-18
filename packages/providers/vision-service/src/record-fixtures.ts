// Usage: tsx src/record-fixtures.ts <image path>   (vision service must be running; image bytes are never saved)
import { readFileSync, writeFileSync } from 'node:fs';
import { VisionClient } from './client';

const c = new VisionClient(process.env.ADFORGE_VISION_URL ?? 'http://127.0.0.1:8192');
const img = new Uint8Array(readFileSync(process.argv[2]!));
const out = (n: string, v: unknown) => writeFileSync(new URL(`../fixtures/${n}.live.json`, import.meta.url), JSON.stringify(v, null, 2) + '\n');
console.log(await c.health());
const d = await c.depth(img);
out('depth', { width: d.width, height: d.height, bytes: d.bytes.length, near: 'high', mime: 'image/png' });
out('ocr', { items: await c.ocr(img, ['en', 'hi']) });
out('luma', { grid: await c.luma(img, 8) });
console.log('recorded', d.width, d.height, await c.unload());
