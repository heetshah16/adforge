import { z } from 'zod';

// Web-server env. Deliberately not @adforge/core/config/env: its REPO_ROOT depth check breaks under Next bundling.
const ServerEnv = z
  .object({
  NODE_ENV: z.string().optional(),
  // Unset: fail closed. A production build runs as prod; only a non-production NODE_ENV defaults to dev.
  ADFORGE_ENV: z.enum(['dev', 'prod']).optional(),
  ADFORGE_SITE_URL: z.url().optional(),
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
  NEXT_PUBLIC_SUPABASE_URL: z.url(),
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: z.string().min(1),
  SUPABASE_SECRET_KEY: z.string().min(1),
  ADFORGE_ADMIN_EMAILS: z
    .string()
    .default('')
    .transform((s) => s.split(',').map((e) => e.trim().toLowerCase()).filter(Boolean)),
  // Dev media on local disk; prod media on R2 (ADFORGE_PROVIDER_STORAGE=r2, same as the worker).
  ADFORGE_DATA_DIR: z.string().min(1).optional(), // required for the local profile only
  ADFORGE_PUBLIC_URL: z.url(),
  ADFORGE_PROVIDER_STORAGE: z.enum(['local', 'r2']).default('local'),
  R2_ACCOUNT_ID: z.string().min(1).optional(),
  R2_ACCESS_KEY_ID: z.string().min(1).optional(),
  R2_SECRET_ACCESS_KEY: z.string().min(1).optional(),
  R2_BUCKET: z.string().min(1).optional(),
  R2_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
  ADFORGE_MEDIA_TTL_SEC: z.coerce.number().int().min(60).max(3600).default(900),
  INNGEST_EVENT_KEY: z.string().min(1).optional(),
  INNGEST_SIGNING_KEY: z.string().min(1).optional(),
  INNGEST_DEV: z.string().min(1).optional(),
  })
  .transform((e, ctx) => {
    const ADFORGE_ENV = e.ADFORGE_ENV ?? (e.NODE_ENV === 'production' ? 'prod' : 'dev');
    if (ADFORGE_ENV === 'prod') {
      // INNGEST_SIGNING_KEY: serve() at /api/inngest verifies every call from Inngest with it (read by the SDK from process.env).
      const missing = (['ADFORGE_SITE_URL', 'INNGEST_EVENT_KEY', 'INNGEST_SIGNING_KEY'] as const).filter((k) => !e[k]);
      for (const k of missing) ctx.addIssue({ code: 'custom', path: [k], message: 'required when ADFORGE_ENV=prod' });
      if (missing.length) return z.NEVER;
      if (!e.ADFORGE_SITE_URL!.startsWith('https://')) {
        ctx.addIssue({ code: 'custom', path: ['ADFORGE_SITE_URL'], message: 'must be https when ADFORGE_ENV=prod' });
        return z.NEVER;
      }
    }
    if (ADFORGE_ENV === 'prod' && e.ADFORGE_PROVIDER_STORAGE !== 'r2') {
      ctx.addIssue({ code: 'custom', path: ['ADFORGE_PROVIDER_STORAGE'], message: 'must be r2 when ADFORGE_ENV=prod' });
      return z.NEVER;
    }
    if (e.ADFORGE_PROVIDER_STORAGE === 'local' && !e.ADFORGE_DATA_DIR) {
      ctx.addIssue({ code: 'custom', path: ['ADFORGE_DATA_DIR'], message: 'required when ADFORGE_PROVIDER_STORAGE=local' });
      return z.NEVER;
    }
    if (e.ADFORGE_PROVIDER_STORAGE === 'r2') {
      for (const k of ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET'] as const) {
        if (!e[k]) ctx.addIssue({ code: 'custom', path: [k], message: `${k} is required when ADFORGE_PROVIDER_STORAGE=r2` });
      }
      if (e.R2_ACCOUNT_ID && !/^[0-9a-f]{32}$/.test(e.R2_ACCOUNT_ID)) ctx.addIssue({ code: 'custom', path: ['R2_ACCOUNT_ID'], message: 'must be 32 lowercase hex chars' });
      if (e.R2_BUCKET && !/^[a-z0-9-]{3,63}$/.test(e.R2_BUCKET)) ctx.addIssue({ code: 'custom', path: ['R2_BUCKET'], message: 'must be 3-63 chars of a-z, 0-9, -' });
      if (!e.R2_ACCOUNT_ID || !e.R2_ACCESS_KEY_ID || !e.R2_SECRET_ACCESS_KEY || !e.R2_BUCKET) return z.NEVER;
    }
    return { ...e, ADFORGE_DATA_DIR: e.ADFORGE_DATA_DIR ?? '.adforge-data', ADFORGE_ENV, ADFORGE_SITE_URL: e.ADFORGE_SITE_URL ?? 'http://localhost:3000' };
  });
export type ServerEnv = z.infer<typeof ServerEnv>;

export function parseServerEnv(raw: Record<string, string | undefined>): ServerEnv {
  const r = ServerEnv.safeParse(raw);
  if (!r.success) throw new Error(`Invalid web server env: ${r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  return r.data;
}

let cached: ServerEnv | undefined;
export const serverEnv = (): ServerEnv => (cached ??= parseServerEnv(process.env));
