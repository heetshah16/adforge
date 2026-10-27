import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { extname, join, normalize } from 'node:path';
import { pathToFileURL } from 'node:url';
import { and, count, desc, eq } from 'drizzle-orm';
import sharp from 'sharp';
import { REPO_ROOT, parseEnv } from '@adforge/core/config/env';
import { TREATMENTS } from '@adforge/core/config/treatments';
import type { DirectorVariant } from '@adforge/core/llm/schemas';
import { withStorageOrg } from '@adforge/core/providers/storage-scope';
import { compileProject, type EditOp, type ProjectBase } from '@adforge/core/project';
import { DEFAULT_THEME, type BeatAssets } from '@adforge/core/spec/build-spec';
import type { VideoSpec } from '@adforge/core/spec/video-spec';
import { assets, jobs, libraryAssets, providerCalls, variantRevisions, variants } from '@adforge/db/schema';
import { withUser } from '@adforge/db/with-user';
import { EVENTS, inngest, saveAsset } from '@adforge/pipeline';
import { HEAVY } from '@adforge/pipeline/heavy';
import { buildDeps } from './deps';
// Same cross-app path import as e2e-r2: the handlers are plain functions over a ctx.
import { createRevisionHandler, exportRevisionHandler, type RevisionsCtx } from '../../web/lib/server/revisions-api';
import { previewFrame, previewHtml } from '../../web/lib/preview';

/**
 * C2 end to end. Seeds revision 0 directly (no generateAds): the newest C1 cutout, a sharp-made plate, a 2-scene English variant, one real TTS + align per beat
 * (HEAVY.voice, so the recipes are exactly the ones generateAds records). Then POSTs one revision [unlock, move s0.product, setField beat 1 vo, setStyle captions chunky]
 * through the real web handler, lets Inngest + the worker run adforge/variant.edit and adforge/variant.export, and compares the browser preview with the exported MP4.
 * Needs: voice (Whisper) + voice-qwen, Inngest dev, the worker (`pnpm --filter @adforge/worker start`), FFmpeg on PATH, apps/web/public/hf populated (run `pnpm --filter @adforge/web hf-assets`). No ComfyUI.
 * Prints statuses, counts, keys and diffs only.
 */
try { process.loadEnvFile(join(REPO_ROOT, '.env')); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
const env = parseEnv(process.env);
const { deps, storage, operator, close } = await buildDeps(env);
const { db } = deps;
const t0 = Date.now();
const mins = () => `${((Date.now() - t0) / 60_000).toFixed(1)}m`;
const checks: [string, boolean, string][] = [];
const check = (name: string, ok: boolean, note = '') => { checks.push([name, ok, note]); console.log(`  ${ok ? 'PASS' : 'FAIL'} ${name}${note ? ` - ${note}` : ''}`); };
const inOrg = <T>(fn: () => Promise<T>) => withStorageOrg(operator.orgId, fn);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const HF_DIR = join(REPO_ROOT, 'apps', 'web', 'public', 'hf');
const PLAYER_JS = join(REPO_ROOT, 'apps', 'web', 'node_modules', '@hyperframes', 'player', 'dist', 'hyperframes-player.global.js');
const W = 240, H = 426;
// Comparison grid: both images are area-downscaled 2x to AW x AH, then scored per 16x16 block.
const AW = 120, AH = 213, BLOCK = 16;
/**
 * Score = the WORST 16x16 block's mean abs diff (0-255). A global mean dilutes a missing caption or a one-word shift (a few small blocks) into noise,
 * a block max does not; the global mean is printed as the noise floor. LIMIT is provisional and sits between the expected positive floor and the
 * deliberate negatives. Calibrated live on 2026-10-27: positives' worst blocks 9.1-10.4/255 (global mean 3.2-3.7), negatives 33.2 (3-frame shift)
 * and 49.5 (caption layer missing). 18 leaves ~8 above the positives and ~15 below the closest negative. Each negative must beat LIMIT or the
 * run fails, so a metric that cannot tell a 3-frame shift or a missing caption layer from a match is caught here.
 */
const LIMIT = 18;

const callCounts = async (jobId: string) => {
  const rows = await db.select({ kind: providerCalls.kind, n: count() }).from(providerCalls).where(eq(providerCalls.jobId, jobId)).groupBy(providerCalls.kind);
  return Object.fromEntries(rows.filter((r) => r.kind !== 'render').map((r) => [r.kind, Number(r.n)])) as Record<string, number>;
};
async function until<T>(what: string, ms: number, probe: () => Promise<T | undefined>): Promise<T> {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(3000)) { const v = await probe(); if (v !== undefined) return v; }
  throw new Error(`timed out waiting for ${what}`);
}
const revRow = async (id: string) => (await db.select().from(variantRevisions).where(eq(variantRevisions.id, id)))[0]!;

const tmp = await mkdtemp(join(tmpdir(), 'adforge-e2e-edit-'));
let browser: { close(): Promise<void> } | undefined;
let server: ReturnType<typeof createServer> | undefined;
try {
  // ---- 1. seed revision 0 ------------------------------------------------------------------------------------------------------------------
  const cands = await db.select({ meta: libraryAssets.meta, tag: libraryAssets.tag }).from(libraryAssets)
    .where(and(eq(libraryAssets.orgId, operator.orgId), eq(libraryAssets.kind, 'product_view'))).orderBy(desc(libraryAssets.createdAt));
  const lib = cands.find((c) => typeof (c.meta as { cutoutKey?: unknown }).cutoutKey === 'string');
  if (!lib) throw new Error('no product_view library row with meta.cutoutKey in the operator org - run `pnpm e2e:library` first');
  const cutout = (lib.meta as { cutoutKey: string }).cutoutKey;
  await inOrg(() => storage.read(cutout)); // fail early if the key is gone
  console.log(`library cutout from ${lib.tag}`);

  const plateBytes = await sharp(Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1920"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#2b3a67"/><stop offset="1" stop-color="#e8a87c"/></linearGradient></defs><rect width="1080" height="1920" fill="url(#g)"/></svg>`,
  )).png().toBuffer();
  const plate = await inOrg(() => storage.put(plateBytes, { mime: 'image/png' }));
  await saveAsset(db, operator, 'plate', plate);

  const treatment = Object.keys(TREATMENTS)[0] as DirectorVariant['visual_treatment'];
  const scene = (beat: string, vo: string, overlay: string, prom: 'hero' | 'supporting') => ({
    beat, vo, overlay, scene: 'a warm kitchen counter in soft morning light', product_prominence: prom, duration: 2, motion: 'slow_zoom_in' as const, emotion: 0.5,
  });
  const variant = {
    variant_no: 1, format: 'e2e-edit', hook_archetype: 'e2e-edit', visual_treatment: treatment, strategic_bet: 'e2e fixture for the editable composition check',
    hook_text: 'Fresh taste', language: 'en',
    scenes: [scene('hook', 'Meet the tin that changes dinner.', 'Meet the tin', 'hero'), scene('proof', 'One pinch and the whole pot wakes up.', 'One pinch', 'supporting')],
    cta: 'Try it tonight', caption: 'e2e-edit fixture',
  } as DirectorVariant;

  const stamp = new Date().toISOString().slice(0, 16).replace(/\D/g, '');
  const [job] = await db.insert(jobs).values({
    orgId: operator.orgId, projectId: operator.projectId, userId: operator.userId, status: 'completed',
    inputSpec: { product: { name: `e2e-edit ${stamp}` }, language: 'en', broll: false, photoKeys: [] }, configSnapshot: { voice: 'config-defaults' },
  }).returning();
  const jobId = job!.id;
  const [vrow] = await db.insert(variants).values({
    orgId: operator.orgId, jobId, variantNo: 1, formatSlug: 'e2e-edit', hookSlug: 'e2e-edit', archetypeSlug: 'e2e-edit',
    visualTreatment: treatment, strategicBet: variant.strategic_bet, direction: variant, status: 'completed',
  }).returning();
  const variantId = vrow!.id;

  // One real TTS + align per beat, with the recipes generateAds would record. Not counted in the delta (snapshot comes after).
  const voice = await inOrg(() => HEAVY.voice(deps, { jobId, language: 'en', variants: [variant] }));
  const beats: BeatAssets[] = variant.scenes.map((_, b) => {
    const v = voice.beats[`1:${b}`];
    if (!v) throw new Error(`seed voice for beat ${b} failed`);
    return { plate: plate.id, cutout, voice: { key: v.key, durationSec: v.durationSec }, words: v.words };
  });
  const base: ProjectBase = { id: `${jobId}-v1`, variant, theme: DEFAULT_THEME };
  const spec0 = compileProject({ base, ops: [] }, beats).spec;
  await db.update(variants).set({ projectBase: base, spec: spec0 }).where(eq(variants.id, variantId));
  const [rev0] = await db.insert(variantRevisions).values({ orgId: operator.orgId, variantId, ops: [], beats, spec: spec0, status: 'ready', locked: true }).returning();
  console.log(`[${mins()}] seeded job ${jobId} variant ${variantId} revision0 ${rev0!.id} (${spec0.durationInFrames} frames)`);

  // ---- 2. POST the edit through the web handler --------------------------------------------------------------------------------------------
  const before = await callCounts(jobId);
  const ORIGIN = env.ADFORGE_UI_ORIGIN;
  const ctx: RevisionsCtx = {
    auth: async () => ({ userId: operator.userId, orgId: operator.orgId, email: 'e2e@adforge.invalid', isAdmin: false }),
    run: (uid, fn) => withUser(db, uid, fn),
    siteUrl: ORIGIN,
    send: async (revisionId) => { await inngest.send({ name: EVENTS.variantEdit, data: { revisionId }, id: revisionId }); },
    sendExport: async (revisionId) => { await inngest.send({ name: EVENTS.variantExport, data: { revisionId } }); },
    fail: async (revisionId, reason) => { await db.update(variantRevisions).set({ status: 'failed', error: { message: reason } }).where(eq(variantRevisions.id, revisionId)); },
  };
  const post = (path: string, body?: unknown) => new Request(`${ORIGIN}${path}`, { method: 'POST', headers: { origin: ORIGIN, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const productBox = spec0.scenes[0]!.layers.find((l) => l.layerId === 's0.product')!.box;
  const target = { x: +(productBox.x + 0.1).toFixed(3), y: +(productBox.y - 0.05).toFixed(3) };
  // Unique per run: a repeated line is (correctly) a recipe-cache hit for this org, which would make the TTS/align delta 0.
  const NEW_VO = `Just one pinch wakes up the whole pot, batch ${stamp}.`;
  const ops: EditOp[] = [
    { op: 'unlock' },
    { op: 'move', layerId: 's0.product', ...target },
    { op: 'setField', beat: 1, path: 'vo', value: NEW_VO },
    { op: 'setStyle', layerId: 'captions', style: { weight: 'chunky' } },
  ];
  const res = await createRevisionHandler(ctx, post(`/api/variants/${variantId}/revisions`, { parentId: rev0!.id, ops }), variantId);
  const created = (await res.json()) as { revisionId?: string; error?: string };
  check('POST revision accepted (202)', res.status === 202 && !!created.revisionId, `${res.status} ${created.error ?? ''}`.trim());
  if (!created.revisionId) throw new Error('revision not created');
  const revId = created.revisionId;

  // ---- 3. wait for ready; provider-call delta ---------------------------------------------------------------------------------------------
  const ready = await until('revision ready', 15 * 60_000, async () => {
    const r = await revRow(revId);
    if (r.status === 'failed') throw new Error(`revision failed: ${JSON.stringify(r.error)}`);
    return r.status === 'ready' ? r : undefined;
  });
  console.log(`[${mins()}] revision ${revId} ready`);
  const after = await callCounts(jobId);
  const delta: Record<string, number> = {};
  for (const k of new Set([...Object.keys(before), ...Object.keys(after)])) if ((after[k] ?? 0) - (before[k] ?? 0) !== 0) delta[k] = (after[k] ?? 0) - (before[k] ?? 0);
  check('provider-call delta outside render is exactly {tts:1, align:1}', JSON.stringify(Object.entries(delta).sort()) === JSON.stringify([['align', 1], ['tts', 1]]), JSON.stringify(delta));

  // ---- 4. compiled spec shows all three ops -----------------------------------------------------------------------------------------------
  const spec1 = ready.spec as VideoSpec;
  const beats1 = ready.beats as BeatAssets[];
  const box1 = spec1.scenes[0]!.layers.find((l) => l.layerId === 's0.product')!.box;
  check('product box moved', Math.abs(box1.x - target.x) < 1e-6 && Math.abs(box1.y - target.y) < 1e-6, `(${productBox.x.toFixed(3)},${productBox.y.toFixed(3)}) -> (${box1.x.toFixed(3)},${box1.y.toFixed(3)})`);
  check("beat 1's voice key changed, beat 0's did not", beats1[1]!.voice.key !== beats[1]!.voice.key && beats1[0]!.voice.key === beats[0]!.voice.key, `beat1 ${beats[1]!.voice.key.slice(-20)} -> ${beats1[1]!.voice.key.slice(-20)}`);
  check('captions weight is chunky', spec1.captions.style.weight === 'chunky', `was ${spec0.captions.style.weight}`);
  check('no dropped ops', ready.error === null, JSON.stringify(ready.error));

  // ---- 5. export ---------------------------------------------------------------------------------------------------------------------------
  const ex = await exportRevisionHandler(ctx, post(`/api/variants/${variantId}/revisions/${revId}/export`), variantId, revId);
  check('POST export accepted (202)', ex.status === 202, String(ex.status));
  const renderAssetId = await until('render_asset_id', 20 * 60_000, async () => (await revRow(revId)).renderAssetId ?? undefined);
  const [asset] = await db.select({ key: assets.storageKey }).from(assets).where(eq(assets.id, renderAssetId));
  const mp4Path = join(tmp, 'export.mp4');
  await writeFile(mp4Path, await inOrg(() => storage.read(asset!.key)));
  console.log(`[${mins()}] export rendered: ${asset!.key}`);

  // ---- 6. preview in headless Chrome vs the MP4 --------------------------------------------------------------------------------------------
  const MIME: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.wav': 'audio/wav', '.mp4': 'video/mp4', '.js': 'text/javascript', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.html': 'text/html' };
  const html = previewHtml(spec1, (k) => `/media/${k}`); // same origin as the page: no CORS between the srcdoc iframe and storage
  const htmlNoCaptions = previewHtml({ ...spec1, captions: { ...spec1.captions, words: [] } }, (k) => `/media/${k}`);
  const page = `<!doctype html><meta charset="utf-8"><style>html,body{margin:0;background:#000}[data-preview]{width:${W}px;height:${H}px;overflow:hidden}hyperframes-player{display:block;width:${W}px;height:${H}px}</style>
<div data-preview></div><script src="/player.js"></script><script>
const host = document.querySelector('[data-preview]');
fetch(location.search === '?nocap' ? '/comp-nocap.html' : '/comp.html').then((r) => r.text()).then((srcdoc) => {
  const p = document.createElement('hyperframes-player');
  p.setAttribute('runtime-src', location.origin + '/hf/hyperframe.runtime.iife.js');
  p.setAttribute('width', '${spec1.width}'); p.setAttribute('height', '${spec1.height}');
  p.setAttribute('srcdoc', srcdoc);
  p.addEventListener('ready', () => host.setAttribute('data-ready', ''));
  host.append(p);
  window.__seekSec = (s) => { p.pause(); p.seek(s); };
});
</script>`;
  server = createServer((req, res) => {
    void (async () => {
      try {
        const path = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname);
        let body: Uint8Array | string;
        if (path === '/') body = page;
        else if (path === '/comp.html') body = html;
        else if (path === '/comp-nocap.html') body = htmlNoCaptions;
        else if (path === '/player.js') body = await readFile(PLAYER_JS);
        else if (path.startsWith('/hf/')) {
          const f = normalize(join(HF_DIR, path.slice(4)));
          if (!f.startsWith(HF_DIR)) throw new Error('bad path');
          body = await readFile(f);
        } else if (path.startsWith('/media/')) body = await inOrg(() => storage.read(path.slice(7)));
        else { res.writeHead(404).end(); return; }
        res.writeHead(200, { 'content-type': MIME[path === '/' || path.startsWith('/comp') ? '.html' : extname(path)] ?? 'application/octet-stream' }).end(body);
      } catch { res.writeHead(404).end(); }
    })();
  }).listen(0, '127.0.0.1');
  await new Promise((r) => server!.once('listening', r));
  const pageUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;

  // puppeteer is the renderer's transitive dependency (via @hyperframes/engine), not the worker's.
  const fromEngine = createRequire(createRequire(join(REPO_ROOT, 'packages', 'renderer-hyperframes', 'package.json')).resolve('@hyperframes/engine/package.json'));
  const puppeteer = ((await import(pathToFileURL(fromEngine.resolve('puppeteer')).href)) as { default: { launch(o: object): Promise<any> } }).default; // eslint-disable-line @typescript-eslint/no-explicit-any
  const b = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] });
  browser = b;
  const pg = await b.newPage();
  await pg.setViewport({ width: W, height: H, deviceScaleFactor: 1 });
  await pg.goto(pageUrl);
  await pg.waitForSelector('[data-preview][data-ready]', { timeout: 60_000 });

  // Take the colour interpretation from the export itself, never ffmpeg's guess: an untagged BT.709 limited-range file decoded as BT.601/full shifts every pixel.
  const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=color_space,color_range', '-of', 'json', mp4Path]).toString()) as { streams: { color_space?: string; color_range?: string }[] };
  const st = probe.streams[0] ?? {};
  const matrix = st.color_space === 'bt470bg' || st.color_space === 'smpte170m' ? 'bt601' : st.color_space === 'smpte240m' ? 'smpte240m' : st.color_space === 'bt2020nc' ? 'bt2020' : 'bt709'; // untagged HD: bt709
  const range = st.color_range === 'pc' || st.color_range === 'jpeg' ? 'pc' : 'tv'; // untagged h264 yuv420p: broadcast range
  console.log(`export colour: space=${st.color_space ?? '(untagged)'} range=${st.color_range ?? '(untagged)'} -> matrix ${matrix}, range ${range}`);

  /** MP4 frame n as AWxAH rgb24: area-downscaled, decoded with the export's own matrix and range into full-range RGB. */
  const mp4Frame = async (n: number) => {
    const out = join(tmp, `mp4-${n}.png`);
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', mp4Path, '-vf', `select=eq(n\\,${n}),scale=${AW}:${AH}:flags=area:in_color_matrix=${matrix}:in_range=${range}:out_range=pc,format=rgb24`, '-frames:v', '1', out]);
    return sharp(out).removeAlpha().raw().toBuffer();
  };
  /** A preview screenshot as AWxAH rgb24 through the same area filter (a PNG is already full-range sRGB). */
  const shotFrame = async (png: Buffer, tag: string) => {
    const inp = join(tmp, `shot-${tag}.png`), out = join(tmp, `shot-${tag}-small.png`);
    await writeFile(inp, png);
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', inp, '-vf', `scale=${AW}:${AH}:flags=area,format=rgb24`, '-frames:v', '1', out]);
    return sharp(out).removeAlpha().raw().toBuffer();
  };
  const score = (a: Buffer, b: Buffer) => {
    if (a.length !== b.length) return { max: Infinity, mean: Infinity };
    let total = 0, worst = 0;
    for (let y0 = 0; y0 < AH; y0 += BLOCK) for (let x0 = 0; x0 < AW; x0 += BLOCK) {
      let sum = 0, cnt = 0;
      for (let y = y0; y < Math.min(y0 + BLOCK, AH); y++) for (let x = x0; x < Math.min(x0 + BLOCK, AW); x++) for (let c = 0; c < 3; c++, cnt++) sum += Math.abs(a[(y * AW + x) * 3 + c]! - b[(y * AW + x) * 3 + c]!);
      worst = Math.max(worst, sum / cnt);
    }
    for (let i = 0; i < a.length; i++) total += Math.abs(a[i]! - b[i]!);
    return { max: worst, mean: total / a.length };
  };
  const seekShot = async (n: number, tag: string) => {
    await pg.evaluate((sec: number) => (globalThis as unknown as { __seekSec(s: number): void }).__seekSec(sec), previewFrame(n, spec1.fps));
    await sleep(1500); // let the seek paint (images, fonts)
    return shotFrame(Buffer.from(await pg.screenshot({ type: 'png', clip: { x: 0, y: 0, width: W, height: H } })), tag);
  };
  const fmt = (r: { max: number; mean: number }) => `worst 16x16 block ${r.max.toFixed(2)}/255, global mean ${r.mean.toFixed(2)}/255`;

  const D = spec1.durationInFrames;
  const positives: number[] = [];
  for (const [label, n] of [['first', 0], ['mid', Math.floor(D / 2)], ['last-1', D - 2]] as const) {
    const r = score(await seekShot(n, `p${n}`), await mp4Frame(n));
    positives.push(r.max);
    check(`preview frame ${n} (${label}) matches the MP4: worst block <= ${LIMIT}`, r.max <= LIMIT, fmt(r));
  }

  // Deliberate negatives, scored in this same run: they must EXCEED the positive limit, or the metric cannot see what it is meant to see.
  const words = spec1.captions.words;
  if (words.length < 3) throw new Error('need at least 3 caption words for the negatives');
  const w = words[Math.floor(words.length / 2)]!;
  const nCap = Math.floor((w.startFrame + w.endFrame) / 2); // a caption word is on screen
  const nShift = w.startFrame - 1; // the caption changes between N and N+3
  check('negative frames are inside the video', nShift >= 0 && nShift + 3 < D && nCap < D, `nShift ${nShift}, nCap ${nCap}, D ${D}`);
  const shifted = score(await seekShot(nShift, 'neg-shift'), await mp4Frame(nShift + 3));
  check(`negative: preview frame ${nShift} vs MP4 frame ${nShift + 3} exceeds ${LIMIT}`, shifted.max > LIMIT, fmt(shifted));
  // The same composition without caption words, same frame: the page loads /comp-nocap.html on ?nocap.
  await pg.goto(`${pageUrl}?nocap`);
  await pg.waitForSelector('[data-preview][data-ready]', { timeout: 60_000 });
  const hidden = score(await seekShot(nCap, 'neg-nocap'), await mp4Frame(nCap));
  check(`negative: preview without the caption layer vs the MP4 (frame ${nCap}) exceeds ${LIMIT}`, hidden.max > LIMIT, fmt(hidden));
  console.log(`  positives ${positives.map((x) => x.toFixed(2)).join(', ')} | negatives ${shifted.max.toFixed(2)}, ${hidden.max.toFixed(2)} | LIMIT ${LIMIT}`);
} catch (e) {
  check('run completed', false, e instanceof Error ? e.message : String(e));
} finally {
  await browser?.close().catch(() => {});
  await new Promise((r) => (server ? server.close(() => r(null)) : r(null)));
  await rm(tmp, { recursive: true, force: true }).catch(() => {});
  await close();
}
console.log(`\n${checks.every((c) => c[1]) ? 'PASS' : 'FAIL'} in ${mins()}`);
process.exit(checks.length && checks.every((c) => c[1]) ? 0 : 1);
