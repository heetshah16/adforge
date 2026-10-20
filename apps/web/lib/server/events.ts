import { Inngest } from 'inngest';
import { serverEnv } from './env';

// Same app id and event name as packages/pipeline (not imported: that drags the whole pipeline into Next). INNGEST_DEV / INNGEST_BASE_URL are read by the SDK from the environment.
let client: Inngest | undefined;

const inngest = () => {
  const env = serverEnv();
  return (client ??= new Inngest({ id: 'adforge', isDev: env.ADFORGE_ENV === 'dev', ...(env.INNGEST_EVENT_KEY ? { eventKey: env.INNGEST_EVENT_KEY } : {}) }));
};

/** Same name as EVENTS.variantEdit in packages/pipeline; the executor (C2 Task 4) consumes it. Deduped on the revision id. */
export async function sendVariantEdit(revisionId: string): Promise<void> {
  await inngest().send({ name: 'adforge/variant.edit', data: { revisionId }, id: revisionId });
}

/** Dedupes on the job id, like the worker's dev route. Throws if the event can't be queued. */
export async function sendJobRequested(jobId: string): Promise<void> {
  await inngest().send({ name: 'adforge/job.requested', data: { jobId }, id: jobId });
}
