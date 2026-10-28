import { Inngest } from 'inngest';
import { DISPATCH_NUDGE } from '@adforge/pipeline/dispatch';
import { serverEnv } from './env';

// The adforge-web app (served at /api/inngest: dispatcher + janitor). The GPU worker is the separate adforge-gpu app; events
// are env-wide, so the edit/export events below reach its functions. Not @adforge/pipeline/inngest: that drags the whole
// pipeline into Next. INNGEST_DEV / INNGEST_BASE_URL / INNGEST_SIGNING_KEY are read by the SDK from the environment.
let client: Inngest | undefined;

export const inngest = () => {
  const env = serverEnv();
  return (client ??= new Inngest({ id: 'adforge-web', isDev: env.ADFORGE_ENV === 'dev', ...(env.INNGEST_EVENT_KEY ? { eventKey: env.INNGEST_EVENT_KEY } : {}) }));
};

/** Same name as EVENTS.variantEdit in packages/pipeline; the executor (C2 Task 4) consumes it. Deduped on the revision id. Interactive: ahead of queued jobs on the heavy lane. */
export async function sendVariantEdit(revisionId: string): Promise<void> {
  await inngest().send({ name: 'adforge/variant.edit', data: { revisionId, priority: 'interactive' }, id: revisionId });
}

/** Same name as EVENTS.variantExport in packages/pipeline. Not event-id deduped: the worker skips a revision that already has a render. */
export async function sendVariantExport(revisionId: string): Promise<void> {
  await inngest().send({ name: 'adforge/variant.export', data: { revisionId, priority: 'interactive' } });
}

/** Wakes the dispatcher now instead of at its next cron minute. The dispatcher, not the web, sends job.requested. */
export async function sendDispatchNudge(): Promise<void> {
  await inngest().send({ name: DISPATCH_NUDGE, data: {} });
}
