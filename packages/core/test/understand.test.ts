import { describe, expect, it } from 'vitest';
import { parseEnv } from '../src/config/env';
import { loadPrompt } from '../src/llm/prompts';
import type { LlmDeps } from '../src/llm/strategize';
import type { MediaRef, OcrItem } from '../src/providers/types';
import { analyzePlate, analyzeProduct, renderOcr } from '../src/understand/analyze';
import { PlateAnalysis, ProductAnalysis, productAnalysisFor, unreadQuotes } from '../src/understand/schemas';
import { fakeLLM } from './fake-llm';

const words = (n: number) => Array.from({ length: n }, (_, i) => `w${i}`).join(' ');
const ok = {
  shapeClass: 'pouch', viewpoint: { azimuthDeg: 0, elevationDeg: 5 }, lightDirection: null, palette: ['#aa0000', '#FFFFFF'],
  material: 'laminated foil', finish: 'matte', visibleFaces: ['front'], descriptor: words(50), bestPhotoIndex: 0,
};
const plate = {
  cameraHeight: 'table', tiltDeg: -10, horizonY: 0.4, supportSurface: { box: [0, 0.6, 1, 0.4] },
  light: { azimuthDeg: 45, colorTempK: 5200 }, freeZones: [[0, 0, 0.5, 0.5]],
};
const ocr = (...t: string[]): OcrItem[] => t.map((text) => ({ text, box: [0, 0, 0.1, 0.1], conf: 0.9 }));
const ref = (id: string): MediaRef => ({ id, url: `http://x/media/${id}`, mime: 'image/jpeg', sha256: 'a'.repeat(64), bytes: 3 });
const storage = { read: async () => new Uint8Array([1, 2, 3]) };
const deps = (llm: ReturnType<typeof fakeLLM>) => ({ llm, model: 'm', effort: 'low', idempotencyKey: 'k', storage }) as LlmDeps & { storage: typeof storage };

describe('ProductAnalysis', () => {
  it('accepts a valid analysis', () => expect(ProductAnalysis.safeParse(ok).success).toBe(true));
  it('bounds the descriptor to 40-120 words', () => {
    expect(ProductAnalysis.safeParse({ ...ok, descriptor: words(39) }).success).toBe(false);
    expect(ProductAnalysis.safeParse({ ...ok, descriptor: words(40) }).success).toBe(true);
    expect(ProductAnalysis.safeParse({ ...ok, descriptor: words(120) }).success).toBe(true);
    expect(ProductAnalysis.safeParse({ ...ok, descriptor: words(121) }).success).toBe(false);
  });
  it.each([
    ['shapeClass', 'tub'], ['palette', []], ['palette', ['red']], ['palette', Array(7).fill('#000000')], ['material', 'x'.repeat(41)],
    ['visibleFaces', []], ['viewpoint', { azimuthDeg: 181, elevationDeg: 0 }], ['bestPhotoIndex', 0.5],
  ])('rejects bad %s', (k, v) => expect(ProductAnalysis.safeParse({ ...ok, [k]: v }).success).toBe(false));
});

describe('descriptor guard', () => {
  const o = [ocr('KRISHNA', 'Hing Ras')];
  const withQuote = (q: string) => ({ ...ok, descriptor: `${words(45)} ${q}` });
  it('fails on a quoted string OCR did not return, in all quote styles', () => {
    const s = productAnalysisFor(o);
    for (const q of ['"Pure Gold"', '“Pure Gold”', "'Pure Gold'"]) expect(s.safeParse(withQuote(q)).success, q).toBe(false);
  });
  it('passes quotes present in OCR (case-insensitive) and apostrophes in words', () => {
    const s = productAnalysisFor(o);
    expect(s.safeParse(withQuote('"krishna" and "HING RAS"')).success).toBe(true);
    expect(s.safeParse(withQuote("the tin's lid")).success).toBe(true);
    expect(unreadQuotes('no quotes here', [])).toEqual([]);
  });
  it('treats empty OCR as nothing quotable', () => expect(unreadQuotes('a "Brand" tin', [[]])).toEqual(['Brand']));
});

describe('PlateAnalysis', () => {
  it('accepts a valid plate and nulls', () => {
    expect(PlateAnalysis.safeParse(plate).success).toBe(true);
    expect(PlateAnalysis.safeParse({ ...plate, horizonY: null, supportSurface: null }).success).toBe(true);
  });
  it.each([['freeZones', Array(5).fill([0, 0, 1, 1])], ['light', { azimuthDeg: 0, colorTempK: 1000 }], ['horizonY', 1.2], ['cameraHeight', 'low']])('rejects bad %s', (k, v) =>
    expect(PlateAnalysis.safeParse({ ...plate, [k]: v }).success).toBe(false));
});

describe('frozen prompts', () => {
  it('golden bytes', () => {
    expect(loadPrompt('vision-product').sha256).toBe('788d815fcc24779c35be196e5e28909a50e7f5914313887212abd186cd095ad2');
    expect(loadPrompt('vision-plate').sha256).toBe('93b938e26bc378d91ecac929958a5c31c62c5be4ad19f2732376b2d001ce6b27');
  });
  it('carry no per-job content', () => {
    for (const n of ['vision-product', 'vision-plate'] as const) expect(loadPrompt(n).text).not.toMatch(/\{\{|\$\{|KRISHNA|Krishna/);
  });
});

describe('env', () => {
  it('defaults the vision model and effort, and rejects a bad id', () => {
    const e = parseEnv({});
    expect(e.ADFORGE_LLM_VISION).toBe('claude-sonnet-5-5');
    expect(e.ADFORGE_LLM_EFFORT_VISION).toBe('low');
    expect(() => parseEnv({ ADFORGE_LLM_VISION: 'Bad Id!' })).toThrow();
  });
});

describe('analyzeProduct', () => {
  const input = { images: [ref('a'), ref('b')], ocr: [ocr('KRISHNA'), []] };
  it('sends images then OCR in the user message, system untouched by OCR, no sampling params', async () => {
    const llm = fakeLLM([ok]);
    const r = await analyzeProduct(input, deps(llm));
    expect(r.result.status).toBe('done');
    const req = llm.calls[0]!;
    expect(req.user.map((c) => c.type)).toEqual(['image', 'image', 'text']);
    expect((req.user[2] as { text: string }).text).toContain('Photo 0 OCR text: KRISHNA');
    expect((req.user[2] as { text: string }).text).toContain('Photo 1 OCR text: (none read)');
    expect(req.system).toBe(loadPrompt('vision-product').text);
    expect(Object.keys(req)).not.toContain('temperature');
  });
  it('repairs once when the descriptor quotes unread text', async () => {
    const bad = { ...ok, descriptor: `${words(45)} "Invented"` };
    const llm = fakeLLM([bad, ok]);
    const r = await analyzeProduct(input, deps(llm));
    expect(r.repairs).toBe(1);
    expect(r.result.status).toBe('done');
    expect(llm.calls[1]!.idempotencyKey).toBe('k:repair1');
    expect((llm.calls[1]!.user.at(-1) as { text: string }).text).toContain('did not return: "Invented"');
  });
  it('fails clearly after one repair', async () => {
    const bad = { ...ok, descriptor: `${words(45)} "Invented"` };
    const r = await analyzeProduct(input, deps(fakeLLM([bad, bad])));
    expect(r.result.status).toBe('failed');
    if (r.result.status === 'failed') expect(r.result.error.message).toMatch(/still quotes text OCR did not return/);
  });
  it('renders OCR deterministically', () => expect(renderOcr([ocr('A', 'B')])).toContain('Photo 0 OCR text: A B'));
});

describe('analyzePlate', () => {
  it('returns the parsed plate', async () => {
    const llm = fakeLLM([plate]);
    const r = await analyzePlate({ image: ref('p') }, deps(llm));
    expect(r.status).toBe('done');
    expect(llm.calls[0]!.system).toBe(loadPrompt('vision-plate').text);
  });
});
