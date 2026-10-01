ALTER TABLE "favorites" RENAME COLUMN "session_id" TO "viewer_key";--> statement-breakpoint
DROP INDEX "favorites_one";--> statement-breakpoint
CREATE UNIQUE INDEX "favorites_one" ON "favorites" USING btree ("photo_id","viewer_key");