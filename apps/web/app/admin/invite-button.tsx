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
      if (res.ok) router.refresh();
      else setError(`Failed (${res.status})`);
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
