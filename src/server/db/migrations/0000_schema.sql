CREATE TABLE "clients" (
	"id" text PRIMARY KEY NOT NULL,
	"studio_id" text DEFAULT current_setting('app.studio_id') NOT NULL,
	"state_version" integer DEFAULT 1 NOT NULL,
	"name" text NOT NULL,
	"emails" jsonb NOT NULL,
	"phone" text DEFAULT '' NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"stripe_customer_id" text,
	"referral_code" text
);
--> statement-breakpoint
CREATE TABLE "comments" (
	"id" text PRIMARY KEY NOT NULL,
	"studio_id" text DEFAULT current_setting('app.studio_id') NOT NULL,
	"photo_id" text NOT NULL,
	"author" text NOT NULL,
	"stage" text NOT NULL,
	"x" double precision,
	"y" double precision,
	"w" double precision,
	"h" double precision,
	"t" double precision,
	"text" text NOT NULL,
	"created_at" text DEFAULT to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL,
	"resolved_at" text
);
--> statement-breakpoint
CREATE TABLE "events" (
	"id" serial PRIMARY KEY NOT NULL,
	"studio_id" text DEFAULT current_setting('app.studio_id') NOT NULL,
	"project_id" text,
	"actor" text NOT NULL,
	"type" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"at" text DEFAULT to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "favorites" (
	"studio_id" text DEFAULT current_setting('app.studio_id') NOT NULL,
	"photo_id" text NOT NULL,
	"session_id" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invoices" (
	"id" text PRIMARY KEY NOT NULL,
	"studio_id" text DEFAULT current_setting('app.studio_id') NOT NULL,
	"project_id" text NOT NULL,
	"kind" text NOT NULL,
	"amount" integer NOT NULL,
	"tax" integer DEFAULT 0 NOT NULL,
	"currency" text NOT NULL,
	"stripe_id" text,
	"paid_amount" integer DEFAULT 0 NOT NULL,
	"paid_at" text,
	"paid_via" text,
	"refunded_amount" integer DEFAULT 0 NOT NULL,
	"needs_review" boolean DEFAULT false NOT NULL,
	"voided_at" text,
	"created_at" text DEFAULT to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" text PRIMARY KEY NOT NULL,
	"studio_id" text DEFAULT current_setting('app.studio_id') NOT NULL,
	"kind" text NOT NULL,
	"payload" jsonb NOT NULL,
	"idempotency_key" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_at" bigint NOT NULL,
	"leased_until" bigint,
	"state" text DEFAULT 'pending' NOT NULL,
	"last_error" text,
	"created_at" text DEFAULT to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "photos" (
	"id" text PRIMARY KEY NOT NULL,
	"studio_id" text DEFAULT current_setting('app.studio_id') NOT NULL,
	"project_id" text NOT NULL,
	"rel_path" text NOT NULL,
	"draft_rel_path" text,
	"live" boolean DEFAULT true NOT NULL,
	"stage" text NOT NULL,
	"kind" text NOT NULL,
	"source_photo_id" text,
	"checksum" text NOT NULL,
	"width" integer,
	"height" integer,
	"captured_at" text,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"section" text,
	"edit_state" text DEFAULT 'none' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "picks" (
	"studio_id" text DEFAULT current_setting('app.studio_id') NOT NULL,
	"project_id" text NOT NULL,
	"photo_id" text NOT NULL,
	"round" integer NOT NULL,
	"by_email" text NOT NULL,
	"picked_at" text DEFAULT to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" text PRIMARY KEY NOT NULL,
	"studio_id" text DEFAULT current_setting('app.studio_id') NOT NULL,
	"client_id" text NOT NULL,
	"state_version" integer DEFAULT 1 NOT NULL,
	"booking_state" text DEFAULT 'inquiry' NOT NULL,
	"production_state" text DEFAULT 'not_started' NOT NULL,
	"archived_at" text,
	"date" text,
	"current_round" integer DEFAULT 1 NOT NULL,
	"selection_version" integer DEFAULT 1 NOT NULL,
	"metadata_json" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reservations" (
	"id" text PRIMARY KEY NOT NULL,
	"studio_id" text DEFAULT current_setting('app.studio_id') NOT NULL,
	"project_id" text NOT NULL,
	"kind" text NOT NULL,
	"admin_id" text,
	"starts_at" text NOT NULL,
	"ends_at" text NOT NULL,
	"local_date" text NOT NULL,
	"state" text NOT NULL,
	"expires_at" text
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"studio_id" text DEFAULT current_setting('app.studio_id') NOT NULL,
	"kind" text NOT NULL,
	"subject" text NOT NULL,
	"project_id" text,
	"scope" text DEFAULT 'read' NOT NULL,
	"login_token_hash" text,
	"token_hash" text,
	"expires_at" text NOT NULL,
	"redeemed_at" text,
	"nickname" text,
	"created_at" text DEFAULT to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"studio_id" text DEFAULT current_setting('app.studio_id') NOT NULL,
	"key" text NOT NULL,
	"value" jsonb NOT NULL,
	CONSTRAINT "settings_studio_id_key_pk" PRIMARY KEY("studio_id","key")
);
--> statement-breakpoint
CREATE TABLE "slot_grants" (
	"id" text PRIMARY KEY NOT NULL,
	"studio_id" text DEFAULT current_setting('app.studio_id') NOT NULL,
	"project_id" text NOT NULL,
	"delta" integer NOT NULL,
	"reason" text NOT NULL,
	"reference" text,
	"actor" text NOT NULL,
	"at" text DEFAULT to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "studios" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"created_at" text DEFAULT to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"studio_id" text DEFAULT current_setting('app.studio_id') NOT NULL,
	"email" text NOT NULL,
	"name" text DEFAULT '' NOT NULL,
	"role" text NOT NULL,
	"notify_downloads" text DEFAULT 'digest' NOT NULL,
	"created_at" text DEFAULT to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "webhook_inbox" (
	"provider" text NOT NULL,
	"event_id" text NOT NULL,
	"object_id" text,
	"payload" jsonb NOT NULL,
	"state" text DEFAULT 'received' NOT NULL,
	"received_at" text DEFAULT to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL
);
--> statement-breakpoint
ALTER TABLE "clients" ADD CONSTRAINT "clients_studio_id_studios_id_fk" FOREIGN KEY ("studio_id") REFERENCES "public"."studios"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_studio_id_studios_id_fk" FOREIGN KEY ("studio_id") REFERENCES "public"."studios"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_photo_id_photos_id_fk" FOREIGN KEY ("photo_id") REFERENCES "public"."photos"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_studio_id_studios_id_fk" FOREIGN KEY ("studio_id") REFERENCES "public"."studios"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "favorites" ADD CONSTRAINT "favorites_studio_id_studios_id_fk" FOREIGN KEY ("studio_id") REFERENCES "public"."studios"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "favorites" ADD CONSTRAINT "favorites_photo_id_photos_id_fk" FOREIGN KEY ("photo_id") REFERENCES "public"."photos"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_studio_id_studios_id_fk" FOREIGN KEY ("studio_id") REFERENCES "public"."studios"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_studio_id_studios_id_fk" FOREIGN KEY ("studio_id") REFERENCES "public"."studios"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "photos" ADD CONSTRAINT "photos_studio_id_studios_id_fk" FOREIGN KEY ("studio_id") REFERENCES "public"."studios"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "photos" ADD CONSTRAINT "photos_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "picks" ADD CONSTRAINT "picks_studio_id_studios_id_fk" FOREIGN KEY ("studio_id") REFERENCES "public"."studios"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "picks" ADD CONSTRAINT "picks_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "picks" ADD CONSTRAINT "picks_photo_id_photos_id_fk" FOREIGN KEY ("photo_id") REFERENCES "public"."photos"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_studio_id_studios_id_fk" FOREIGN KEY ("studio_id") REFERENCES "public"."studios"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_studio_id_studios_id_fk" FOREIGN KEY ("studio_id") REFERENCES "public"."studios"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_studio_id_studios_id_fk" FOREIGN KEY ("studio_id") REFERENCES "public"."studios"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settings" ADD CONSTRAINT "settings_studio_id_studios_id_fk" FOREIGN KEY ("studio_id") REFERENCES "public"."studios"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slot_grants" ADD CONSTRAINT "slot_grants_studio_id_studios_id_fk" FOREIGN KEY ("studio_id") REFERENCES "public"."studios"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slot_grants" ADD CONSTRAINT "slot_grants_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_studio_id_studios_id_fk" FOREIGN KEY ("studio_id") REFERENCES "public"."studios"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "events_project" ON "events" USING btree ("project_id","at");--> statement-breakpoint
CREATE UNIQUE INDEX "favorites_one" ON "favorites" USING btree ("photo_id","session_id");--> statement-breakpoint
CREATE UNIQUE INDEX "invoices_one_open_extras" ON "invoices" USING btree ("project_id") WHERE kind = 'extras' AND paid_at IS NULL AND voided_at IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "jobs_idempotency" ON "jobs" USING btree ("studio_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "jobs_due" ON "jobs" USING btree ("state","next_at");--> statement-breakpoint
CREATE UNIQUE INDEX "photos_project_path" ON "photos" USING btree ("project_id","rel_path");--> statement-breakpoint
CREATE UNIQUE INDEX "picks_project_photo" ON "picks" USING btree ("project_id","photo_id");--> statement-breakpoint
CREATE INDEX "reservations_date" ON "reservations" USING btree ("local_date","state");--> statement-breakpoint
CREATE UNIQUE INDEX "sessions_login_token" ON "sessions" USING btree ("login_token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "sessions_token" ON "sessions" USING btree ("token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "slot_grants_reference" ON "slot_grants" USING btree ("reference");--> statement-breakpoint
CREATE UNIQUE INDEX "inbox_provider_event" ON "webhook_inbox" USING btree ("provider","event_id");