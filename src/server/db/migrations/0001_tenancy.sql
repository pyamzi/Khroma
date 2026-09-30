-- The app runs every transaction as og_app (SET LOCAL ROLE, see db/tenancy.ts). Row-level security scopes tenant tables to
-- current_setting('app.studio_id'); app.system = 'on' opens a cross-Studio transaction. New tables with studio_id must repeat the RLS block.
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'og_app') THEN CREATE ROLE og_app NOLOGIN NOBYPASSRLS; END IF;
END $$;
--> statement-breakpoint
GRANT og_app TO CURRENT_USER;
--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO og_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO og_app;
--> statement-breakpoint
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO og_app;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO og_app;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO og_app;
--> statement-breakpoint
DO $$ DECLARE t text; BEGIN
  FOR t IN SELECT table_name FROM information_schema.columns WHERE table_schema = 'public' AND column_name = 'studio_id' LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant ON %I USING (studio_id = current_setting('app.studio_id', true) OR current_setting('app.system', true) = 'on') WITH CHECK (studio_id = current_setting('app.studio_id', true) OR current_setting('app.system', true) = 'on')$p$, t);
  END LOOP;
END $$;
--> statement-breakpoint
ALTER TABLE studios ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE studios FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant ON studios USING (id = current_setting('app.studio_id', true) OR current_setting('app.system', true) = 'on') WITH CHECK (id = current_setting('app.studio_id', true) OR current_setting('app.system', true) = 'on');
