CREATE TABLE "workers" (
	"instance_id" text PRIMARY KEY NOT NULL,
	"last_seen" timestamp with time zone NOT NULL,
	"status" text NOT NULL,
	"gpu" text,
	"vram_free_mb" integer,
	"services" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "workers_status_check" CHECK ("workers"."status" in ('online','offline'))
);
--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "dispatched_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "jobs_undispatched_idx" ON "jobs" USING btree ("status","created_at") WHERE "jobs"."dispatched_at" is null;--> statement-breakpoint
-- workers (B4): the GPU worker's heartbeat. No org_id; owner connection only. RLS on with no policies, no grants.
REVOKE ALL ON workers FROM anon, authenticated;--> statement-breakpoint
ALTER TABLE workers ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
-- jobs.dispatched_at is the dispatcher's claim. Members INSERT jobs with table-level INSERT (0009) and drizzle lists every column,
-- so a column-level narrowing would break the web insert; a restrictive policy refuses a planted value instead. UPDATE is already ungranted.
DROP POLICY IF EXISTS jobs_no_dispatch_claim ON jobs;--> statement-breakpoint
CREATE POLICY jobs_no_dispatch_claim ON jobs AS RESTRICTIVE FOR INSERT TO authenticated WITH CHECK (dispatched_at IS NULL);
