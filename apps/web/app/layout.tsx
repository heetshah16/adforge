import './globals.css';
import type { ReactNode } from 'react';

export const metadata = { title: 'AdForge', description: 'Three structurally different ad variants per product.' };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <header className="top"><a href="/">AdForge</a><form action="/auth/signout" method="post" style={{ float: 'right' }}><button type="submit">Sign out</button></form></header>
        <main>{children}</main>
      </body>
    </html>
  );
}
