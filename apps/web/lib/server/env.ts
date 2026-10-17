import { z } from 'zod';

// Web-server env. Deliberately not @adforge/core/config/env: its REPO_ROOT depth check breaks under Next bundling.
const ServerEnv = z.object({
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
  NEXT_PUBLIC_SUPABASE_URL: z.url(),
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: z.string().min(1),
  SUPABASE_SECRET_KEY: z.string().min(1),
  ADFORGE_ADMIN_EMAILS: z
    .string()
    .default('')
    .transform((s) => s.split(',').map((e) => e.trim().toLowerCase()).filter(Boolean)),
  // Dev media until B3.
  ADFORGE_DATA_DIR: z.string().min(1),
  ADFORGE_PUBLIC_URL: z.url(),
  INNGEST_EVENT_KEY: z.string().min(1).optional(),
  INNGEST_DEV: z.string().min(1).optional(),
});
export type ServerEnv = z.infer<typeof ServerEnv>;

export function parseServerEnv(raw: Record<string, string | undefined>): ServerEnv {
  const r = ServerEnv.safeParse(raw);
  if (!r.success) throw new Error(`Invalid web server env: ${r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  return r.data;
}

let cached: ServerEnv | undefined;
export const serverEnv = (): ServerEnv => (cached ??= parseServerEnv(process.env));
