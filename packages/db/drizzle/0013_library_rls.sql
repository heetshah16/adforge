-- library_assets (C1): per-org library entries. Members read their own org only; the pipeline writes on the owner connection.
REVOKE ALL ON library_assets FROM anon, authenticated;--> statement-breakpoint
GRANT SELECT ON library_assets TO authenticated;--> statement-breakpoint
ALTER TABLE library_assets ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS library_assets_member_select ON library_assets;--> statement-breakpoint
CREATE POLICY library_assets_member_select ON library_assets FOR SELECT TO authenticated USING (public.is_member(org_id));