-- B4 queue-jump close (policy only). The dispatcher claims the oldest created_at first, so a member's INSERT must not choose
-- its own place: created_at is pinned to the insert's now() (+/- 1 min) and status to 'queued'. 0019's dispatch-claim check stays.
ALTER POLICY jobs_no_dispatch_claim ON jobs WITH CHECK (dispatched_at IS NULL AND status = 'queued' AND created_at >= now() - interval '1 minute' AND created_at <= now() + interval '1 minute');
