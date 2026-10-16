import type { Motion } from '@adforge/core/vocab/enums';

/**
 * GSAP source for one scene's motion. Applied to the stage wrapper, so the plate and the
 * real cutout move together. Finite and deterministic (no repeat:-1, no randomness).
 */
export function motionTween(target: string, motion: Motion, startSec: string, durationSec: string): string {
  const t = JSON.stringify(target);
  const base = `duration: ${durationSec}, ease: "none"`;
  switch (motion) {
    case 'static':
      return '';
    case 'slow_zoom_in':
      return `tl.fromTo(${t}, { scale: 1 }, { scale: 1.08, ${base} }, ${startSec});\n`;
    case 'slow_zoom_out':
      return `tl.fromTo(${t}, { scale: 1.08 }, { scale: 1, ${base} }, ${startSec});\n`;
    case 'slow_pan':
      return `tl.fromTo(${t}, { scale: 1.08, xPercent: -3 }, { scale: 1.08, xPercent: 3, ${base} }, ${startSec});\n`;
    case 'subtle_shake': {
      const step = 0.25;
      const repeats = Math.max(0, Math.floor(Number(durationSec) / step) - 1);
      return (
        `tl.set(${t}, { scale: 1.04 }, ${startSec});\n` +
        `tl.fromTo(${t}, { x: -4, y: 3 }, { x: 4, y: -3, duration: ${step}, ease: "sine.inOut", yoyo: true, repeat: ${repeats} }, ${startSec});\n`
      );
    }
  }
}
