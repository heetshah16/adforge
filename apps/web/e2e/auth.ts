import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';
import { expect, type Page } from '@playwright/test';

// Secrets stay in apps/web/.env.local; this helper never logs them.
try { process.loadEnvFile(fileURLToPath(new URL('../.env.local', import.meta.url))); } catch { /* CI supplies real env */ }

export const adminEmail = (process.env.ADFORGE_ADMIN_EMAILS ?? '').split(',')[0]!.trim().toLowerCase();

export const supabaseAdmin = () =>
  createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SECRET_KEY!, { auth: { persistSession: false, autoRefreshToken: false } });

/** Sign in without an inbox: admin-generated magic link -> /auth/confirm (verifyOtp) -> session cookie on this page's context. */
export async function signIn(page: Page, email: string): Promise<void> {
  const { data, error } = await supabaseAdmin().auth.admin.generateLink({ type: 'magiclink', email });
  if (error) throw new Error(`generateLink failed: ${error.message}`);
  await page.goto(`/auth/confirm?token_hash=${encodeURIComponent(data.properties.hashed_token)}&type=email`);
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
}

/** Provisioning (users row, org, membership) happens on the first authenticated API/page call; any gated route will do. */
export async function provision(page: Page): Promise<void> {
  expect((await page.request.get('/api/jobs/00000000-0000-4000-8000-000000000000')).status()).toBe(404);
}
