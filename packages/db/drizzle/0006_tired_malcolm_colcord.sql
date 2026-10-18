CREATE INDEX "jobs_org_id_index" ON "jobs" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "memberships_user_id_index" ON "memberships" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "products_org_id_index" ON "products" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "projects_org_id_index" ON "projects" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "provider_calls_org_id_index" ON "provider_calls" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "variants_org_id_index" ON "variants" USING btree ("org_id");--> statement-breakpoint
ALTER TABLE "assets" ADD CONSTRAINT "assets_id_orgId_unique" UNIQUE("id","org_id");--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_id_orgId_unique" UNIQUE("id","org_id");--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_id_orgId_unique" UNIQUE("id","org_id");--> statement-breakpoint
ALTER TABLE "variants" ADD CONSTRAINT "variants_id_orgId_unique" UNIQUE("id","org_id");