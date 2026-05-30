CREATE TABLE `active_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`chat_id` text NOT NULL,
	`message_id` text NOT NULL,
	`upstream_run_id` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`error` text,
	`started_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`finished_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`chat_id`) REFERENCES `chats`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `ix_runs_user` ON `active_runs` (`user_id`);--> statement-breakpoint
CREATE INDEX `ix_runs_chat` ON `active_runs` (`chat_id`);--> statement-breakpoint
CREATE INDEX `ix_runs_upstream` ON `active_runs` (`upstream_run_id`);--> statement-breakpoint
CREATE TABLE `chats` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`title` text DEFAULT 'New chat' NOT NULL,
	`gateway_session_id` text NOT NULL,
	`model` text,
	`archived_at` integer,
	`last_message_at` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `chats_gateway_session_id_unique` ON `chats` (`gateway_session_id`);--> statement-breakpoint
CREATE INDEX `ix_chats_user` ON `chats` (`user_id`);--> statement-breakpoint
CREATE INDEX `ix_chats_user_lastmsg` ON `chats` (`user_id`,`last_message_at`);--> statement-breakpoint
CREATE TABLE `messages` (
	`id` text PRIMARY KEY NOT NULL,
	`chat_id` text NOT NULL,
	`user_id` text NOT NULL,
	`role` text NOT NULL,
	`content` text DEFAULT '' NOT NULL,
	`run_id` text,
	`status` text DEFAULT 'completed' NOT NULL,
	`error` text,
	`metadata` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`chat_id`) REFERENCES `chats`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `ix_messages_chat_created` ON `messages` (`chat_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `ix_messages_user` ON `messages` (`user_id`);--> statement-breakpoint
CREATE INDEX `ix_messages_run` ON `messages` (`run_id`);