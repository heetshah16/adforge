import './globals.css';
import type { ReactNode } from 'react';
import { createSupabaseServer } from '../lib/supabase/server';

export const metadata = { title: 'AdForge', description: 'Three structurally different ad variants per product.' };

export default async function RootLayout({ children }: { children: ReactNode }) {
  // Cheap: verifies the JWT only (no provisioning, no DB). Any failure just hides the button.
  const signedIn = await (await createSupabaseServer()).auth.getClaims().then((r) => Boolean(r.data?.claims?.sub), () => false);
  return (
    <html lang="en">
      <body>
        <header className="top">
          <a href="/">AdForge</a>
          {signedIn && <form action="/auth/signout" method="post" style={{ float: 'right' }}><button type="submit">Sign out</button></form>}
        </header>
        <main>{children}</main>
      </body>
    </html>
  );
}
