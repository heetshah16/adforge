import { z } from 'zod';

const Angle = z.number().min(-180).max(180);
const Elevation = z.number().min(-90).max(90);
const Frac = z.number().min(0).max(1);
const Box = z.tuple([Frac, Frac, Frac, Frac]).refine(([x, y, w, h]) => x + w <= 1 + 1e-6 && y + h <= 1 + 1e-6, 'box must stay inside the image (x+w<=1, y+h<=1)');

export const wordCount = (s: string) => s.trim().split(/\s+/).filter(Boolean).length;

/** Quoted spans in prose: "…", “…”, or '…' (apostrophes inside words are not quotes). */
const QUOTED = /"([^"]+)"|“([^”]+)”|(?<!\w)'([^']+)'(?!\w)/g;
/** All-caps Latin tokens of 3+ letters (brand/label words); 2-letter units like ML and KG fall below the bar, so no allowlist. */
const CAPS = /\b[A-Z]{3,}\b/g;
/** Digit runs of 3+ (ASCII or Devanagari): years, weights, codes. */
const DIGITS = /[0-9०-९]{3,}/g;

/** Label text that leaked into a descriptor: quoted strings, ALL-CAPS words, long digit runs. Label text lives in OCR metadata only. */
export function labelTextViolations(descriptor: string): string[] {
  const quoted = [...descriptor.matchAll(QUOTED)].map((m) => (m[1] ?? m[2] ?? m[3])!);
  return [...quoted, ...(descriptor.match(CAPS) ?? []), ...(descriptor.match(DIGITS) ?? [])];
}

export const ProductAnalysis = z.object({
  shapeClass: z.enum(['bottle', 'jar', 'pouch', 'box', 'tube', 'can', 'sachet', 'other']),
  viewpoint: z.object({ azimuthDeg: Angle, elevationDeg: Elevation }),
  lightDirection: z.object({ azimuthDeg: Angle, elevationDeg: Elevation }).nullable(),
  palette: z.array(z.string().regex(/^#[0-9a-fA-F]{6}$/)).min(1).max(6),
  material: z.string().max(40),
  finish: z.enum(['matte', 'gloss', 'metallic', 'translucent', 'mixed']),
  visibleFaces: z.array(z.enum(['front', 'back', 'left', 'right', 'top', 'bottom'])).min(1),
  descriptor: z.string().refine((d) => wordCount(d) >= 40 && wordCount(d) <= 120, 'descriptor must be 40-120 words'),
  bestPhotoIndex: z.number().int().min(0),
});
export type ProductAnalysis = z.infer<typeof ProductAnalysis>;
/** What the model is asked for: descriptor length is checked (and repaired) in code, not by the provider call. */
export const ProductAnalysisModel = ProductAnalysis.extend({ descriptor: z.string() });

export const PlateAnalysis = z.object({
  cameraHeight: z.enum(['ground', 'table', 'eye', 'high', 'overhead']),
  tiltDeg: z.number().min(-90).max(90),
  horizonY: Frac.nullable(),
  supportSurface: z.object({ box: Box }).nullable(),
  light: z.object({ azimuthDeg: Angle, colorTempK: z.number().min(1500).max(10000) }),
  freeZones: z.array(Box).max(4),
});
export type PlateAnalysis = z.infer<typeof PlateAnalysis>;
