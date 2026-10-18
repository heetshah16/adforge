-- B2: members write only what the app writes as a user. Status, cost, user_id, org_id and every
-- worker-owned column stay owner-only. The FOR ALL member policies from 0008 still scope each granted
-- command to the member's org; a command with no grant here is refused before RLS is consulted.
-- Revoking a table-level privilege also revokes that privilege's column grants, so this is idempotent.
REVOKE INSERT, UPDATE, DELETE ON projects, products, assets, jobs, variants FROM authenticated;--> statement-breakpoint
GRANT INSERT ON projects, products, assets, jobs TO authenticated;--> statement-breakpoint
GRANT UPDATE (name, brand_kit) ON projects TO authenticated;--> statement-breakpoint
GRANT UPDATE (name) ON products TO authenticated;--> statement-breakpoint
GRANT UPDATE (status) ON variants TO authenticated;
