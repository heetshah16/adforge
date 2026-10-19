import { describe, expect, it } from 'vitest';
import { upgradeSpec } from '@adforge/core/spec/upgrade-spec';
import type { VideoSpec } from '@adforge/core/spec/video-spec';
import { assetPath, composeHtml, secs } from '../src/compose';
import { motionTween } from '../src/motion';

const K = (c: string, ext: string) => `${c}${c}/${c.repeat(64)}.${ext}`;

export function sampleSpec(): VideoSpec {
  return upgradeSpec({
    id: 'sample',
    width: 1080,
    height: 1920,
    fps: 30,
    durationInFrames: 90,
    theme: { primary: '#101010', accent: '#ffcc00' },
    scenes: [
      {
        startFrame: 0,
        durationInFrames: 40,
        motion: 'slow_zoom_in',
        layers: [
          { type: 'plate', key: K('a', 'png') },
          { type: 'cutout', key: K('b', 'png'), anchorX: 0.5, anchorY: 0.86, heightFrac: 0.42, shadow: true },
          { type: 'text', content: 'No hexane. Ever.', position: 'top_third', weight: 'bold', scrim: true },
        ],
      },
      { startFrame: 40, durationInFrames: 20, motion: 'static', layers: [{ type: 'video', key: K('c', 'mp4'), trimStartFrame: 6 }] },
      {
        startFrame: 60,
        durationInFrames: 30,
        motion: 'subtle_shake',
        layers: [
          { type: 'plate', key: K('d', 'png') },
          { type: 'text', content: 'Tom & "Jerry" <3', position: 'mid_lower', weight: 'chunky', scrim: false },
        ],
      },
    ],
    audio: { voice: [{ key: K('e', 'wav'), startFrame: 0, durationInFrames: 85 }] },
    captions: {
      position: 'bottom_center',
      words: [
        { text: 'असली', startFrame: 0, endFrame: 12 },
        { text: 'oil', startFrame: 12, endFrame: 30 },
      ],
    },
  });
}

describe('secs', () => {
  it('floors to whole microseconds so frame n always falls inside its clip window', () => {
    expect(secs(0, 30)).toBe('0.000000');
    expect(secs(600, 30)).toBe('20.000000');
    expect(secs(7, 30)).toBe('0.233333');
  });

  it('matches HyperFrames frame semantics for every frame of a 20s video', () => {
    // A clip [startFrame, endFrame) emitted via secs() must contain frame f (sampled at f/fps)
    // exactly when startFrame <= f < endFrame. The producer's frame count must equal n.
    const fps = 30;
    for (let start = 0; start < 600; start += 7) {
      const end = start + 13;
      const s = Number(secs(start, fps));
      const e = Number(secs(end, fps));
      for (let f = Math.max(0, start - 2); f < end + 2; f++) {
        const t = f / fps;
        expect(t >= s && t < e).toBe(f >= start && f < end);
      }
    }
    // Mirrors @hyperframes/producer durationToFrameCount: round when within 1e-3 frames, else ceil.
    // Plain ceil(duration*fps) is wrong: secs(249,30)*30 is 249.00000000000003, so ceil gives 250.
    const frameCount = (duration: number) => {
      const raw = duration * fps;
      const nearest = Math.round(raw);
      return Math.abs(raw - nearest) <= 1e-3 ? nearest : Math.ceil(raw);
    };
    for (const n of [1, 5, 59, 249, 483, 600, 601, 899]) expect(frameCount(Number(secs(n, fps)))).toBe(n);
  });
});

describe('motionTween', () => {
  it('emits finite, deterministic tweens and nothing for static', () => {
    expect(motionTween('#s0-stage', 'static', '0.000000', '1.000000')).toBe('');
    const zoom = motionTween('#s0-stage', 'slow_zoom_in', '0.000000', '1.333333');
    expect(zoom).toContain('fromTo("#s0-stage"');
    expect(zoom).toContain('duration: 1.333333');
    const shake = motionTween('#s1-stage', 'subtle_shake', '2.000000', '1.000000');
    expect(shake).not.toContain('repeat: -1');
    expect(shake).toMatch(/repeat: \d+/);
  });
});

describe('composeHtml', () => {
  const html = composeHtml(sampleSpec());

  it('declares the root with canvas size and a duration that yields the exact frame count', () => {
    expect(html).toContain('data-composition-id="adforge"');
    expect(html).toContain('data-width="1080" data-height="1920"');
    expect(html).toContain('data-duration="3.000000"');
    expect(html).toContain('window.__timelines["adforge"] = tl;');
  });

  it('loads gsap and fonts locally and never from the network', () => {
    expect(html).toContain('<script src="assets/gsap.min.js"></script>');
    expect(html).not.toMatch(/https?:\/\//);
    expect(html).toContain("font-family: 'Inter'");
    expect(html).toContain("font-family: 'Noto Sans Devanagari'");
  });

  it('places video and audio at the root with ids, muted video, and no crossorigin', () => {
    expect(html).toMatch(/<video id="s1-video" class="clip" src="assets\/c{64}\.mp4" muted playsinline data-layer-id="s1\.broll" data-start="1\.333333" data-duration="0\.666667" data-media-start="0\.200000" style="[^"]*"><\/video>/);
    expect(html).toMatch(/<audio id="vo0" src="assets\/e{64}\.wav" data-start="0\.000000" data-duration="2\.833333" data-volume="1"><\/audio>/);
    expect(html).not.toContain('crossorigin');
  });

  it('keeps the product inside the motion stage of its plate, with shadow', () => {
    expect(html).toMatch(/<section id="s0"[^>]*><div class="stage"><img class="plate" src="assets\/a{64}\.png"[^>]*><img class="product shadow" src="assets\/b{64}\.png"/);
    expect(html).toContain('fromTo("#s0 > .stage"');
  });

  it('escapes user text in overlays and captions', () => {
    expect(html).toContain('Tom &amp; &quot;Jerry&quot; &lt;3');
    expect(html).not.toContain('"Jerry" <3');
    expect(html).toContain('>असली<');
  });

  it('times caption words as root clips', () => {
    expect(html).toMatch(/<div id="w0" class="clip cap pos-bottom_center cw-bold" data-start="0\.000000" data-duration="0\.400000"><span>असली<\/span><\/div>/);
  });

  it('maps storage keys to project-relative asset paths', () => {
    expect(assetPath(`ab/${'f'.repeat(64)}.png`)).toBe(`assets/${'f'.repeat(64)}.png`);
    // Prod keys carry the org prefix; the staged file is still the flat content-addressed name.
    expect(assetPath(`org/00000000-0000-4000-8000-000000000001/ab/${'f'.repeat(64)}.png`)).toBe(`assets/${'f'.repeat(64)}.png`);
  });

  it('renders boxes as v1 CSS: product bottom-centre anchored, headline left/top/width', () => {
    // product box { x: 0, y: 0.44, w: 1, h: 0.42 } is the v1 cutout anchor (0.5, 0.86), height 0.42
    expect(html).toMatch(/<img class="product shadow" [^>]*style="left: 50\.000%; top: 86\.000%; height: 42\.000%;">/);
    expect(html).toMatch(/<div class="overlay el-headline w-bold scrim" [^>]*style="left: 6\.000%; top: 14\.000%; width: 88\.000%;">/);
  });

  it('shows each element from its own revealFrame to its scene end', () => {
    const spec = sampleSpec();
    spec.scenes[0]!.layers[2]!.revealFrame = 10; // scene 0 is [0, 40)
    expect(composeHtml(spec)).toContain('data-layer-id="s0.headline" data-start="0.333333" data-duration="1.000000"');
  });

  it('stacks by z, splitting the motion stage around an element placed between plate and product', () => {
    const spec = sampleSpec();
    const [plate, product, headline] = spec.scenes[0]!.layers;
    product!.z = 2;
    headline!.z = 1;
    const s0 = composeHtml(spec).match(/<section id="s0".*?<\/section>/)![0];
    expect(s0.indexOf('class="plate"')).toBeLessThan(s0.indexOf('class="overlay'));
    expect(s0.indexOf('class="overlay')).toBeLessThan(s0.indexOf('class="product'));
    expect(s0.match(/<div class="stage">/g)).toHaveLength(2);
    expect(plate!.z).toBe(0);
  });

  it('resolves asset srcs through assetUrl when given', () => {
    const out = composeHtml(sampleSpec(), { assetUrl: (k) => `/media/${k}` });
    expect(out).toContain(`src="/media/aa/${'a'.repeat(64)}.png"`);
    expect(out).toContain(`src="/media/ee/${'e'.repeat(64)}.wav"`);
    expect(out).not.toContain('src="assets/a');
  });

  it('mixes music and sfx tracks at their gain', () => {
    const spec = sampleSpec();
    spec.audio.music.push({ key: K('f', 'wav'), startFrame: 0, durationInFrames: 90, gainDb: -20 });
    expect(composeHtml(spec)).toMatch(/<audio id="music0" src="assets\/f{64}\.wav" data-start="0\.000000" data-duration="3\.000000" data-volume="0\.1000"><\/audio>/);
  });

  it('styles captions by weight', () => {
    const spec = sampleSpec();
    spec.captions.style.weight = 'chunky';
    expect(composeHtml(spec)).toContain('class="clip cap pos-bottom_center cw-chunky"');
  });

  it('matches the golden composition', async () => {
    await expect(html).toMatchFileSnapshot('./golden/sample.html');
  });
});
