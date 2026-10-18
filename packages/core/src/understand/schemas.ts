import { z } from 'zod';
import type { OcrItem } from '../providers/types';

const Angle = z.number().min(-180).max(180);
const Elevation = z.number().min(-90).max(90);
const Frac = z.number().min(0).max(1);
const Box = z.tuple([Frac, Frac, Frac, Frac]);

const words = (s: string) => s.trim().split(/\s+/).filter(Boolean).length;
const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();

/** Quoted spans in prose: "…", “…”, or '…' (apostrophes inside words are not quotes). */
const QUOTED = /"([^"]+)"|“([^”]+)”|(?<!\w)'([^']+)'(?!\w)/g;

/** Quoted strings in `descriptor` that the OCR did not return (case-insensitive). */
export function unreadQuotes(descriptor: string, ocr: OcrItem[][]): string[] {
  const haystack = norm(ocr.flat().map((o) => o.text).join(' '));
  return [...descriptor.matchAll(QUOTED)]
    .map((m) => (m[1] ?? m[2] ?? m[3])!)
    .filter((q) => !haystack.includes(norm(q)));
}

export const ProductAnalysis = z.object({
  shapeClass: z.enum(['bottle', 'jar', 'pouch', 'box', 'tube', 'can', 'sachet', 'other']),
  viewpoint: z.object({ azimuthDeg: Angle, elevationDeg: Elevation }),
  lightDirection: z.object({ azimuthDeg: Angle, elevationDeg: Elevation }).nullable(),
  palette: z.array(z.string().regex(/^#[0-9a-fA-F]{6}$/)).min(1).max(6),
  material: z.string().max(40),
  finish: z.enum(['matte', 'gloss', 'metallic', 'translucent', 'mixed']),
  visibleFaces: z.array(z.enum(['front', 'back', 'left', 'right', 'top', 'bottom'])).min(1),
  descriptor: z.string().refine((d) => words(d) >= 40 && words(d) <= 120, 'descriptor must be 40-120 words'),
  bestPhotoIndex: z.number().int().min(0),
});
export type ProductAnalysis = z.infer<typeof ProductAnalysis>;

/** The same schema plus the label-text guard, built per call from that call's OCR. */
export const productAnalysisFor = (ocr: OcrItem[][]) =>
  ProductAnalysis.refine((a) => unreadQuotes(a.descriptor, ocr).length === 0, {
    path: ['descriptor'],
    message: 'descriptor quotes label text that OCR did not return',
  });

export const PlateAnalysis = z.object({
  cameraHeight: z.enum(['ground', 'table', 'eye', 'high', 'overhead']),
  tiltDeg: z.number().min(-90).max(90),
  horizonY: Frac.nullable(),
  supportSurface: z.object({ box: Box }).nullable(),
  light: z.object({ azimuthDeg: Angle, colorTempK: z.number().min(1500).max(10000) }),
  freeZones: z.array(Box).max(4),
});
export type PlateAnalysis = z.infer<typeof PlateAnalysis>;
