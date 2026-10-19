import { z } from 'zod';

export const R2Config = z.object({
  accountId: z.string().regex(/^[0-9a-f]{32}$/),
  accessKeyId: z.string().min(1),
  secretAccessKey: z.string().min(1),
  bucket: z.string().regex(/^[a-z0-9-]{3,63}$/),
  /** Origin of our own app: MediaRef URLs are `${publicUrl}/media/<key>`, never an R2 hostname. */
  publicUrl: z.url(),
  timeoutMs: z.number().int().positive().default(30_000),
});
export type R2Config = z.infer<typeof R2Config>;
