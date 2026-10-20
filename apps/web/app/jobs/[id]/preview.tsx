'use client';
import { useEffect, useMemo, useRef } from 'react';
import type { VideoSpec } from '@adforge/core/spec/video-spec';
import { PREVIEW_RUNTIME_SRC, previewFrame, previewHtml } from '@/lib/preview';

/** The e2e's deterministic seek: `document.querySelector('[data-preview]').seekToFrame(n)` pauses and shows frame n. */
export type PreviewHost = HTMLDivElement & { seekToFrame(frame: number): void };

/** Display-only HyperFrames preview of a ready revision (play/pause + scrubber from the player's own controls). Editing UI is C7. */
export function VariantPreview({ spec, assetUrls, label }: { spec: VideoSpec; assetUrls: Record<string, string>; label: string }) {
  const host = useRef<HTMLDivElement>(null);
  const html = useMemo(() => previewHtml(spec, (k) => assetUrls[k] ?? k), [spec, assetUrls]);
  useEffect(() => {
    const el = host.current as PreviewHost | null;
    if (!el) return;
    let cancelled = false;
    let player: HTMLElement | undefined;
    // Registers the <hyperframes-player> custom element; browser-only, so never at module load (SSR).
    void import('@hyperframes/player').then(() => {
      if (cancelled) return;
      player = document.createElement('hyperframes-player');
      player.setAttribute('runtime-src', new URL(PREVIEW_RUNTIME_SRC, location.origin).href);
      player.setAttribute('width', String(spec.width));
      player.setAttribute('height', String(spec.height));
      player.setAttribute('controls', '');
      player.setAttribute('srcdoc', html);
      el.append(player);
    });
    el.seekToFrame = (frame) => {
      const p = player as (HTMLElement & { pause(): void; seek(s: number): void }) | undefined;
      p?.pause();
      p?.seek(previewFrame(frame, spec.fps));
    };
    return () => { cancelled = true; player?.remove(); };
  }, [html, spec.width, spec.height, spec.fps]);
  return <div ref={host} data-preview="" aria-label={label} style={{ aspectRatio: `${spec.width} / ${spec.height}`, maxWidth: 270 }} />;
}
