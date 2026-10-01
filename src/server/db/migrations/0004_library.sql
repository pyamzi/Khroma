ALTER TABLE "photos" ALTER COLUMN "project_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "photos" ADD COLUMN "in_library" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "photos" ADD COLUMN "status" text DEFAULT 'ready' NOT NULL;--> statement-breakpoint
ALTER TABLE "photos" ADD COLUMN "keywords" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "photos" ADD COLUMN "caption" text;--> statement-breakpoint
ALTER TABLE "photos" ADD COLUMN "created_at" text DEFAULT to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL;--> statement-breakpoint
ALTER TABLE "photos" ADD COLUMN "ready_at" text;--> statement-breakpoint
ALTER TABLE "photos" ADD COLUMN "purged_at" text;--> statement-breakpoint
CREATE INDEX "photos_studio_library" ON "photos" USING btree ("studio_id","in_library","created_at");--> statement-breakpoint
-- Culling RAWs and unpublished final drafts are working files, not Library photos. A live final (even with a replacement draft) stays in_library.
-- Row-level security is forced and its policies name only og_app and og_system, so the owner runs this as og_system (an owner without BYPASSRLS would match no rows).
SET LOCAL ROLE og_system;--> statement-breakpoint
UPDATE photos SET in_library = false WHERE stage = 'culling' OR (stage = 'final' AND live = false);--> statement-breakpoint
RESET ROLE;