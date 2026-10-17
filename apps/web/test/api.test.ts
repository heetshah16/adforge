import { describe, expect, it } from 'vitest';
import { approveVariant, createJob, getJob } from '../lib/api';

const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
const VIEW = {
  job: { id: 'j1', status: 'running', progress: [], brief: null, error: null, costUsd: 0, createdAt: '2026-10-16T00:00:00Z', completedAt: null },
  variants: [],
};

describe('worker client', () => {
  it('returns the job id on 202 and the issues on 400', async () => {
    expect(await createJob(new FormData(), (async () => json({ jobId: 'j1' }, 202)) as typeof fetch)).toEqual({ ok: true, jobId: 'j1' });
    expect(await createJob(new FormData(), (async () => json({ error: 'invalid fields', issues: { name: ['name is required'] } }, 400)) as typeof fetch))
      .toEqual({ ok: false, error: 'invalid fields', issues: { name: ['name is required'] } });
  });

  it('parses the job view and rejects a malformed payload', async () => {
    expect((await getJob('j1', (async () => json(VIEW)) as typeof fetch)).job.status).toBe('running');
    await expect(getJob('j1', (async () => json({ job: 5 })) as typeof fetch)).rejects.toThrow();
  });

  it('reports an approve conflict as an error', async () => {
    await expect(approveVariant('j1', 3, (async () => json({ error: 'variant 3 is failed' }, 409)) as typeof fetch)).rejects.toThrow(/variant 3 is failed/);
  });
});
