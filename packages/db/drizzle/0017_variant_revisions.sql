CREATE TYPE "public"."revision_status" AS ENUM('ready', 'pending', 'failed');--> statement-breakpoint
CREATE TABLE "variant_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"variant_id" uuid NOT NULL,
	"parent_id" uuid,
	"ops" jsonb NOT NULL,
	"beats" jsonb NOT NULL,
	"spec" jsonb,
	"status" "revision_status" NOT NULL,
	"locked" boolean DEFAULT false NOT NULL,
	"error" jsonb,
	"render_asset_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "variant_revisions_id_orgId_unique" UNIQUE("id","org_id")
);
--> statement-breakpoint
ALTER TABLE "variants" ADD COLUMN "project_base" jsonb;--> statement-breakpoint
ALTER TABLE "variant_revisions" ADD CONSTRAINT "variant_revisions_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "variant_revisions" ADD CONSTRAINT "variant_revisions_variant_id_org_id_variants_id_org_id_fk" FOREIGN KEY ("variant_id","org_id") REFERENCES "public"."variants"("id","org_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "variant_revisions" ADD CONSTRAINT "variant_revisions_parent_id_org_id_variant_revisions_id_org_id_fk" FOREIGN KEY ("parent_id","org_id") REFERENCES "public"."variant_revisions"("id","org_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "variant_revisions" ADD CONSTRAINT "variant_revisions_render_asset_id_org_id_assets_id_org_id_fk" FOREIGN KEY ("render_asset_id","org_id") REFERENCES "public"."assets"("id","org_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "variant_revisions_variant_id_created_at_index" ON "variant_revisions" USING btree ("variant_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "variant_revisions_variant_id_index" ON "variant_revisions" USING btree ("variant_id") WHERE "variant_revisions"."parent_id" is null;--> statement-breakpoint
-- Task 2 review M5: recipe kinds are a closed set.
ALTER TABLE "recipes" ADD CONSTRAINT "recipes_kind_check" CHECK ("kind" IN ('plate','cutout','broll','tts','align'));--> statement-breakpoint
-- variant_revisions (C2): members read their own org. They INSERT (the revision route) only the columns below; the policy forces a
-- new revision to be pending and unlocked, so a member can never plant a 'ready' revision or a spec. They UPDATE only `locked`, and
-- only to true (a locked revision is immutable: unlocking is a child revision). spec, error, render_asset_id and status moves are the worker's.
REVOKE ALL ON variant_revisions FROM anon, authenticated;--> statement-breakpoint
GRANT SELECT ON variant_revisions TO authenticated;--> statement-breakpoint
GRANT INSERT (id, org_id, variant_id, parent_id, ops, beats, status, locked) ON variant_revisions TO authenticated;--> statement-breakpoint
GRANT UPDATE (locked) ON variant_revisions TO authenticated;--> statement-breakpoint
ALTER TABLE variant_revisions ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS variant_revisions_member_select ON variant_revisions;--> statement-breakpoint
CREATE POLICY variant_revisions_member_select ON variant_revisions FOR SELECT TO authenticated USING (public.is_member(org_id));--> statement-breakpoint
DROP POLICY IF EXISTS variant_revisions_member_insert ON variant_revisions;--> statement-breakpoint
CREATE POLICY variant_revisions_member_insert ON variant_revisions FOR INSERT TO authenticated WITH CHECK (public.is_member(org_id) AND status = 'pending' AND NOT locked AND parent_id IS NOT NULL);--> statement-breakpoint
DROP POLICY IF EXISTS variant_revisions_member_lock ON variant_revisions;--> statement-breakpoint
CREATE POLICY variant_revisions_member_lock ON variant_revisions FOR UPDATE TO authenticated USING (public.is_member(org_id) AND status = 'ready') WITH CHECK (public.is_member(org_id) AND locked);
