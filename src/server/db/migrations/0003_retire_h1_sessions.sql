-- H1 people sessions and unredeemed H1 magic links end here; people sign in through Better Auth. Plugin tokens stay.
DELETE FROM sessions WHERE kind IN ('admin','client');--> statement-breakpoint
DROP INDEX "sessions_login_token";--> statement-breakpoint
ALTER TABLE "sessions" DROP COLUMN "login_token_hash";--> statement-breakpoint
ALTER TABLE "sessions" DROP COLUMN "redeemed_at";