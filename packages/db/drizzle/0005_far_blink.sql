ALTER TABLE "assets" DROP CONSTRAINT "assets_projectId_sha256_unique";--> statement-breakpoint
ALTER TABLE "assets" ALTER COLUMN "org_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "jobs" ALTER COLUMN "org_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "projects" ALTER COLUMN "org_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "provider_calls" ALTER COLUMN "org_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "variants" ALTER COLUMN "org_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "assets" ADD CONSTRAINT "assets_orgId_sha256_unique" UNIQUE("org_id","sha256");