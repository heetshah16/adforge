import { describe, expect, it } from 'vitest';
import { compileProject } from '@adforge/core/project';
import { secs, specKeys } from '@adforge/renderer-hyperframes/compose';
import { assetUrlOf, PREVIEW_STATIC_BASE, PREVIEW_RUNTIME_SRC, previewHtml, previewFrame } from '../lib/preview';
import { compileBeats, compileVariant } from './compile-fixture';

const base = { id: 'p1', variant: compileVariant(), theme: { primary: '#141414', accent: '#f5b301' } };
const spec = compileProject({ base, ops: [] }, compileBeats()).spec;
const url = (k: string) => `https://m.test/media/${k}`;

describe('previewHtml', () => {
  const html = previewHtml(spec, url);
  it('loads every asset through mediaUrl and never from a relative assets/ path', () => {
    expect(specKeys(spec).length).toBeGreaterThan(4);
    for (const k of specKeys(spec)) expect(html).toContain(`"${url(k)}"`);
    expect(html).not.toContain('assets/');
    expect(html).toContain(`src="${PREVIEW_STATIC_BASE}/gsap.min.js"`);
    expect(html).toContain(`${PREVIEW_STATIC_BASE}/fonts/inter-800.woff2`);
  });
  it("every element's data-start is secs(revealFrame)", () => {
    const layers = spec.scenes.flatMap((s) => s.layers);
    expect(layers.length).toBeGreaterThan(5);
    for (const l of layers) expect(html).toContain(`data-layer-id="${l.layerId}" data-start="${secs(l.revealFrame, spec.fps)}"`);
  });
  it('the runtime is served same-origin, not from a CDN', () => {
    expect(PREVIEW_RUNTIME_SRC.startsWith('/')).toBe(true);
  });
});

describe('assetUrlOf', () => {
  it('returns the mapped url and throws on a missing key (no raw-key fallback)', () => {
    expect(assetUrlOf({ k: 'http://u/k' }, 'k')).toBe('http://u/k');
    expect(() => assetUrlOf({}, 'ab/x.png')).toThrow(/ab\/x\.png/);
  });
});

describe('previewFrame', () => {
  it('converts a frame to seconds with the compositor\'s own rounding', () => {
    expect(previewFrame(30, 30)).toBe(Number(secs(30, 30)));
    expect(previewFrame(0, 30)).toBe(0);
  });
});
