'use client';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

export function InviteButton({ waitlistId }: { waitlistId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function invite() {
    setBusy(true);
    setError('');
    try {
      const res = await fetch('/api/admin/invite', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ waitlistId }),
      });
      if (!res.ok) setError(`Failed (${res.status})`);
      else if ((await res.json().catch(() => ({}))).emailSent === false) setError('Invited, but the email was not sent: tell them to use Continue with Discord.');
      else router.refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <button onClick={invite} disabled={busy}>{busy ? 'Inviting...' : 'Invite'}</button>
      {error && <span role="alert"> {error}</span>}
    </>
  );
}
