/**
 * Audit log emission. Append-only.
 *
 * Every authentication-relevant event lands here. Reads are scoped via
 * ScopedDb.audit.listForUser; admin global queries are deliberately not
 * exposed to product code.
 *
 * High-severity events (login.fail, recovery.fail, session.revoke_all,
 * setup.token_expired) ALSO fire a fire-and-forget alert webhook when
 * HERMES_VAN_ALERT_WEBHOOK is configured. The alert is best-effort and
 * never blocks the audit insert.
 */
import { ulid } from "../lib/id";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as schema from "../db/schema";
import { fireAlert, type AlertSeverity } from "../lib/alerts";

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

/**
 * Severity table — drives whether a webhook alert is fired and how
 * the receiver should route it.
 *
 * critical: somebody is being attacked / lost their device.
 * warning:  something unexpected happened, worth eyes-on.
 * info:     normal operation, only useful for audit trails.
 */
const SEVERITY: Record<AuditEvent, AlertSeverity | null> = {
  "user.created": null,
  "credential.added": null,
  "credential.removed": "warning",
  "credential.renamed": null,
  "login.ok": null,
  "login.fail": "warning",
  "login.no_user": null,
  "logout.ok": null,
  "session.revoked": null,
  "session.revoke_all": "critical",
  "recovery.used": "warning",
  "recovery.fail": "critical",
  "recovery.regenerated": "warning",
  "setup.token_issued": null,
  "setup.token_consumed": null,
  "setup.token_expired": "warning",
};

const HEADLINES: Partial<Record<AuditEvent, string>> = {
  "credential.removed": "Credential removed",
  "login.fail": "Failed login attempt",
  "session.revoke_all": "All sessions revoked",
  "recovery.used": "Recovery code used",
  "recovery.fail": "Recovery code attempt failed",
  "recovery.regenerated": "Recovery codes regenerated",
  "setup.token_expired": "Setup token expired without use",
};

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

  const severity = SEVERITY[args.event];
  if (severity) {
    fireAlert({
      event: args.event,
      severity,
      title: HEADLINES[args.event] ?? args.event,
      metadata: {
        userId: args.userId ?? null,
        ip: args.ip ?? null,
        userAgent: args.userAgent?.slice(0, 200) ?? null,
        ...(args.metadata ?? {}),
      },
    });
  }
}
