CREATE TYPE "public"."call_status" AS ENUM('pending', 'done', 'failed');--> statement-breakpoint
CREATE TYPE "public"."job_status" AS ENUM('queued', 'running', 'completed', 'failed');--> statement-breakpoint
CREATE TYPE "public"."variant_status" AS ENUM('pending', 'running', 'completed', 'failed');--> statement-breakpoint
CREATE TYPE "public"."vocab_kind" AS ENUM('archetype', 'format', 'hook');--> statement-breakpoint
CREATE TYPE "public"."vocab_status" AS ENUM('proposed', 'experimental', 'active', 'retired');--> statement-breakpoint
CREATE TABLE "archetypes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"family_id" uuid,
	"name" text NOT NULL,
	"buying_driver" text NOT NULL,
	"definition" text NOT NULL,
	"examples" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" "vocab_status" DEFAULT 'proposed' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"retired_at" timestamp with time zone,
	CONSTRAINT "archetypes_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "assets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"storage_key" text NOT NULL,
	"mime" text NOT NULL,
	"width" integer,
	"height" integer,
	"duration_sec" double precision,
	"bytes" integer NOT NULL,
	"sha256" text NOT NULL,
	"source_url" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "assets_projectId_sha256_unique" UNIQUE("project_id","sha256")
);
--> statement-breakpoint
CREATE TABLE "formats" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"family_id" uuid NOT NULL,
	"name" text NOT NULL,
	"beats" jsonb NOT NULL,
	"fits_archetypes" text[] DEFAULT '{}' NOT NULL,
	"definition" text NOT NULL,
	"status" "vocab_status" DEFAULT 'proposed' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"retired_at" timestamp with time zone,
	CONSTRAINT "formats_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "hook_archetypes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"family_id" uuid NOT NULL,
	"name" text NOT NULL,
	"shape" text NOT NULL,
	"skeleton" text NOT NULL,
	"constraints" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"fits_archetypes" text[] DEFAULT '{}' NOT NULL,
	"status" "vocab_status" DEFAULT 'proposed' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"retired_at" timestamp with time zone,
	CONSTRAINT "hook_archetypes_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"status" "job_status" DEFAULT 'queued' NOT NULL,
	"input_spec" jsonb NOT NULL,
	"brief" jsonb,
	"shortlist" jsonb,
	"config_snapshot" jsonb,
	"cost_usd" double precision DEFAULT 0 NOT NULL,
	"error" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"brand_kit" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "provider_calls" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid,
	"variant_id" uuid,
	"kind" text NOT NULL,
	"provider" text NOT NULL,
	"model" text,
	"request_hash" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"latency_ms" integer,
	"cost_usd" double precision DEFAULT 0 NOT NULL,
	"status" "call_status" DEFAULT 'pending' NOT NULL,
	"error" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "provider_calls_idempotencyKey_unique" UNIQUE("idempotency_key")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "variants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid NOT NULL,
	"variant_no" integer NOT NULL,
	"format_slug" text NOT NULL,
	"hook_slug" text NOT NULL,
	"archetype_slug" text NOT NULL,
	"visual_treatment" text NOT NULL,
	"strategic_bet" text NOT NULL,
	"is_exploratory" boolean DEFAULT false NOT NULL,
	"direction" jsonb,
	"spec" jsonb,
	"status" "variant_status" DEFAULT 'pending' NOT NULL,
	"render_asset_id" uuid,
	"cost_usd" double precision DEFAULT 0 NOT NULL,
	"error" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "variants_jobId_variantNo_unique" UNIQUE("job_id","variant_no")
);
--> statement-breakpoint
CREATE TABLE "vocab_families" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" "vocab_kind" NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	CONSTRAINT "vocab_families_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
ALTER TABLE "archetypes" ADD CONSTRAINT "archetypes_family_id_vocab_families_id_fk" FOREIGN KEY ("family_id") REFERENCES "public"."vocab_families"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assets" ADD CONSTRAINT "assets_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "formats" ADD CONSTRAINT "formats_family_id_vocab_families_id_fk" FOREIGN KEY ("family_id") REFERENCES "public"."vocab_families"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hook_archetypes" ADD CONSTRAINT "hook_archetypes_family_id_vocab_families_id_fk" FOREIGN KEY ("family_id") REFERENCES "public"."vocab_families"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_calls" ADD CONSTRAINT "provider_calls_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_calls" ADD CONSTRAINT "provider_calls_variant_id_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."variants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "variants" ADD CONSTRAINT "variants_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "variants" ADD CONSTRAINT "variants_render_asset_id_assets_id_fk" FOREIGN KEY ("render_asset_id") REFERENCES "public"."assets"("id") ON DELETE no action ON UPDATE no action;