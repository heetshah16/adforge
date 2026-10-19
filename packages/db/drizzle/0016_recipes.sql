CREATE TABLE "recipes" (
	"key" text PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"recipe" jsonb NOT NULL,
	"output_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "recipes" ADD CONSTRAINT "recipes_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "recipes_org_id_kind_index" ON "recipes" USING btree ("org_id","kind");--> statement-breakpoint
-- recipes (C2): the cross-revision asset cache. Members read their own org only; the pipeline writes on the owner connection.
REVOKE ALL ON recipes FROM anon, authenticated;--> statement-breakpoint
GRANT SELECT ON recipes TO authenticated;--> statement-breakpoint
ALTER TABLE recipes ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS recipes_member_select ON recipes;--> statement-breakpoint
CREATE POLICY recipes_member_select ON recipes FOR SELECT TO authenticated USING (public.is_member(org_id));
