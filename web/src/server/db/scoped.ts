/**
 * Scoped query wrapper.
 *
 * Security boundary: every query against a user-scoped table MUST go
 * through this wrapper. The wrapper takes a userId at construction time
 * and refuses to issue any query without it.
 *
 * Why this isn't redundant with FKs:
 * - FKs prevent dangling references, not unauthorized reads.
 * - A bug like `.where(eq(creds.id, params.id))` (without userId) would
 *   leak any user's credential. The wrapper makes that impossible by
 *   construction: the only API surface is `forUser(id).webauthnCredentials.list()`,
 *   `.byId(credId)`, etc.
 *
 * Tables NOT scoped (admin/global):
 *   - users (looked up by username at login)
 *   - audit_log (append-only by anyone, scoped reads via dedicated method)
 *   - setup_tokens (bootstrap-only)
 *
 * Tests in scoped.test.ts verify:
 *   1. queries always include user_id filter
 *   2. cross-user reads return empty
 *   3. cross-user writes throw
 */
import { and, eq, gte, lte, sql } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema";

type Db = BetterSQLite3Database<typeof schema>;

// ─── Types ──────────────────────────────────────────────────────────────

type WebAuthnCred = typeof schema.webauthnCredentials.$inferSelect;
type NewWebAuthnCred = typeof schema.webauthnCredentials.$inferInsert;
type WebSession = typeof schema.webSessions.$inferSelect;
type NewWebSession = typeof schema.webSessions.$inferInsert;
type RecoveryCode = typeof schema.recoveryCodes.$inferSelect;
type NewRecoveryCode = typeof schema.recoveryCodes.$inferInsert;
type AuditEvent = typeof schema.auditLog.$inferSelect;
type PushSubscription = typeof schema.pushSubscriptions.$inferSelect;
type NewPushSubscription = typeof schema.pushSubscriptions.$inferInsert;
type Chat = typeof schema.chats.$inferSelect;
type NewChat = typeof schema.chats.$inferInsert;
type Message = typeof schema.messages.$inferSelect;
type NewMessage = typeof schema.messages.$inferInsert;
type ActiveRun = typeof schema.activeRuns.$inferSelect;
type NewActiveRun = typeof schema.activeRuns.$inferInsert;
type Attachment = typeof schema.attachments.$inferSelect;
type NewAttachment = typeof schema.attachments.$inferInsert;

// ─── Validation ─────────────────────────────────────────────────────────

function assertUserId(userId: string): void {
  if (!userId || typeof userId !== "string") {
    throw new Error("Scoped query requires non-empty userId");
  }
}

function assertOwnership(record: { userId: string } | undefined, userId: string): void {
  if (!record) return;
  if (record.userId !== userId) {
    throw new Error("Cross-user write attempted: ownership mismatch");
  }
}

// ─── Per-user scoped API ────────────────────────────────────────────────

export class ScopedDb {
  constructor(
    private readonly db: Db,
    private readonly userId: string,
  ) {
    assertUserId(userId);
  }

  // ── webauthn credentials ──
  webauthnCredentials = {
    list: (): WebAuthnCred[] => {
      return this.db
        .select()
        .from(schema.webauthnCredentials)
        .where(eq(schema.webauthnCredentials.userId, this.userId))
        .all();
    },

    byId: (id: string): WebAuthnCred | undefined => {
      return this.db
        .select()
        .from(schema.webauthnCredentials)
        .where(
          and(
            eq(schema.webauthnCredentials.userId, this.userId),
            eq(schema.webauthnCredentials.id, id),
          ),
        )
        .get();
    },

    byCredentialId: (credentialId: string): WebAuthnCred | undefined => {
      return this.db
        .select()
        .from(schema.webauthnCredentials)
        .where(
          and(
            eq(schema.webauthnCredentials.userId, this.userId),
            eq(schema.webauthnCredentials.credentialId, credentialId),
          ),
        )
        .get();
    },

    insert: (data: Omit<NewWebAuthnCred, "userId">): WebAuthnCred => {
      const row: NewWebAuthnCred = { ...data, userId: this.userId };
      this.db.insert(schema.webauthnCredentials).values(row).run();
      const inserted = this.webauthnCredentials.byId(row.id);
      if (!inserted) throw new Error("Insert verification failed");
      return inserted;
    },

    updateCounter: (id: string, counter: number, lastUsedAt: number): void => {
      const existing = this.webauthnCredentials.byId(id);
      assertOwnership(existing, this.userId);
      this.db
        .update(schema.webauthnCredentials)
        .set({ counter, lastUsedAt })
        .where(
          and(
            eq(schema.webauthnCredentials.userId, this.userId),
            eq(schema.webauthnCredentials.id, id),
          ),
        )
        .run();
    },

    delete: (id: string): void => {
      const existing = this.webauthnCredentials.byId(id);
      assertOwnership(existing, this.userId);
      this.db
        .delete(schema.webauthnCredentials)
        .where(
          and(
            eq(schema.webauthnCredentials.userId, this.userId),
            eq(schema.webauthnCredentials.id, id),
          ),
        )
        .run();
    },
  };

  // ── web sessions ──
  webSessions = {
    list: (): WebSession[] => {
      return this.db
        .select()
        .from(schema.webSessions)
        .where(eq(schema.webSessions.userId, this.userId))
        .all();
    },

    byId: (id: string): WebSession | undefined => {
      return this.db
        .select()
        .from(schema.webSessions)
        .where(and(eq(schema.webSessions.userId, this.userId), eq(schema.webSessions.id, id)))
        .get();
    },

    insert: (data: Omit<NewWebSession, "userId">): WebSession => {
      const row: NewWebSession = { ...data, userId: this.userId };
      this.db.insert(schema.webSessions).values(row).run();
      const inserted = this.webSessions.byId(row.id);
      if (!inserted) throw new Error("Insert verification failed");
      return inserted;
    },

    touch: (id: string, lastSeenAt: number): void => {
      this.db
        .update(schema.webSessions)
        .set({ lastSeenAt })
        .where(and(eq(schema.webSessions.userId, this.userId), eq(schema.webSessions.id, id)))
        .run();
    },

    revoke: (id: string): void => {
      const now = Date.now();
      this.db
        .update(schema.webSessions)
        .set({ revokedAt: now })
        .where(and(eq(schema.webSessions.userId, this.userId), eq(schema.webSessions.id, id)))
        .run();
    },

    revokeAll: (): number => {
      const now = Date.now();
      const res = this.db
        .update(schema.webSessions)
        .set({ revokedAt: now })
        .where(eq(schema.webSessions.userId, this.userId))
        .run();
      return res.changes;
    },
  };

  // ── recovery codes ──
  recoveryCodes = {
    listUnused: (): RecoveryCode[] => {
      return this.db
        .select()
        .from(schema.recoveryCodes)
        .where(
          and(
            eq(schema.recoveryCodes.userId, this.userId),
            sql`${schema.recoveryCodes.usedAt} IS NULL`,
          ),
        )
        .all();
    },

    insertMany: (codes: Omit<NewRecoveryCode, "userId">[]): void => {
      if (!codes.length) return;
      const rows: NewRecoveryCode[] = codes.map((c) => ({ ...c, userId: this.userId }));
      this.db.insert(schema.recoveryCodes).values(rows).run();
    },

    markUsed: (id: string): void => {
      const now = Date.now();
      this.db
        .update(schema.recoveryCodes)
        .set({ usedAt: now })
        .where(
          and(eq(schema.recoveryCodes.userId, this.userId), eq(schema.recoveryCodes.id, id)),
        )
        .run();
    },

    deleteAll: (): void => {
      this.db
        .delete(schema.recoveryCodes)
        .where(eq(schema.recoveryCodes.userId, this.userId))
        .run();
    },
  };

  // ── audit (scoped reads) ──
  audit = {
    listForUser: (opts: { since?: number; until?: number; limit?: number } = {}): AuditEvent[] => {
      const conds = [eq(schema.auditLog.userId, this.userId)];
      if (opts.since !== undefined) conds.push(gte(schema.auditLog.ts, opts.since));
      if (opts.until !== undefined) conds.push(lte(schema.auditLog.ts, opts.until));
      let q = this.db
        .select()
        .from(schema.auditLog)
        .where(and(...conds))
        .orderBy(sql`${schema.auditLog.ts} DESC`);
      if (opts.limit !== undefined) {
        q = q.limit(opts.limit) as typeof q;
      }
      return q.all();
    },
  };

  // ── push subscriptions ──
  pushSubscriptions = {
    list: (): PushSubscription[] => {
      return this.db
        .select()
        .from(schema.pushSubscriptions)
        .where(eq(schema.pushSubscriptions.userId, this.userId))
        .all();
    },

    byEndpoint: (endpoint: string): PushSubscription | undefined => {
      return this.db
        .select()
        .from(schema.pushSubscriptions)
        .where(
          and(
            eq(schema.pushSubscriptions.userId, this.userId),
            eq(schema.pushSubscriptions.endpoint, endpoint),
          ),
        )
        .get();
    },

    upsert: (data: Omit<NewPushSubscription, "userId">): PushSubscription => {
      const existing = this.pushSubscriptions.byEndpoint(data.endpoint);
      if (existing) {
        this.db
          .update(schema.pushSubscriptions)
          .set({
            p256dh: data.p256dh,
            auth: data.auth,
            userAgent: data.userAgent ?? existing.userAgent,
            lastSeenAt: Date.now(),
            failedCount: 0,
          })
          .where(
            and(
              eq(schema.pushSubscriptions.userId, this.userId),
              eq(schema.pushSubscriptions.id, existing.id),
            ),
          )
          .run();
        const refreshed = this.pushSubscriptions.byEndpoint(data.endpoint);
        if (!refreshed) throw new Error("Upsert verification failed");
        return refreshed;
      }
      const row: NewPushSubscription = { ...data, userId: this.userId };
      this.db.insert(schema.pushSubscriptions).values(row).run();
      const inserted = this.pushSubscriptions.byEndpoint(data.endpoint);
      if (!inserted) throw new Error("Insert verification failed");
      return inserted;
    },

    deleteByEndpoint: (endpoint: string): void => {
      this.db
        .delete(schema.pushSubscriptions)
        .where(
          and(
            eq(schema.pushSubscriptions.userId, this.userId),
            eq(schema.pushSubscriptions.endpoint, endpoint),
          ),
        )
        .run();
    },

    incrementFail: (id: string): void => {
      this.db
        .update(schema.pushSubscriptions)
        .set({
          failedCount: sql`${schema.pushSubscriptions.failedCount} + 1`,
        })
        .where(
          and(
            eq(schema.pushSubscriptions.userId, this.userId),
            eq(schema.pushSubscriptions.id, id),
          ),
        )
        .run();
    },
  };

  // ── chats ──
  chats = {
    list: (opts: { includeArchived?: boolean; limit?: number } = {}): Chat[] => {
      const conds = [eq(schema.chats.userId, this.userId)];
      if (!opts.includeArchived) {
        conds.push(sql`${schema.chats.archivedAt} IS NULL`);
      }
      let q = this.db
        .select()
        .from(schema.chats)
        .where(and(...conds))
        .orderBy(sql`COALESCE(${schema.chats.lastMessageAt}, ${schema.chats.createdAt}) DESC`);
      if (opts.limit !== undefined) q = q.limit(opts.limit) as typeof q;
      return q.all();
    },

    byId: (id: string): Chat | undefined => {
      return this.db
        .select()
        .from(schema.chats)
        .where(and(eq(schema.chats.userId, this.userId), eq(schema.chats.id, id)))
        .get();
    },

    insert: (data: Omit<NewChat, "userId">): Chat => {
      const row: NewChat = { ...data, userId: this.userId };
      this.db.insert(schema.chats).values(row).run();
      const inserted = this.chats.byId(row.id);
      if (!inserted) throw new Error("Insert verification failed");
      return inserted;
    },

    rename: (id: string, title: string): void => {
      const existing = this.chats.byId(id);
      assertOwnership(existing, this.userId);
      this.db
        .update(schema.chats)
        .set({ title, updatedAt: Date.now() })
        .where(and(eq(schema.chats.userId, this.userId), eq(schema.chats.id, id)))
        .run();
    },

    archive: (id: string): void => {
      const existing = this.chats.byId(id);
      assertOwnership(existing, this.userId);
      this.db
        .update(schema.chats)
        .set({ archivedAt: Date.now(), updatedAt: Date.now() })
        .where(and(eq(schema.chats.userId, this.userId), eq(schema.chats.id, id)))
        .run();
    },

    unarchive: (id: string): void => {
      const existing = this.chats.byId(id);
      assertOwnership(existing, this.userId);
      this.db
        .update(schema.chats)
        .set({ archivedAt: null, updatedAt: Date.now() })
        .where(and(eq(schema.chats.userId, this.userId), eq(schema.chats.id, id)))
        .run();
    },

    setModel: (id: string, model: string | null): void => {
      const existing = this.chats.byId(id);
      assertOwnership(existing, this.userId);
      this.db
        .update(schema.chats)
        .set({ model, updatedAt: Date.now() })
        .where(and(eq(schema.chats.userId, this.userId), eq(schema.chats.id, id)))
        .run();
    },

    delete: (id: string): void => {
      const existing = this.chats.byId(id);
      assertOwnership(existing, this.userId);
      this.db
        .delete(schema.chats)
        .where(and(eq(schema.chats.userId, this.userId), eq(schema.chats.id, id)))
        .run();
    },

    touchLastMessage: (id: string, at: number): void => {
      this.db
        .update(schema.chats)
        .set({ lastMessageAt: at, updatedAt: at })
        .where(and(eq(schema.chats.userId, this.userId), eq(schema.chats.id, id)))
        .run();
    },
  };

  // ── messages ──
  messages = {
    listForChat: (chatId: string, opts: { limit?: number; before?: number } = {}): Message[] => {
      const conds = [
        eq(schema.messages.userId, this.userId),
        eq(schema.messages.chatId, chatId),
      ];
      if (opts.before !== undefined) conds.push(lte(schema.messages.createdAt, opts.before));
      let q = this.db
        .select()
        .from(schema.messages)
        .where(and(...conds))
        .orderBy(sql`${schema.messages.createdAt} ASC, ${schema.messages.id} ASC`);
      if (opts.limit !== undefined) q = q.limit(opts.limit) as typeof q;
      return q.all();
    },

    /**
     * Full-text search over the user's message log via the FTS5 mirror
     * table populated by triggers in migration 0002. Returns up to
     * `limit` rows ordered by FTS5 rank (most relevant first).
     *
     * The query is passed to FTS5 as-is, so the caller can use the full
     * MATCH grammar (prefix*, "phrase queries", AND/OR, NEAR/N, etc.).
     * If FTS5 rejects the input as a malformed query (e.g. unbalanced
     * quotes), we catch the error and return an empty array.
     */
    search: (
      query: string,
      opts: { limit?: number; chatId?: string } = {},
    ): Array<Message & { snippet: string }> => {
      const trimmed = query.trim();
      if (!trimmed) return [];
      const limit = Math.min(Math.max(1, opts.limit ?? 50), 200);
      try {
        const chatFilter = opts.chatId
          ? sql`AND m.chat_id = ${opts.chatId}`
          : sql``;
        const rows = this.db.all<Record<string, unknown>>(sql`
          SELECT m.id, m.chat_id, m.user_id, m.role, m.content,
                 m.run_id, m.status, m.error, m.metadata,
                 m.created_at, m.updated_at,
                 snippet(messages_fts, -1, '[[', ']]', '…', 12) AS snippet
          FROM messages_fts f
          JOIN messages m ON m.id = f.message_id
          WHERE messages_fts MATCH ${trimmed}
            AND m.user_id = ${this.userId}
            ${chatFilter}
          ORDER BY rank
          LIMIT ${limit}
        `);
        return rows.map((row) => ({
          id: String(row["id"]),
          chatId: String(row["chat_id"]),
          userId: String(row["user_id"]),
          role: row["role"] as Message["role"],
          content: String(row["content"] ?? ""),
          runId: (row["run_id"] as string | null) ?? null,
          status: (row["status"] as Message["status"]) ?? "completed",
          error: (row["error"] as string | null) ?? null,
          metadata: (row["metadata"] as string | null) ?? null,
          createdAt: Number(row["created_at"] ?? 0),
          updatedAt: Number(row["updated_at"] ?? 0),
          snippet: String(row["snippet"] ?? ""),
        }));
      } catch {
        return [];
      }
    },

    byId: (id: string): Message | undefined => {
      return this.db
        .select()
        .from(schema.messages)
        .where(and(eq(schema.messages.userId, this.userId), eq(schema.messages.id, id)))
        .get();
    },

    insert: (data: Omit<NewMessage, "userId">): Message => {
      const row: NewMessage = { ...data, userId: this.userId };
      this.db.insert(schema.messages).values(row).run();
      const inserted = this.messages.byId(row.id);
      if (!inserted) throw new Error("Insert verification failed");
      return inserted;
    },

    appendDelta: (id: string, delta: string): void => {
      const existing = this.messages.byId(id);
      assertOwnership(existing, this.userId);
      this.db
        .update(schema.messages)
        .set({
          content: sql`${schema.messages.content} || ${delta}`,
          updatedAt: Date.now(),
        })
        .where(and(eq(schema.messages.userId, this.userId), eq(schema.messages.id, id)))
        .run();
    },

    finalize: (id: string, opts: { status: Message["status"]; error?: string; metadata?: string }): void => {
      const existing = this.messages.byId(id);
      assertOwnership(existing, this.userId);
      this.db
        .update(schema.messages)
        .set({
          status: opts.status,
          error: opts.error ?? null,
          metadata: opts.metadata ?? null,
          updatedAt: Date.now(),
        })
        .where(and(eq(schema.messages.userId, this.userId), eq(schema.messages.id, id)))
        .run();
    },
  };

  // ── active runs ──
  activeRuns = {
    byId: (id: string): ActiveRun | undefined => {
      return this.db
        .select()
        .from(schema.activeRuns)
        .where(and(eq(schema.activeRuns.userId, this.userId), eq(schema.activeRuns.id, id)))
        .get();
    },

    byUpstreamId: (upstreamRunId: string): ActiveRun | undefined => {
      return this.db
        .select()
        .from(schema.activeRuns)
        .where(
          and(
            eq(schema.activeRuns.userId, this.userId),
            eq(schema.activeRuns.upstreamRunId, upstreamRunId),
          ),
        )
        .get();
    },

    listForChat: (chatId: string): ActiveRun[] => {
      return this.db
        .select()
        .from(schema.activeRuns)
        .where(
          and(eq(schema.activeRuns.userId, this.userId), eq(schema.activeRuns.chatId, chatId)),
        )
        .orderBy(sql`${schema.activeRuns.startedAt} DESC`)
        .all();
    },

    insert: (data: Omit<NewActiveRun, "userId">): ActiveRun => {
      const row: NewActiveRun = { ...data, userId: this.userId };
      this.db.insert(schema.activeRuns).values(row).run();
      const inserted = this.activeRuns.byId(row.id);
      if (!inserted) throw new Error("Insert verification failed");
      return inserted;
    },

    setStatus: (
      id: string,
      status: ActiveRun["status"],
      opts: { error?: string; finishedAt?: number } = {},
    ): void => {
      const existing = this.activeRuns.byId(id);
      assertOwnership(existing, this.userId);
      this.db
        .update(schema.activeRuns)
        .set({
          status,
          error: opts.error ?? null,
          finishedAt: opts.finishedAt ?? null,
        })
        .where(and(eq(schema.activeRuns.userId, this.userId), eq(schema.activeRuns.id, id)))
        .run();
    },
  };

  /** ─── attachments (Phase 6.D) ─────────────────────────────── */
  attachments = {
    byId: (id: string): Attachment | undefined => {
      return this.db
        .select()
        .from(schema.attachments)
        .where(
          and(eq(schema.attachments.userId, this.userId), eq(schema.attachments.id, id)),
        )
        .get();
    },

    bySha256: (sha256: string): Attachment | undefined => {
      return this.db
        .select()
        .from(schema.attachments)
        .where(
          and(
            eq(schema.attachments.userId, this.userId),
            eq(schema.attachments.sha256, sha256),
          ),
        )
        .get();
    },

    listForChat: (chatId: string): Attachment[] => {
      return this.db
        .select()
        .from(schema.attachments)
        .where(
          and(
            eq(schema.attachments.userId, this.userId),
            eq(schema.attachments.chatId, chatId),
          ),
        )
        .orderBy(sql`${schema.attachments.createdAt} DESC`)
        .all();
    },

    listAll: (limit = 100): Attachment[] => {
      return this.db
        .select()
        .from(schema.attachments)
        .where(eq(schema.attachments.userId, this.userId))
        .orderBy(sql`${schema.attachments.createdAt} DESC`)
        .limit(limit)
        .all();
    },

    insert: (data: Omit<NewAttachment, "userId">): Attachment => {
      const row: NewAttachment = { ...data, userId: this.userId };
      this.db.insert(schema.attachments).values(row).run();
      const inserted = this.attachments.byId(row.id);
      if (!inserted) throw new Error("Attachment insert verification failed");
      return inserted;
    },

    delete: (id: string): boolean => {
      const existing = this.attachments.byId(id);
      if (!existing) return false;
      assertOwnership(existing, this.userId);
      this.db
        .delete(schema.attachments)
        .where(
          and(
            eq(schema.attachments.userId, this.userId),
            eq(schema.attachments.id, id),
          ),
        )
        .run();
      return true;
    },

    /**
     * Refcount across all users for a given sha256. Used by GC: a
     * blob is safe to remove from disk only when refcount drops to 0.
     * Crosses the user boundary by design — refcount is a property of
     * the storage layer, not of the user. Returns 0 for unknown hashes.
     */
    refcountGlobal: (sha256: string): number => {
      const r = this.db
        .select({ c: sql<number>`count(*)` })
        .from(schema.attachments)
        .where(eq(schema.attachments.sha256, sha256))
        .get();
      return r?.c ?? 0;
    },
  };
}

export function forUser(db: Db, userId: string): ScopedDb {
  return new ScopedDb(db, userId);
}
