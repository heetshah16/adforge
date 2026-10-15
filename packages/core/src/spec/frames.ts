/** The only place seconds become frames. Everything downstream is integer frames. */
export function secondsToFrames(seconds: number, fps: number): number {
  if (!Number.isFinite(seconds) || seconds < 0) {
    throw new RangeError(`seconds must be a finite non-negative number, got ${seconds}`);
  }
  return Math.round(seconds * fps);
}

/**
 * Lays out consecutive segments from cumulative time, so start frames are exact
 * rounded cumulative sums and the total never drifts from round(sum * fps).
 */
export function layoutFrames(
  durationsSec: number[],
  fps: number,
): { startFrame: number; durationInFrames: number }[] {
  let elapsedSec = 0;
  return durationsSec.map((d) => {
    const startFrame = secondsToFrames(elapsedSec, fps);
    elapsedSec += d;
    return { startFrame, durationInFrames: secondsToFrames(elapsedSec, fps) - startFrame };
  });
}
