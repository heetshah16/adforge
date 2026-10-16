import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { checkVariant } from '../src/llm/rules';
import { directorOutput, type DirectorVariant } from '../src/llm/schemas';
import { ttsText } from '../src/llm/tts-text';
import { loadPrompt } from '../src/llm/prompts';
import { shortlist } from '../src/vocab/shortlist';
import { REGISTRY } from './vocab-fixture';

const base = (): DirectorVariant => {
  const t = loadPrompt('director').text;
  return structuredClone((JSON.parse(t.slice(t.indexOf('```json') + 7, t.lastIndexOf('```'))) as { variants: DirectorVariant[] }).variants[0]!);
};
const ctx = (language: 'en' | 'hi' | 'hinglish') => ({ registry: REGISTRY, brandName: 'Sattvik', language });
const msgs = (v: DirectorVariant, l: 'en' | 'hi' | 'hinglish') => checkVariant(v, ctx(l)).filter((x) => x.message.includes('vo_tts'));
const hing = (tts?: string) => {
  const v = base();
  v.language = 'hinglish';
  v.scenes.forEach((s, i) => { if (tts !== undefined) s.vo_tts = i === 1 ? 'यह एक बिल्कुल सही लाइन है' : tts; });
  return v;
};

describe('vo_tts rules', () => {
  it('hinglish without vo_tts is a violation naming the scene', () => {
    const m = msgs(hing(), 'hinglish');
    expect(m).toHaveLength(base().scenes.length);
    expect(m[0]!.message).toContain('scene 1');
  });
  it('hinglish with Latin vo_tts is a violation', () => {
    const m = msgs(hing('bilkul sahi line hai'), 'hinglish');
    expect(m.map((x) => x.message).join()).toContain('scene 1');
    expect(m.map((x) => x.message).join()).not.toContain('scene 2');
  });
  it('hinglish with Devanagari vo_tts passes', () => {
    expect(msgs(hing('यह एक बिल्कुल सही लाइन है'), 'hinglish')).toEqual([]);
  });
  it('en with vo_tts is a violation', () => {
    const v = base();
    v.scenes[0]!.vo_tts = 'कुकिंग ऑयल';
    expect(msgs(v, 'en')).toHaveLength(1);
  });
});

describe('ttsText', () => {
  const s = { ...base().scenes[0]!, vo_tts: 'कुकिंग ऑयल' };
  it('picks the right line per language', () => {
    expect(ttsText(s, 'hinglish')).toBe('कुकिंग ऑयल');
    expect(ttsText(s, 'en')).toBe(s.vo);
    expect(ttsText(s, 'hi')).toBe(s.vo);
  });
  it('throws for hinglish without vo_tts', () => {
    const { vo_tts: _, ...rest } = s;
    expect(() => ttsText(rest, 'hinglish')).toThrow();
  });
});

describe('directorOutput JSON schema', () => {
  it('converts to draft-7 with vo_tts optional', () => {
    const sl = { formats: [{ slug: 'f1' }], hooks: [{ slug: 'h1' }] } as unknown as ReturnType<typeof shortlist>;
    const js = z.toJSONSchema(directorOutput(sl), { target: 'draft-7' }) as any;
    const scene = js.properties.variants.items.properties.scenes.items;
    expect(scene.properties.vo_tts).toBeDefined();
    expect(scene.required).not.toContain('vo_tts');
  });
});
