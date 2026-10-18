import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';
import { serverEnv } from '../server/env';

/** Supabase client for Server Components / actions / route handlers. Cookie writes from a Server Component are a no-op: proxy.ts refreshes the session. */
export async function createSupabaseServer() {
  const jar = await cookies();
  const env = serverEnv();
  return createServerClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, {
    cookies: {
      getAll: () => jar.getAll(),
      setAll(list) {
        try {
          for (const { name, value, options } of list) jar.set(name, value, options);
        } catch {
          // Server Component: read-only cookies.
        }
      },
    },
  });
}
