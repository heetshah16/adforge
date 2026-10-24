'use client';
import { useEffect, useRef, useState } from 'react';
import type { VideoSpec } from '@adforge/core/spec/video-spec';
import { assetUrlOf, PREVIEW_RUNTIME_SRC, previewFrame, previewHtml } from '@/lib/preview';

/** The e2e's deterministic seek: `document.querySelector('[data-preview]').seekToFrame(n)` pauses and shows frame n (queued until ready). */
export type PreviewHost = HTMLDivElement & { seekToFrame(frame: number): void };
type Player = HTMLElement & { pause(): void; seek(s: number): void };

/**
 * Display-only HyperFrames preview of a ready revision (play/pause + scrubber from the player's own controls). Editing UI is C7.
 * A revision's spec is immutable, so the player is keyed on revisionId alone: a view refresh (poll, approve) hands over fresh
 * spec/assetUrls objects and must not remount it. `data-ready` is set on the host once the player fires `ready`.
 */
export function VariantPreview({ revisionId, spec, assetUrls, label }: { revisionId: string; spec: VideoSpec; assetUrls: Record<string, string>; label: string }) {
  const host = useRef<HTMLDivElement>(null);
  const latest = useRef({ spec, assetUrls });
  latest.current = { spec, assetUrls };
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const el = host.current as PreviewHost | null;
    if (!el) return;
    const { spec: s, assetUrls: urls } = latest.current;
    el.removeAttribute('data-ready'); // before any early return: a failed revision must never look ready to the e2e
    let html: string;
    try {
      html = previewHtml(s, (k) => assetUrlOf(urls, k));
    } catch (e) {
      setError((e as Error).message);
      return;
    }
    setError(null);
    let cancelled = false;
    let player: Player | undefined;
    let ready = false;
    let queued: number | undefined;
    const seek = (frame: number) => { player!.pause(); player!.seek(previewFrame(frame, s.fps)); };
    el.seekToFrame = (frame) => {
      if (ready) seek(frame);
      else queued = frame;
    };
    // Registers the <hyperframes-player> custom element; browser-only, so never at module load (SSR).
    void import('@hyperframes/player').then(() => {
      if (cancelled) return;
      player = document.createElement('hyperframes-player') as Player;
      player.setAttribute('runtime-src', new URL(PREVIEW_RUNTIME_SRC, location.origin).href);
      player.setAttribute('width', String(s.width));
      player.setAttribute('height', String(s.height));
      player.setAttribute('controls', '');
      player.setAttribute('srcdoc', html);
      player.addEventListener('ready', () => {
        ready = true;
        if (queued !== undefined) seek(queued);
        el.setAttribute('data-ready', '');
      });
      el.append(player);
    });
    return () => { cancelled = true; player?.remove(); };
  }, [revisionId]);
  // The host div stays mounted while an error shows: unmounting it would leave host.current null, so the effect for the next revision could never clear the error.
  return (
    <>
      {error && <p className="errors" role="alert">Preview unavailable: {error}</p>}
      <div ref={host} data-preview="" aria-label={label} hidden={!!error} style={{ aspectRatio: `${spec.width} / ${spec.height}`, maxWidth: 270 }} />
    </>
  );
}
