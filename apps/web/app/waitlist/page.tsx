'use client';
import { useEffect, useRef, useState, type FormEvent } from 'react';

export default function WaitlistPage() {
  // Set after mount, not during render, so server and client markup match.
  const startedAt = useRef(0);
  const [errors, setErrors] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  useEffect(() => { startedAt.current = Date.now(); }, []);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const field = (k: string) => String(form.get(k) ?? '').trim();
    const optional = (k: string) => field(k) || undefined;
    setBusy(true);
    setErrors([]);
    try {
      const res = await fetch('/api/waitlist', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: field('name'), email: field('email'), brand: field('brand'), category: field('category'), country: field('country'),
          website: optional('website'), note: optional('note'), company_url: field('company_url'), startedAt: startedAt.current,
        }),
        signal: AbortSignal.timeout(10_000),
      });
      if (res.ok) return setDone(true);
      const body = (await res.json().catch(() => ({}))) as { error?: string; issues?: Record<string, string[]> };
      setErrors([body.error ?? `Could not join the list (HTTP ${res.status}).`, ...Object.values(body.issues ?? {}).flat()]);
    } catch (err) {
      setErrors([`Could not reach the server: ${(err as Error).message}`]);
    } finally {
      setBusy(false);
    }
  }

  if (done) return (<><h1>You&apos;re on the list</h1><p>Thanks. We&apos;ll email you when your invite is ready.</p></>);

  return (
    <>
      <h1>Join the waitlist</h1>
      <p className="muted">AdForge is invite-only for now. Tell us about your brand and we&apos;ll send an invite when a seat opens.</p>
      <form onSubmit={onSubmit} noValidate>
        <label>Your name<input name="name" required maxLength={120} autoComplete="name" /></label>
        <label>Email<input name="email" type="email" required maxLength={254} autoComplete="email" /></label>
        <label>Brand<input name="brand" required maxLength={120} /></label>
        <label>Website (optional)<input name="website" type="url" maxLength={300} placeholder="https://" /></label>
        <label>Category<input name="category" required maxLength={80} placeholder="Skincare, apparel, food…" /></label>
        <label>Country<input name="country" required maxLength={80} /></label>
        <label>Anything else (optional)<textarea name="note" rows={3} maxLength={1000} /></label>
        {/* Honeypot: hidden from people and password managers; bots that fill it get a silent success. */}
        <input name="company_url" tabIndex={-1} autoComplete="off" aria-hidden="true" style={{ position: 'absolute', left: -10000, width: 1, height: 1, overflow: 'hidden' }} />
        {errors.length > 0 && <ul className="errors" role="alert">{errors.map((x, i) => <li key={`${i}-${x}`}>{x}</li>)}</ul>}
        <button type="submit" disabled={busy}>{busy ? 'Sending…' : 'Join the waitlist'}</button>
      </form>
    </>
  );
}
