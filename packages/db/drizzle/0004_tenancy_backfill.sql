-- B2 tenancy backfill: every pre-existing (POC) row belongs to the Operator org.
-- The id is OPERATOR_ORG_ID in src/seed/seed.ts. Idempotent: re-running changes nothing.
INSERT INTO "orgs" ("id", "name") VALUES ('00000000-0000-4000-8000-000000000001', 'Operator') ON CONFLICT ("id") DO NOTHING;--> statement-breakpoint
UPDATE "projects" SET "org_id" = '00000000-0000-4000-8000-000000000001' WHERE "org_id" IS NULL;--> statement-breakpoint
UPDATE "assets" SET "org_id" = '00000000-0000-4000-8000-000000000001' WHERE "org_id" IS NULL;--> statement-breakpoint
UPDATE "jobs" SET "org_id" = '00000000-0000-4000-8000-000000000001' WHERE "org_id" IS NULL;--> statement-breakpoint
UPDATE "variants" SET "org_id" = '00000000-0000-4000-8000-000000000001' WHERE "org_id" IS NULL;--> statement-breakpoint
UPDATE "provider_calls" SET "org_id" = '00000000-0000-4000-8000-000000000001' WHERE "org_id" IS NULL;
