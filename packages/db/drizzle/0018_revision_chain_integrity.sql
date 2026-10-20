-- A parent revision must belong to the same variant. (id, variant_id) supersedes the old (parent_id, org_id) FK: the child's own
-- (variant_id, org_id) FK pins its org, and the parent shares its variant, so the parent is in the same org too.
ALTER TABLE "variant_revisions" ADD CONSTRAINT "variant_revisions_id_variantId_unique" UNIQUE("id","variant_id");--> statement-breakpoint
ALTER TABLE "variant_revisions" DROP CONSTRAINT "variant_revisions_parent_id_org_id_variant_revisions_id_org_id_fk";--> statement-breakpoint
ALTER TABLE "variant_revisions" ADD CONSTRAINT "variant_revisions_parent_id_variant_id_variant_revisions_id_variant_id_fk" FOREIGN KEY ("parent_id","variant_id") REFERENCES "public"."variant_revisions"("id","variant_id") ON DELETE no action ON UPDATE no action;
