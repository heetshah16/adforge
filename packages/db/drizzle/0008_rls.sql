-- B2 row-level security. Idempotent; applies unchanged on Supabase, plain Postgres (CI) and PGlite.
-- Supabase already has the roles and the real auth.uid(); elsewhere this creates them, never replacing Supabase's.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
END $$;--> statement-breakpoint
CREATE SCHEMA IF NOT EXISTS auth;--> statement-breakpoint
-- Same body as Supabase's auth.uid(): the JWT `sub` from the request claims.
DO $$ BEGIN
  IF to_regprocedure('auth.uid()') IS NULL THEN
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $f$
      select coalesce(nullif(current_setting('request.jwt.claim.sub', true), ''), (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'))::uuid
    $f$;
    GRANT USAGE ON SCHEMA auth TO anon, authenticated;
  END IF;
END $$;--> statement-breakpoint
-- security definer: they read memberships/users past those tables' own RLS. Tables are schema-qualified so
-- search_path (incl. pg_temp) cannot redirect them.
CREATE OR REPLACE FUNCTION public.is_member(org uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  select exists (select 1 from public.memberships m where m.org_id = org and m.user_id = auth.uid())
$$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.is_admin() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  select coalesce((select u.is_admin from public.users u where u.id = auth.uid()), false)
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.is_member(uuid), public.is_admin() FROM PUBLIC, anon;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.is_member(uuid), public.is_admin() TO authenticated;--> statement-breakpoint
-- Supabase grants anon/authenticated ALL on public tables, including TRUNCATE, which bypasses RLS.
-- Start from nothing (also for tables created later) and grant only what the policies below need.
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon, authenticated;--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM anon, authenticated;--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO authenticated;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON projects, products, assets, jobs, variants TO authenticated;--> statement-breakpoint
GRANT SELECT ON provider_calls, orgs, memberships, users, vocab_families, archetypes, formats, hook_archetypes TO authenticated;--> statement-breakpoint
GRANT SELECT, UPDATE ON waitlist TO authenticated;--> statement-breakpoint
ALTER TABLE users ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE orgs ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE memberships ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE waitlist ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE projects ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE products ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE assets ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE jobs ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE variants ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE provider_calls ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE vocab_families ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE archetypes ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE formats ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE hook_archetypes ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
-- Tenant tables: members of the row's org, all four commands. No anon policy exists anywhere.
DROP POLICY IF EXISTS projects_member ON projects;--> statement-breakpoint
CREATE POLICY projects_member ON projects FOR ALL TO authenticated USING (public.is_member(org_id)) WITH CHECK (public.is_member(org_id));--> statement-breakpoint
DROP POLICY IF EXISTS products_member ON products;--> statement-breakpoint
CREATE POLICY products_member ON products FOR ALL TO authenticated USING (public.is_member(org_id)) WITH CHECK (public.is_member(org_id));--> statement-breakpoint
DROP POLICY IF EXISTS assets_member ON assets;--> statement-breakpoint
CREATE POLICY assets_member ON assets FOR ALL TO authenticated USING (public.is_member(org_id)) WITH CHECK (public.is_member(org_id));--> statement-breakpoint
DROP POLICY IF EXISTS jobs_member ON jobs;--> statement-breakpoint
CREATE POLICY jobs_member ON jobs FOR ALL TO authenticated USING (public.is_member(org_id)) WITH CHECK (public.is_member(org_id));--> statement-breakpoint
DROP POLICY IF EXISTS variants_member ON variants;--> statement-breakpoint
CREATE POLICY variants_member ON variants FOR ALL TO authenticated USING (public.is_member(org_id)) WITH CHECK (public.is_member(org_id));--> statement-breakpoint
-- provider_calls: written only by the worker (owner connection); members may read their org's.
DROP POLICY IF EXISTS provider_calls_member_select ON provider_calls;--> statement-breakpoint
CREATE POLICY provider_calls_member_select ON provider_calls FOR SELECT TO authenticated USING (public.is_member(org_id));--> statement-breakpoint
DROP POLICY IF EXISTS orgs_member_select ON orgs;--> statement-breakpoint
CREATE POLICY orgs_member_select ON orgs FOR SELECT TO authenticated USING (public.is_member(id));--> statement-breakpoint
DROP POLICY IF EXISTS memberships_own_select ON memberships;--> statement-breakpoint
CREATE POLICY memberships_own_select ON memberships FOR SELECT TO authenticated USING (user_id = (select auth.uid()));--> statement-breakpoint
DROP POLICY IF EXISTS users_own_select ON users;--> statement-breakpoint
CREATE POLICY users_own_select ON users FOR SELECT TO authenticated USING (id = (select auth.uid()));--> statement-breakpoint
-- Registry: readable by any signed-in user, written only by the owner (seeds, review tooling).
DROP POLICY IF EXISTS vocab_families_read ON vocab_families;--> statement-breakpoint
CREATE POLICY vocab_families_read ON vocab_families FOR SELECT TO authenticated USING (true);--> statement-breakpoint
DROP POLICY IF EXISTS archetypes_read ON archetypes;--> statement-breakpoint
CREATE POLICY archetypes_read ON archetypes FOR SELECT TO authenticated USING (true);--> statement-breakpoint
DROP POLICY IF EXISTS formats_read ON formats;--> statement-breakpoint
CREATE POLICY formats_read ON formats FOR SELECT TO authenticated USING (true);--> statement-breakpoint
DROP POLICY IF EXISTS hook_archetypes_read ON hook_archetypes;--> statement-breakpoint
CREATE POLICY hook_archetypes_read ON hook_archetypes FOR SELECT TO authenticated USING (true);--> statement-breakpoint
-- Waitlist: admins only. Public sign-ups insert through the owner connection (waitlist-owner.ts).
DROP POLICY IF EXISTS waitlist_admin_select ON waitlist;--> statement-breakpoint
CREATE POLICY waitlist_admin_select ON waitlist FOR SELECT TO authenticated USING (public.is_admin());--> statement-breakpoint
DROP POLICY IF EXISTS waitlist_admin_update ON waitlist;--> statement-breakpoint
CREATE POLICY waitlist_admin_update ON waitlist FOR UPDATE TO authenticated USING (public.is_admin()) WITH CHECK (public.is_admin());
