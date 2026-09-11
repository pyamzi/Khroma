CREATE TABLE `clients` (
	`id` text PRIMARY KEY NOT NULL,
	`folder_path` text NOT NULL,
	`available` integer DEFAULT true NOT NULL,
	`state_version` integer DEFAULT 1 NOT NULL,
	`name` text NOT NULL,
	`emails` text NOT NULL,
	`stripe_customer_id` text,
	`listmonk_subscriber_id` integer,
	`referral_code` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `clients_folder` ON `clients` (`folder_path`);--> statement-breakpoint
CREATE TABLE `comments` (
	`id` text PRIMARY KEY NOT NULL,
	`photo_id` text NOT NULL,
	`author` text NOT NULL,
	`stage` text NOT NULL,
	`x` real,
	`y` real,
	`w` real,
	`h` real,
	`t` real,
	`text` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`resolved_at` text,
	FOREIGN KEY (`photo_id`) REFERENCES `photos`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`project_id` text,
	`actor` text NOT NULL,
	`type` text NOT NULL,
	`payload` text DEFAULT '{}' NOT NULL,
	`at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `events_project` ON `events` (`project_id`,`at`);--> statement-breakpoint
CREATE TABLE `favorites` (
	`photo_id` text NOT NULL,
	`session_id` text NOT NULL,
	FOREIGN KEY (`photo_id`) REFERENCES `photos`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `favorites_one` ON `favorites` (`photo_id`,`session_id`);--> statement-breakpoint
CREATE TABLE `invoices` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`kind` text NOT NULL,
	`amount` integer NOT NULL,
	`tax` integer DEFAULT 0 NOT NULL,
	`currency` text NOT NULL,
	`stripe_id` text,
	`paid_amount` integer DEFAULT 0 NOT NULL,
	`paid_at` text,
	`paid_via` text,
	`refunded_amount` integer DEFAULT 0 NOT NULL,
	`needs_review` integer DEFAULT false NOT NULL,
	`voided_at` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `invoices_one_open_extras` ON `invoices` (`project_id`) WHERE kind = 'extras' AND paid_at IS NULL AND voided_at IS NULL;--> statement-breakpoint
CREATE TABLE `jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`payload` text NOT NULL,
	`idempotency_key` text,
	`attempts` integer DEFAULT 0 NOT NULL,
	`next_at` integer NOT NULL,
	`leased_until` integer,
	`state` text DEFAULT 'pending' NOT NULL,
	`last_error` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `jobs_idempotency` ON `jobs` (`idempotency_key`);--> statement-breakpoint
CREATE INDEX `jobs_due` ON `jobs` (`state`,`next_at`);--> statement-breakpoint
CREATE TABLE `photos` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`rel_path` text NOT NULL,
	`draft_rel_path` text,
	`stage` text NOT NULL,
	`kind` text NOT NULL,
	`source_photo_id` text,
	`checksum` text NOT NULL,
	`width` integer,
	`height` integer,
	`captured_at` text,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`section` text,
	`edit_state` text DEFAULT 'none' NOT NULL,
	`missing` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `photos_project_path` ON `photos` (`project_id`,`rel_path`);--> statement-breakpoint
CREATE TABLE `picks` (
	`project_id` text NOT NULL,
	`photo_id` text NOT NULL,
	`round` integer NOT NULL,
	`by_email` text NOT NULL,
	`picked_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`state` text DEFAULT 'pending' NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`photo_id`) REFERENCES `photos`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `picks_project_photo` ON `picks` (`project_id`,`photo_id`);--> statement-breakpoint
CREATE TABLE `projects` (
	`id` text PRIMARY KEY NOT NULL,
	`client_id` text NOT NULL,
	`folder_path` text NOT NULL,
	`available` integer DEFAULT true NOT NULL,
	`transfer_pending` integer DEFAULT false NOT NULL,
	`state_version` integer DEFAULT 1 NOT NULL,
	`booking_state` text DEFAULT 'inquiry' NOT NULL,
	`production_state` text DEFAULT 'not_started' NOT NULL,
	`archived_at` text,
	`date` text,
	`current_round` integer DEFAULT 1 NOT NULL,
	`last_indexed_at` text,
	`metadata_json` text NOT NULL,
	FOREIGN KEY (`client_id`) REFERENCES `clients`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `projects_folder` ON `projects` (`folder_path`);--> statement-breakpoint
CREATE TABLE `reservations` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`kind` text NOT NULL,
	`admin_id` text,
	`starts_at` text NOT NULL,
	`ends_at` text NOT NULL,
	`local_date` text NOT NULL,
	`state` text NOT NULL,
	`expires_at` text,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `reservations_date` ON `reservations` (`local_date`,`state`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`subject` text NOT NULL,
	`project_id` text,
	`scope` text DEFAULT 'read' NOT NULL,
	`login_token_hash` text,
	`token_hash` text,
	`expires_at` text NOT NULL,
	`redeemed_at` text,
	`nickname` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sessions_login_token` ON `sessions` (`login_token_hash`);--> statement-breakpoint
CREATE UNIQUE INDEX `sessions_token` ON `sessions` (`token_hash`);--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `slot_grants` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`delta` integer NOT NULL,
	`reason` text NOT NULL,
	`reference` text,
	`actor` text NOT NULL,
	`at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `slot_grants_reference` ON `slot_grants` (`reference`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`name` text DEFAULT '' NOT NULL,
	`role` text NOT NULL,
	`notify_downloads` text DEFAULT 'digest' NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_email_unique` ON `users` (`email`);--> statement-breakpoint
CREATE TABLE `webhook_inbox` (
	`provider` text NOT NULL,
	`event_id` text NOT NULL,
	`object_id` text,
	`payload` text NOT NULL,
	`state` text DEFAULT 'received' NOT NULL,
	`received_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `inbox_provider_event` ON `webhook_inbox` (`provider`,`event_id`);