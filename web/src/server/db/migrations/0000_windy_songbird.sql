CREATE TABLE `audit_log` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text,
	`ts` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`event` text NOT NULL,
	`ip` text,
	`user_agent` text,
	`metadata` text
);
--> statement-breakpoint
CREATE INDEX `ix_audit_user_ts` ON `audit_log` (`user_id`,`ts`);--> statement-breakpoint
CREATE INDEX `ix_audit_ts` ON `audit_log` (`ts`);--> statement-breakpoint
CREATE TABLE `recovery_codes` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`code_hash` text NOT NULL,
	`used_at` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `ix_recovery_user` ON `recovery_codes` (`user_id`);--> statement-breakpoint
CREATE TABLE `setup_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`token_hash` text NOT NULL,
	`expires_at` integer NOT NULL,
	`used_at` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`username` text NOT NULL,
	`display_name` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_username_unique` ON `users` (`username`);--> statement-breakpoint
CREATE TABLE `web_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`last_seen_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`expires_at` integer NOT NULL,
	`revoked_at` integer,
	`ip` text,
	`user_agent` text,
	`csrf_token_hash` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `ix_websessions_user` ON `web_sessions` (`user_id`);--> statement-breakpoint
CREATE INDEX `ix_websessions_expires` ON `web_sessions` (`expires_at`);--> statement-breakpoint
CREATE TABLE `webauthn_credentials` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`credential_id` text NOT NULL,
	`public_key` text NOT NULL,
	`counter` integer DEFAULT 0 NOT NULL,
	`transports` text DEFAULT '[]' NOT NULL,
	`backed_up` integer DEFAULT false NOT NULL,
	`device_type` text DEFAULT 'unknown' NOT NULL,
	`nickname` text,
	`last_used_at` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `webauthn_credentials_credential_id_unique` ON `webauthn_credentials` (`credential_id`);--> statement-breakpoint
CREATE INDEX `ix_webauthn_user` ON `webauthn_credentials` (`user_id`);