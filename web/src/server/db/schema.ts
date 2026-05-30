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

// ────────────────────────────────────────────────────────────────────────
// chats
// User-owned conversation containers. The chat's ID is what the client
// sees; it is mapped to a server-side gateway session_id (1:1) so the
// upstream agent retains memory across runs without exposing gateway IDs
// to the browser.
// ────────────────────────────────────────────────────────────────────────
export const chats = sqliteTable(
  "chats",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    title: text("title").notNull().default("New chat"),
    // Stable opaque id sent to gateway as session_id. We never expose
    // upstream run_ids; this gives the agent persistent memory while
    // keeping the client decoupled from gateway internals.
    gatewaySessionId: text("gateway_session_id").notNull().unique(),
    model: text("model"), // null → default
    archivedAt: integer("archived_at"),
    lastMessageAt: integer("last_message_at"),
    createdAt: integer("created_at").notNull().default(sql`(unixepoch() * 1000)`),
    updatedAt: integer("updated_at").notNull().default(sql`(unixepoch() * 1000)`),
  },
  (t) => ({
    userIdx: index("ix_chats_user").on(t.userId),
    userLastMsgIdx: index("ix_chats_user_lastmsg").on(t.userId, t.lastMessageAt),
  }),
);

// ────────────────────────────────────────────────────────────────────────
// messages
// Append-only log of user/assistant turns rendered in the UI. Streaming
// deltas are accumulated server-side; the row is finalized when the run
// completes (or marked failed/cancelled).
//
// `runId` references active_runs.id (local ULID, never the upstream
// gateway run_id). `status` distinguishes streaming → completed → failed.
// ────────────────────────────────────────────────────────────────────────
export const messages = sqliteTable(
  "messages",
  {
    id: text("id").primaryKey(),
    chatId: text("chat_id")
      .notNull()
      .references(() => chats.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: text("role", { enum: ["user", "assistant", "system", "tool"] }).notNull(),
    content: text("content").notNull().default(""),
    // local run id (ULID) — null for user messages
    runId: text("run_id"),
    status: text("status", {
      enum: ["pending", "streaming", "completed", "failed", "cancelled"],
    })
      .notNull()
      .default("completed"),
    error: text("error"),
    metadata: text("metadata"), // JSON: { reasoning?, tool_calls?, usage? }
    createdAt: integer("created_at").notNull().default(sql`(unixepoch() * 1000)`),
    updatedAt: integer("updated_at").notNull().default(sql`(unixepoch() * 1000)`),
  },
  (t) => ({
    chatCreatedIdx: index("ix_messages_chat_created").on(t.chatId, t.createdAt),
    userIdx: index("ix_messages_user").on(t.userId),
    runIdx: index("ix_messages_run").on(t.runId),
  }),
);

// ────────────────────────────────────────────────────────────────────────
// active_runs
// SSE bridge state. The browser sees only `id` (a local ULID); the
// `upstreamRunId` returned by POST /v1/runs is kept server-side so the
// gateway run is never exposed to clients (capability isolation).
//
// Lifecycle: queued → running → (waiting_for_approval ↔ running) →
//   completed | failed | cancelled
// Rows are kept after completion for ~24h then GC'd; the message they
// produced lives on in `messages` regardless.
// ────────────────────────────────────────────────────────────────────────
export const activeRuns = sqliteTable(
  "active_runs",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    chatId: text("chat_id")
      .notNull()
      .references(() => chats.id, { onDelete: "cascade" }),
    messageId: text("message_id")
      .notNull()
      .references(() => messages.id, { onDelete: "cascade" }),
    upstreamRunId: text("upstream_run_id").notNull(),
    status: text("status", {
      enum: [
        "queued",
        "running",
        "waiting_for_approval",
        "stopping",
        "completed",
        "failed",
        "cancelled",
      ],
    })
      .notNull()
      .default("queued"),
    error: text("error"),
    startedAt: integer("started_at").notNull().default(sql`(unixepoch() * 1000)`),
    finishedAt: integer("finished_at"),
  },
  (t) => ({
    userIdx: index("ix_runs_user").on(t.userId),
    chatIdx: index("ix_runs_chat").on(t.chatId),
    upstreamIdx: index("ix_runs_upstream").on(t.upstreamRunId),
  }),
);
