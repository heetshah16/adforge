import type { AlignedWord } from '../providers/types';

const norm = (s: string) => s.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
const MIN_WORD = 0.05;

function proportional(tokens: string[], from: number, to: number): AlignedWord[] {
  const weights = tokens.map((t) => Math.max(1, [...t].length));
  const total = weights.reduce((a, b) => a + b, 0);
  let t = from;
  return tokens.map((text, i) => {
    const startSec = t;
    t += ((to - from) * weights[i]!) / total;
    return { text, startSec, endSec: t };
  });
}

/** Captions show the SCRIPT's words; Whisper only supplies the timing. Pure and deterministic. */
export function alignScript(script: string, asr: AlignedWord[], durationSec: number): AlignedWord[] {
  const tokens = script.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return [];

  let out: AlignedWord[];
  if (asr.length === 0) {
    out = proportional(tokens, 0, durationSec);
  } else {
    const timing: ({ startSec: number; endSec: number } | null)[] = tokens.map(() => null);
    let j = 0;
    for (let i = 0; i < tokens.length && j < asr.length; i++) {
      const target = norm(tokens[i]!);
      for (let k = j; k < Math.min(asr.length, j + 4); k++) {
        if (target && norm(asr[k]!.text) === target) {
          timing[i] = { startSec: asr[k]!.startSec, endSec: asr[k]!.endSec };
          j = k + 1;
          break;
        }
      }
    }
    const matched = timing.filter(Boolean).length;
    if (matched / tokens.length >= 0.5) {
      out = [];
      for (let i = 0; i < tokens.length; ) {
        if (timing[i]) {
          out.push({ text: tokens[i]!, ...timing[i]! });
          i++;
          continue;
        }
        let end = i;
        while (end < tokens.length && !timing[end]) end++;
        const from = out.at(-1)?.endSec ?? 0;
        const to = end < tokens.length ? timing[end]!.startSec : durationSec;
        out.push(...proportional(tokens.slice(i, end), from, Math.max(from, to)));
        i = end;
      }
    } else {
      out = proportional(tokens, asr[0]!.startSec, asr.at(-1)!.endSec);
    }
  }

  // Clamp to the clip and enforce monotonic, non-empty words.
  let prev = 0;
  return out.map((x) => {
    const startSec = Math.min(Math.max(x.startSec, prev), Math.max(0, durationSec - MIN_WORD));
    const endSec = Math.min(durationSec, Math.max(x.endSec, startSec + MIN_WORD));
    prev = endSec;
    return { text: x.text, startSec, endSec };
  });
}
