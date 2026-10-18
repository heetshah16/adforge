import { describe, expect, it } from 'vitest';
import { parseEnv } from '../src/config/env';
import { loadPrompt } from '../src/llm/prompts';
import type { LlmDeps } from '../src/llm/strategize';
import type { MediaRef, OcrItem } from '../src/providers/types';
import { analyzePlate, analyzeProduct, renderOcr } from '../src/understand/analyze';
import { PlateAnalysis, ProductAnalysis, labelTextViolations } from '../src/understand/schemas';
import { failed, fakeLLM } from './fake-llm';

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
  it.each(['a "Pure Gold" band', 'a “Pure Gold” band', "a 'Pure Gold' band"])('flags quotes: %s', (d) => expect(labelTextViolations(d)).toEqual(['Pure Gold']));
  it('flags ALL-CAPS tokens of 3+ letters and digit runs (ASCII and Devanagari)', () => {
    expect(labelTextViolations('a red band reading KRISHNA and SINCE 1925')).toEqual(['KRISHNA', 'SINCE', '1925']);
    expect(labelTextViolations('seal १९२५ and 100 g tin')).toEqual(['१९२५', '100']);
  });
  it('passes layout prose, units, hex-free short caps and apostrophes', () => {
    expect(labelTextViolations("a red band with white Latin script, 25 ml and 5 kg marks, the tin's lid, an ML or KG unit, a 12 cm seal")).toEqual([]);
  });
});

describe('PlateAnalysis', () => {
  it('accepts a valid plate and nulls', () => {
    expect(PlateAnalysis.safeParse(plate).success).toBe(true);
    expect(PlateAnalysis.safeParse({ ...plate, horizonY: null, supportSurface: null }).success).toBe(true);
  });
  it('rejects boxes that leave the image', () => {
    expect(PlateAnalysis.safeParse({ ...plate, freeZones: [[0.6, 0, 0.5, 0.5]] }).success).toBe(false);
    expect(PlateAnalysis.safeParse({ ...plate, supportSurface: { box: [0, 0.7, 1, 0.4] } }).success).toBe(false);
  });
  it.each([['freeZones', Array(5).fill([0, 0, 1, 1])], ['light', { azimuthDeg: 0, colorTempK: 1000 }], ['horizonY', 1.2], ['cameraHeight', 'low']])('rejects bad %s', (k, v) =>
    expect(PlateAnalysis.safeParse({ ...plate, [k]: v }).success).toBe(false));
});

describe('frozen prompts', () => {
  it('golden bytes', () => {
    expect(loadPrompt('vision-product').sha256).toBe('fd76d9859ffa738d82fd5889e0b7ca8a140c78d0b8e0df7812a2b39a30db51b9');
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
  const leaky = { ...ok, descriptor: `${words(45)} KRISHNA 1925` };
  it('sends images then OCR as context in the user message; the request has exactly the expected keys', async () => {
    const llm = fakeLLM([ok]);
    const r = await analyzeProduct(input, deps(llm));
    expect(r.result.status).toBe('done');
    const req = llm.calls[0]!;
    expect(Object.keys(req).sort()).toEqual(['effort', 'idempotencyKey', 'model', 'schema', 'system', 'timeoutMs', 'user']);
    expect(req.user.map((c) => c.type)).toEqual(['image', 'image', 'text']);
    const text = (req.user[2] as { text: string }).text;
    expect(text).toContain('Photo 0 OCR text: KRISHNA');
    expect(text).toContain('Photo 1 OCR text: (none read)');
    expect(text).toContain('never copy it');
    expect(req.system).toBe(loadPrompt('vision-product').text);
  });
  it('repairs once when the descriptor carries label text, naming the tokens', async () => {
    const llm = fakeLLM([leaky, ok]);
    const r = await analyzeProduct(input, deps(llm));
    expect(r.repairs).toBe(1);
    expect(r.result.status).toBe('done');
    expect(llm.calls[1]!.idempotencyKey).toBe('k:repair1');
    expect((llm.calls[1]!.user.at(-1) as { text: string }).text).toContain('label text: "KRISHNA", "1925"');
  });
  it('fails non-retryable after one repair (exactly 2 calls)', async () => {
    const llm = fakeLLM([leaky, leaky]);
    const r = await analyzeProduct(input, deps(llm));
    expect(llm.calls).toHaveLength(2);
    expect(r.calls).toHaveLength(2);
    expect(r.result.status).toBe('failed');
    if (r.result.status === 'failed') {
      expect(r.result.retryable).toBe(false);
      expect(r.result.error.message).toMatch(/still invalid.*label text/);
    }
  });
  const lastText = (llm: ReturnType<typeof fakeLLM>, i: number) => (llm.calls[i]!.user.at(-1) as { text: string }).text;
  it('hands the model a descriptor with no word bound, so an overrun reaches the repair instead of failing the call', () => {
    const llm = fakeLLM([{ ...ok, descriptor: words(122) }, ok]);
    return analyzeProduct(input, deps(llm)).then(() => expect(llm.calls[0]!.schema.safeParse({ ...ok, descriptor: words(122) }).success).toBe(true));
  });
  it('repairs a 122-word descriptor on the second call, and returns the strictly parsed output', async () => {
    const llm = fakeLLM([{ ...ok, descriptor: words(122) }, ok]);
    const r = await analyzeProduct(input, deps(llm));
    expect(r.repairs).toBe(1);
    expect(lastText(llm, 1)).toContain('descriptor is 122 words, limit 40-120');
    expect(r.result.status === 'done' && r.result.value.value).toEqual(ok);
  });
  it('fails non-retryable when a 122-word descriptor repeats', async () => {
    const long = { ...ok, descriptor: words(122) };
    const llm = fakeLLM([long, long]);
    const r = await analyzeProduct(input, deps(llm));
    expect(llm.calls).toHaveLength(2);
    expect(r.result.status === 'failed' && r.result.retryable).toBe(false);
    expect(r.result.status === 'failed' && r.result.error.message).toMatch(/122 words/);
  });
  it('repairs a 35-word descriptor', async () => {
    const llm = fakeLLM([{ ...ok, descriptor: words(35) }, ok]);
    const r = await analyzeProduct(input, deps(llm));
    expect(r.repairs).toBe(1);
    expect(lastText(llm, 1)).toContain('descriptor is 35 words');
  });
  it('a combined over-length plus label-text output gets one repair naming both', async () => {
    const llm = fakeLLM([{ ...ok, descriptor: `${words(121)} KRISHNA` }, ok]);
    const r = await analyzeProduct(input, deps(llm));
    expect(llm.calls).toHaveLength(2);
    expect(r.repairs).toBe(1);
    expect(lastText(llm, 1)).toMatch(/122 words, limit 40-120; it contains label text: "KRISHNA"/);
  });
  it('passes a non-done generate result straight through with no repair', async () => {
    const llm = fakeLLM([failed('RATE_LIMIT')]);
    const r = await analyzeProduct(input, deps(llm));
    expect(llm.calls).toHaveLength(1);
    expect(r.repairs).toBe(0);
    expect(r.result.status).toBe('failed');
    if (r.result.status === 'failed') expect(r.result.error.code).toBe('RATE_LIMIT');
  });
  it('rejects an unsupported mime as INVALID_INPUT before calling the model', async () => {
    const llm = fakeLLM([ok]);
    const r = await analyzeProduct({ images: [{ ...ref('a'), mime: 'image/gif' }], ocr: [[]] }, deps(llm));
    expect(llm.calls).toHaveLength(0);
    expect(r.result.status === 'failed' && r.result.error.code).toBe('INVALID_INPUT');
  });
  it('renders OCR deterministically', () => expect(renderOcr([ocr('A', 'B')])).toContain('Photo 0 OCR text: A B'));
});

describe('analyzePlate', () => {
  it('rejects an unsupported mime as INVALID_INPUT', async () => {
    const llm = fakeLLM([plate]);
    const r = await analyzePlate({ image: { ...ref('p'), mime: 'image/tiff' } }, deps(llm));
    expect(llm.calls).toHaveLength(0);
    expect(r.status === 'failed' && r.error.code).toBe('INVALID_INPUT');
  });
  it('returns the parsed plate', async () => {
    const llm = fakeLLM([plate]);
    const r = await analyzePlate({ image: ref('p') }, deps(llm));
    expect(r.status).toBe('done');
    expect(llm.calls[0]!.system).toBe(loadPrompt('vision-plate').text);
  });
});
