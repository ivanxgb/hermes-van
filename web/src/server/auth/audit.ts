/**
 * Audit log emission. Append-only.
 *
 * Every authentication-relevant event lands here. Reads are scoped via
 * ScopedDb.audit.listForUser; admin global queries are deliberately not
 * exposed to product code.
 */
import { ulid } from "../lib/id";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as schema from "../db/schema";

type Db = BetterSQLite3Database<typeof schema>;

export type AuditEvent =
  | "user.created"
  | "credential.added"
  | "credential.removed"
  | "credential.renamed"
  | "login.ok"
  | "login.fail"
  | "login.no_user"
  | "logout.ok"
  | "session.revoked"
  | "session.revoke_all"
  | "recovery.used"
  | "recovery.fail"
  | "recovery.regenerated"
  | "setup.token_issued"
  | "setup.token_consumed"
  | "setup.token_expired";

export interface AuditEmitArgs {
  userId?: string | null;
  event: AuditEvent;
  ip?: string | null;
  userAgent?: string | null;
  metadata?: Record<string, unknown>;
}

export function emitAudit(db: Db, args: AuditEmitArgs): void {
  db.insert(schema.auditLog)
    .values({
      id: ulid(),
      userId: args.userId ?? null,
      event: args.event,
      ip: args.ip ?? null,
      userAgent: args.userAgent ?? null,
      metadata: args.metadata ? JSON.stringify(args.metadata) : null,
    })
    .run();
}
