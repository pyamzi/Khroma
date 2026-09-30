-- Two roles, never superusers, never BYPASSRLS. App transactions SET LOCAL ROLE (db/tenancy.ts):
--   og_app    — one Studio: sees rows where studio_id = current_setting('app.studio_id')
--   og_system — cross-Studio work (sign-in lookup, signup, job claiming): sees every row
-- Each policy is a plain equality on studio_id so the studio_id indexes are usable. New tables with studio_id must repeat the RLS block.
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'og_app') THEN CREATE ROLE og_app NOLOGIN NOBYPASSRLS; END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'og_system') THEN CREATE ROLE og_system NOLOGIN NOBYPASSRLS; END IF;
END $$;
--> statement-breakpoint
GRANT og_app TO CURRENT_USER;
--> statement-breakpoint
GRANT og_system TO CURRENT_USER;
--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO og_app, og_system;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO og_app, og_system;
--> statement-breakpoint
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO og_app, og_system;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO og_app, og_system;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO og_app, og_system;
--> statement-breakpoint
DO $$ DECLARE t text; BEGIN
  FOR t IN SELECT table_name FROM information_schema.columns WHERE table_schema = 'public' AND column_name = 'studio_id' LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant ON %I TO og_app USING (studio_id = current_setting('app.studio_id', true)) WITH CHECK (studio_id = current_setting('app.studio_id', true))$p$, t);
    EXECUTE format('CREATE POLICY system ON %I TO og_system USING (true) WITH CHECK (true)', t);
  END LOOP;
END $$;
--> statement-breakpoint
ALTER TABLE studios ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE studios FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant ON studios TO og_app USING (id = current_setting('app.studio_id', true)) WITH CHECK (id = current_setting('app.studio_id', true));
--> statement-breakpoint
CREATE POLICY system ON studios TO og_system USING (true) WITH CHECK (true);
