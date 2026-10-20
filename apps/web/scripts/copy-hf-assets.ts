// Copies the preview's static files (gsap, fonts, HyperFrames runtime) from node_modules to public/hf/ (gitignored, never committed).
import { copyFileSync, mkdirSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FONT_FILES } from '@adforge/renderer-hyperframes/compose';

const web = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(web, 'public', 'hf');
// Resolve gsap and the fonts from where the renderer resolves them (its package.json is not in its exports map).
const fromRenderer = createRequire(join(realpathSync(join(web, 'node_modules', '@adforge', 'renderer-hyperframes')), 'package.json'));
const fromPlayer = createRequire(createRequire(import.meta.url).resolve('@hyperframes/player'));

mkdirSync(join(out, 'fonts'), { recursive: true });
copyFileSync(fromRenderer.resolve('gsap/dist/gsap.min.js'), join(out, 'gsap.min.js'));
// The runtime the player would otherwise fetch from jsDelivr; served same-origin via the player's runtime-src attribute.
copyFileSync(fromPlayer.resolve('@hyperframes/core/runtime'), join(out, 'hyperframe.runtime.iife.js'));
for (const f of FONT_FILES) copyFileSync(join(dirname(fromRenderer.resolve(`${f.pkg}/package.json`)), f.src), join(out, 'fonts', f.file));
console.log(`copied preview assets to ${out}`);
