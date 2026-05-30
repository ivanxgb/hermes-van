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
}

export function forUser(db: Db, userId: string): ScopedDb {
  return new ScopedDb(db, userId);
}
