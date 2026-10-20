'use client';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useMediaUrl } from '@/lib/use-media-url';
import { approveVariant, getJob, type JobView } from '@/lib/api';
import { VariantPreview } from './preview';
import { briefSummary, failMessage, isTerminal, jobWarnings, nextPollDelay, stageRows, variantCards } from '@/lib/view';

function VariantVideo({ src, label }: { src: string; label: string }) {
  const m = useMediaUrl(src);
  if (m.failed) return <p className="errors">Video unavailable. Reload the page to try again.</p>;
  return <video ref={m.ref} src={m.src} onError={m.onError} controls playsInline preload="metadata" aria-label={label} />;
}

export default function JobPage() {
  const { id } = useParams<{ id: string }>();
  const [view, setView] = useState<JobView | null>(null);
  const [offline, setOffline] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const errors = useRef(0);
  const seq = useRef(0);

  const load = useCallback(async () => {
    const n = ++seq.current;
    try {
      const v = await getJob(id);
      if (n !== seq.current) return v; // a newer request started; drop this stale response
      setView(v);
      setOffline(false);
      errors.current = 0;
      return v;
    } catch {
      if (n !== seq.current) return null;
      setOffline(true);
      errors.current += 1;
      return null;
    }
  }, [id]);

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      const v = await load();
      if (!alive) return;
      if (v && isTerminal(v.job.status)) return; // stop polling
      timer = setTimeout(tick, nextPollDelay(errors.current));
    };
    void tick();
    return () => { alive = false; if (timer) clearTimeout(timer); };
  }, [load]);

  async function approve(n: number) {
    try {
      await approveVariant(id, n);
      setNotice(`Variant ${n} approved.`);
      await load();
    } catch (e) {
      setNotice((e as Error).message);
    }
  }

  if (!view) return <p>{offline ? 'Server unreachable, retrying…' : 'Loading…'}</p>;
  const brief = briefSummary(view.job.brief);
  const done = isTerminal(view.job.status);

  return (
    <>
      {offline && <div className="banner" role="status">Server unreachable, retrying — showing the last known state.</div>}
      <h1>Job <span className="muted">{view.job.status}</span></h1>
      {brief && (
        <section>
          <h2>Strategist read</h2>
          <p><strong>{brief.archetypes}</strong> — {brief.rationale}</p>
          {brief.objection && <p className="muted">Core objection: {brief.objection}</p>}
        </section>
      )}
      {!done && (
        <ol className="stages" aria-live="off">
          {stageRows(view.job.progress).map((r) => (
            <li key={r.stage} data-status={r.status}>{r.label} — {r.status}{r.detail ? ` (${r.detail})` : ''}</li>
          ))}
        </ol>
      )}
      {view.job.status === 'failed' && <p className="errors">{failMessage(view.job)}</p>}
      {jobWarnings(view).length > 0 && <ul className="muted">{jobWarnings(view).map((w) => <li key={w}>{w}</li>)}</ul>}
      {notice && <p role="status">{notice}</p>}
      {view.variants.length > 0 && (
        <section className="grid" aria-label="Variants">
          {variantCards(view).map((c) => (
            <article key={c.variantNo} className="card" data-status={c.status}>
              <h3>V{c.variantNo}: {c.title}</h3>
              <p className="muted">{c.families}</p>
              {c.videoUrl ? <VariantVideo src={c.videoUrl} label={`Variant ${c.variantNo} video`} /> : <p className="errors">{c.failureReason ?? c.placeholder ?? 'Rendering…'}</p>}
              {c.preview && (
                <details>
                  <summary>Composition preview{c.preview.locked ? '' : ' (unlocked)'}</summary>
                  <VariantPreview revisionId={c.preview.id} spec={c.preview.spec} assetUrls={c.preview.assetUrls} label={`Variant ${c.variantNo} composition preview`} />
                </details>
              )}
              <p><strong>Bet:</strong> {c.bet}</p>
              <div style={{ display: 'flex', gap: 8 }}>
                <button type="button" disabled={!c.canApprove} onClick={() => approve(c.variantNo)}>{c.status === 'approved' ? 'Approved' : 'Approve'}</button>
                {c.videoUrl && <a href={`${c.videoUrl}?download=1`}>Download</a>}
              </div>
            </article>
          ))}
        </section>
      )}
    </>
  );
}
