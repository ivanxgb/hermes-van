CREATE TABLE `push_subscriptions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`endpoint` text NOT NULL,
	`p256dh` text NOT NULL,
	`auth` text NOT NULL,
	`user_agent` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`last_seen_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`failed_count` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `ix_push_user` ON `push_subscriptions` (`user_id`);--> statement-breakpoint
CREATE INDEX `ix_push_endpoint` ON `push_subscriptions` (`endpoint`);