-- assets.analysis is written by the worker only (plate analysis, 0014). A member's INSERT names columns explicitly,
-- excluding it, so a member can never plant analysis JSON. Revoking the table-level privilege also drops its column grants.
REVOKE INSERT ON assets FROM authenticated;--> statement-breakpoint
GRANT INSERT (id, org_id, project_id, kind, storage_key, mime, width, height, duration_sec, bytes, sha256, source_url, created_at) ON assets TO authenticated;
