import { queueStatus, type QueueStatus } from '@adforge/pipeline/queue';
import { getDb } from './db';

/** Owner-side queue position/ETA. Call only after the caller's RLS read confirmed the job is theirs; returns no ids. */
export async function queueStatusOwner(jobId: string): Promise<QueueStatus> {
  return queueStatus(await getDb(), jobId);
}
