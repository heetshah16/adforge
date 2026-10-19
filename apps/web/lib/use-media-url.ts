'use client';
import { useRef, useState } from 'react';

export const MAX_RETRIES = 3;
type El = HTMLMediaElement | HTMLImageElement;
export type MediaView = { src: string; failed: boolean };

export const retrySrc = (src: string, n: number) => `${src}${src.includes('?') ? '&' : '?'}r=${n}`;

/**
 * The refresh logic without React: on an error (a signed URL expiring mid-play) re-request the same /media/<key> with ?r=<n>,
 * then put the playhead back and resume if it was playing. After MAX_RETRIES it stops and reports failed.
 */
export function createMediaRefresh(base: string, onChange: (v: MediaView) => void) {
  let n = 0;
  let el: El | null = null;
  // One restore is ever pending: back-to-back errors must keep the ORIGINAL playhead, not the reset one.
  let pending: { at: number; wasPlaying: boolean } | null = null;
  return {
    ref(e: El | null) { el = e; },
    onError() {
      if (n >= MAX_RETRIES) return onChange({ src: retrySrc(base, n), failed: true });
      const media = el && 'currentTime' in el ? el : null;
      if (media && !pending) {
        pending = { at: media.currentTime, wasPlaying: !media.paused };
        media.addEventListener('loadedmetadata', () => {
          const p = pending!;
          pending = null;
          n = 0; // a successful load ends the incident; the retry cap is per incident
          media.currentTime = p.at;
          if (p.wasPlaying) void media.play().catch(() => {});
        }, { once: true });
      }
      n += 1;
      onChange({ src: retrySrc(base, n), failed: false });
    },
  };
}

export function useMediaUrl(src: string): { src: string; ref: (e: El | null) => void; onError: () => void; failed: boolean } {
  const [state, setState] = useState<{ base: string; v: MediaView } | null>(null);
  const holder = useRef<{ base: string; core: ReturnType<typeof createMediaRefresh> } | null>(null);
  if (holder.current?.base !== src) holder.current = { base: src, core: createMediaRefresh(src, (v) => setState({ base: src, v })) };
  const core = holder.current.core;
  const ref = core.ref;
  const v = state?.base === src ? state.v : { src, failed: false };
  return { src: v.src, ref, onError: core.onError, failed: v.failed };
}
