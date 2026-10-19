'use client';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { createJob } from '@/lib/api';
import { validateUpload } from '@/lib/view';

export default function UploadPage() {
  const router = useRouter();
  const [errors, setErrors] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const files = form.getAll('photos').filter((f): f is File => f instanceof File && f.size > 0);
    const problems = validateUpload({
      name: String(form.get('name') ?? ''), price: String(form.get('price') ?? ''), description: String(form.get('description') ?? ''),
      language: String(form.get('language') ?? ''), files,
    });
    setErrors(problems);
    if (problems.length) return;
    setBusy(true);
    try {
      const r = await createJob(form);
      if (r.ok) router.push(`/jobs/${r.jobId}`);
      else setErrors([r.error, ...Object.values(r.issues ?? {}).flat()]);
    } catch (err) {
      setErrors([`Could not reach the server: ${(err as Error).message}`]);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <h1>New product</h1>
      <p className="muted">Upload 3–5 photos. AdForge reads the buying psychology and makes three structurally different ads.</p>
      <form onSubmit={onSubmit} noValidate>
        <label>Product name<input name="name" required maxLength={120} /></label>
        <label>Brand (optional, the hook must not name it)<input name="brand" maxLength={60} placeholder="Acme" /></label>
        <label>Price<input name="price" required maxLength={40} placeholder="₹899" /></label>
        <label>Description<textarea name="description" required rows={4} maxLength={2000} /></label>
        <label>Voice-over language
          <select name="language" defaultValue="en">
            <option value="en">English</option>
            <option value="hi">Hindi (Devanagari)</option>
            <option value="hinglish">Hinglish</option>
          </select>
        </label>
        <label>Photos (3–5, PNG/JPEG/WebP, ≤ 10 MB each)<input name="photos" type="file" accept="image/png,image/jpeg,image/webp" multiple required /></label>
        <label style={{ display: 'flex', gap: 8, fontWeight: 400 }}><input name="broll" type="checkbox" /> Add AI b-roll (≈ +14 min)</label>
        {errors.length > 0 && <ul className="errors" role="alert">{errors.map((x, i) => <li key={`${i}-${x}`}>{x}</li>)}</ul>}
        <button type="submit" disabled={busy}>{busy ? 'Uploading…' : 'Make three ads'}</button>
      </form>
    </>
  );
}
