-- S7: roles and row-level security as defense in depth (plan §3.10, §8.2, §8.3).
-- The application still filters every query by org_id; RLS makes a forgotten filter return no rows instead of another tenant's data.
--
-- Roles (NOLOGIN groups; operators grant them to real login roles):
--   lb_api     web requests. Every request runs `SET ROLE lb_api` + `app.org_id` via Db.withOrg(); subject to the policies below.
--   lb_worker  job workers. Policies admit it for all orgs (see lb_rls_bypass); connect with LB_DB_ROLE=lb_worker.
--   lb_purge   retention/purge. Also admitted by the policies and by the immutability triggers.
--   lb_migrate DDL owner. Admitted by the policies so migrations and tooling still see every row.
-- BYPASSRLS is deliberately NOT used: managed Postgres (RDS) may not grant it, so the policies check the role by name instead.
-- Superusers always bypass RLS in PostgreSQL, so tests that run as the superuser owner do not prove isolation; tests must SET ROLE lb_api.

DO $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['lb_api', 'lb_worker', 'lb_purge', 'lb_migrate'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN EXECUTE format('CREATE ROLE %I NOLOGIN', r); END IF;
  END LOOP;
END $$;

CREATE FUNCTION lb_current_org() RETURNS uuid LANGUAGE sql STABLE AS
  $$ SELECT nullif(current_setting('app.org_id', true), '')::uuid $$;
CREATE FUNCTION lb_rls_bypass() RETURNS boolean LANGUAGE sql STABLE AS
  $$ SELECT current_user IN ('lb_worker', 'lb_purge', 'lb_migrate') $$;

GRANT USAGE ON SCHEMA public TO lb_api, lb_worker, lb_purge, lb_migrate;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO lb_api, lb_worker, lb_purge;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO lb_api, lb_worker, lb_purge;
GRANT ALL ON ALL TABLES IN SCHEMA public TO lb_migrate;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO lb_migrate;
-- Tables added by later migrations get the same grants (they must also get RLS: tests/api/rls.test.ts fails if one does not).
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO lb_api, lb_worker, lb_purge;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO lb_api, lb_worker, lb_purge;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO lb_migrate;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO lb_migrate;

-- Every table with an org_id column. `organizations` is keyed on id.
-- Not covered, on purpose: `users` (global identity table with no org_id; membership is org-scoped through `memberships`),
-- `execution_environments` (platform-wide, no org_id), `lb_migrations`.
DO $$
DECLARE t record;
BEGIN
  FOR t IN SELECT c.table_name FROM information_schema.columns c
           JOIN information_schema.tables tb ON tb.table_schema = c.table_schema AND tb.table_name = c.table_name AND tb.table_type = 'BASE TABLE'
           WHERE c.table_schema = 'public' AND c.column_name = 'org_id' ORDER BY 1 LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t.table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t.table_name);
    EXECUTE format('CREATE POLICY lb_org_isolation ON %I USING (org_id = lb_current_org() OR lb_rls_bypass()) WITH CHECK (org_id = lb_current_org() OR lb_rls_bypass())', t.table_name);
  END LOOP;
END $$;
ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE organizations FORCE ROW LEVEL SECURITY;
CREATE POLICY lb_org_isolation ON organizations USING (id = lb_current_org() OR lb_rls_bypass()) WITH CHECK (id = lb_current_org() OR lb_rls_bypass());
