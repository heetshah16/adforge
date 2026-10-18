ALTER TABLE "assets" DROP CONSTRAINT "assets_project_id_projects_id_fk";
--> statement-breakpoint
ALTER TABLE "jobs" DROP CONSTRAINT "jobs_project_id_projects_id_fk";
--> statement-breakpoint
ALTER TABLE "products" DROP CONSTRAINT "products_project_id_projects_id_fk";
--> statement-breakpoint
ALTER TABLE "provider_calls" DROP CONSTRAINT "provider_calls_job_id_jobs_id_fk";
--> statement-breakpoint
ALTER TABLE "provider_calls" DROP CONSTRAINT "provider_calls_variant_id_variants_id_fk";
--> statement-breakpoint
ALTER TABLE "variants" DROP CONSTRAINT "variants_job_id_jobs_id_fk";
--> statement-breakpoint
ALTER TABLE "variants" DROP CONSTRAINT "variants_render_asset_id_assets_id_fk";
--> statement-breakpoint
ALTER TABLE "assets" ADD CONSTRAINT "assets_project_id_org_id_projects_id_org_id_fk" FOREIGN KEY ("project_id","org_id") REFERENCES "public"."projects"("id","org_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_project_id_org_id_projects_id_org_id_fk" FOREIGN KEY ("project_id","org_id") REFERENCES "public"."projects"("id","org_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_project_id_org_id_projects_id_org_id_fk" FOREIGN KEY ("project_id","org_id") REFERENCES "public"."projects"("id","org_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_calls" ADD CONSTRAINT "provider_calls_job_id_org_id_jobs_id_org_id_fk" FOREIGN KEY ("job_id","org_id") REFERENCES "public"."jobs"("id","org_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_calls" ADD CONSTRAINT "provider_calls_variant_id_org_id_variants_id_org_id_fk" FOREIGN KEY ("variant_id","org_id") REFERENCES "public"."variants"("id","org_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "variants" ADD CONSTRAINT "variants_job_id_org_id_jobs_id_org_id_fk" FOREIGN KEY ("job_id","org_id") REFERENCES "public"."jobs"("id","org_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "variants" ADD CONSTRAINT "variants_render_asset_id_org_id_assets_id_org_id_fk" FOREIGN KEY ("render_asset_id","org_id") REFERENCES "public"."assets"("id","org_id") ON DELETE no action ON UPDATE no action;