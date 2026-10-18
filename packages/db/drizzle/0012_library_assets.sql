CREATE TYPE "public"."library_kind" AS ENUM('product_view', 'location', 'prop', 'brand_kit', 'voice');--> statement-breakpoint
CREATE TYPE "public"."library_status" AS ENUM('active', 'superseded');--> statement-breakpoint
CREATE TABLE "library_assets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"product_id" uuid,
	"tag" text NOT NULL,
	"version" integer NOT NULL,
	"kind" "library_kind" NOT NULL,
	"descriptor" text NOT NULL,
	"storage_key" text,
	"meta" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" "library_status" DEFAULT 'active' NOT NULL,
	"hero_eligible" boolean DEFAULT false NOT NULL,
	"gate" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "library_assets_orgId_tag_version_unique" UNIQUE("org_id","tag","version")
);
--> statement-breakpoint
ALTER TABLE "library_assets" ADD CONSTRAINT "library_assets_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "library_assets" ADD CONSTRAINT "library_assets_project_id_org_id_projects_id_org_id_fk" FOREIGN KEY ("project_id","org_id") REFERENCES "public"."projects"("id","org_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "library_assets" ADD CONSTRAINT "library_assets_product_id_org_id_products_id_org_id_fk" FOREIGN KEY ("product_id","org_id") REFERENCES "public"."products"("id","org_id") ON DELETE no action ON UPDATE no action;