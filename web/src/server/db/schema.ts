/**
 * Database schema. Drizzle ORM definitions for all hermes-van local tables.
 *
 * Trust boundary: every per-user table has a NOT NULL user_id FK. The
 * scoped query wrapper (./scoped.ts) enforces that no SELECT/UPDATE/DELETE
 * can run without a user_id filter on user-scoped tables.
 *
 * Conventions:
 * - Primary keys are ULIDs (text, 26 chars, lexicographic time-sortable).
 * - Timestamps are stored as INTEGER unix milliseconds.
 * - All FKs ON DELETE CASCADE so user deletion wipes cleanly.
 */
import { sql } from "drizzle-orm";
import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core";

// ────────────────────────────────────────────────────────────────────────
// users
// ────────────────────────────────────────────────────────────────────────
export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  username: text("username").notNull().unique(),
  displayName: text("display_name").notNull(),
  createdAt: integer("created_at").notNull().default(sql`(unixepoch() * 1000)`),
  updatedAt: integer("updated_at").notNull().default(sql`(unixepoch() * 1000)`),
});

// ────────────────────────────────────────────────────────────────────────
// webauthn_credentials
// One user can have multiple passkeys (laptop + phone + yubikey, etc).
// ────────────────────────────────────────────────────────────────────────
export const webauthnCredentials = sqliteTable(
  "webauthn_credentials",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    credentialId: text("credential_id").notNull().unique(),
    publicKey: text("public_key").notNull(), // base64url
    counter: integer("counter").notNull().default(0),
    transports: text("transports").notNull().default("[]"), // JSON array
    backedUp: integer("backed_up", { mode: "boolean" }).notNull().default(false),
    deviceType: text("device_type").notNull().default("unknown"),
    nickname: text("nickname"),
    lastUsedAt: integer("last_used_at"),
    createdAt: integer("created_at").notNull().default(sql`(unixepoch() * 1000)`),
  },
  (t) => ({
    userIdIdx: index("ix_webauthn_user").on(t.userId),
  }),
);

// ────────────────────────────────────────────────────────────────────────
// web_sessions
// Browser sessions (signed cookie). Idle timeout 24h, absolute 7d.
// ────────────────────────────────────────────────────────────────────────
export const webSessions = sqliteTable(
  "web_sessions",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: integer("created_at").notNull().default(sql`(unixepoch() * 1000)`),
    lastSeenAt: integer("last_seen_at").notNull().default(sql`(unixepoch() * 1000)`),
    expiresAt: integer("expires_at").notNull(),
    revokedAt: integer("revoked_at"),
    ip: text("ip"),
    userAgent: text("user_agent"),
    csrfTokenHash: text("csrf_token_hash").notNull(),
  },
  (t) => ({
    userIdIdx: index("ix_websessions_user").on(t.userId),
    expiresIdx: index("ix_websessions_expires").on(t.expiresAt),
  }),
);

// ────────────────────────────────────────────────────────────────────────
// recovery_codes
// One-time codes for account recovery if all passkeys lost.
// Stored as Argon2id hashes; raw codes are shown only on issuance.
// ────────────────────────────────────────────────────────────────────────
export const recoveryCodes = sqliteTable(
  "recovery_codes",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    codeHash: text("code_hash").notNull(),
    usedAt: integer("used_at"),
    createdAt: integer("created_at").notNull().default(sql`(unixepoch() * 1000)`),
  },
  (t) => ({
    userIdIdx: index("ix_recovery_user").on(t.userId),
  }),
);

// ────────────────────────────────────────────────────────────────────────
// audit_log
// Append-only. Every auth event lands here. Retained indefinitely.
// ────────────────────────────────────────────────────────────────────────
export const auditLog = sqliteTable(
  "audit_log",
  {
    id: text("id").primaryKey(),
    userId: text("user_id"), // nullable: pre-auth events
    ts: integer("ts").notNull().default(sql`(unixepoch() * 1000)`),
    event: text("event").notNull(),
    ip: text("ip"),
    userAgent: text("user_agent"),
    metadata: text("metadata"), // JSON
  },
  (t) => ({
    userTsIdx: index("ix_audit_user_ts").on(t.userId, t.ts),
    tsIdx: index("ix_audit_ts").on(t.ts),
  }),
);

// ────────────────────────────────────────────────────────────────────────
// setup_tokens
// One-time tokens emitted by the bootstrap CLI to allow first user
// registration. Self-destruct on use.
// ────────────────────────────────────────────────────────────────────────
export const setupTokens = sqliteTable("setup_tokens", {
  id: text("id").primaryKey(),
  tokenHash: text("token_hash").notNull(),
  expiresAt: integer("expires_at").notNull(),
  usedAt: integer("used_at"),
  createdAt: integer("created_at").notNull().default(sql`(unixepoch() * 1000)`),
});
