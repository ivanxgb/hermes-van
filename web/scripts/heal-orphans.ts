/**
 * Heal hermes-van DB after an interrupted run/stream.
 *
 * Two cleanups:
 *
 * 1. Orphan messages — rows with status='streaming' or 'pending' that
 *    haven't been touched in > 30s. They were mid-flight when the
 *    process died. Mark them failed with a clear error so the UI
 *    stops spinning.
 *
 * 2. Stuck active_runs — rows in 'queued', 'running', or
 *    'waiting_for_approval' whose `startedAt` is > 10 minutes old.
 *    These are zombies; mark them cancelled and stamp finishedAt.
 *
 * Idempotent: running on a clean DB is a no-op.
 *
 * Usage:
 *   npm run hermes-van:heal
 *   npm run hermes-van:heal -- --dry-run        # show what would change
 *   npm run hermes-van:heal -- --max-age=120    # override message age (s)
 */
import "dotenv/config";
import { and, eq, lt, or } from "drizzle-orm";
import { getDb, closeDb } from "../src/server/db";
import { messages, activeRuns } from "../src/server/db/schema";
import { logger } from "../src/server/lib/logger";

interface Args {
  dryRun: boolean;
  messageMaxAgeMs: number;
  runMaxAgeMs: number;
}

function parseArgs(): Args {
  const out: Args = {
    dryRun: false,
    messageMaxAgeMs: 30_000,         // 30s
    runMaxAgeMs: 10 * 60 * 1000,      // 10 min
  };
  for (const a of process.argv.slice(2)) {
    if (a === "--dry-run") out.dryRun = true;
    else if (a.startsWith("--max-age=")) {
      const sec = Number(a.slice("--max-age=".length));
      if (Number.isFinite(sec) && sec > 0) out.messageMaxAgeMs = sec * 1000;
    }
  }
  return out;
}

function heal(args: Args): void {
  const db = getDb();
  const now = Date.now();

  // ── 1. orphan messages ──
  const messageCutoff = now - args.messageMaxAgeMs;
  const orphans = db
    .select({ id: messages.id, chatId: messages.chatId, status: messages.status, updatedAt: messages.updatedAt })
    .from(messages)
    .where(
      and(
        or(eq(messages.status, "streaming"), eq(messages.status, "pending")),
        lt(messages.updatedAt, messageCutoff),
      ),
    )
    .all();

  if (orphans.length > 0) {
    logger.info({ count: orphans.length, cutoff: messageCutoff }, "found orphan messages");
    for (const o of orphans) {
      logger.info(
        { id: o.id, chatId: o.chatId, status: o.status, ageMs: now - o.updatedAt },
        "  orphan",
      );
      if (!args.dryRun) {
        db.update(messages)
          .set({
            status: "failed",
            error: "Server restarted; stream interrupted before completion.",
            updatedAt: now,
          })
          .where(eq(messages.id, o.id))
          .run();
      }
    }
  }

  // ── 2. stuck active_runs ──
  const runCutoff = now - args.runMaxAgeMs;
  const stuckRuns = db
    .select({ id: activeRuns.id, chatId: activeRuns.chatId, status: activeRuns.status, startedAt: activeRuns.startedAt })
    .from(activeRuns)
    .where(
      and(
        or(
          eq(activeRuns.status, "queued"),
          eq(activeRuns.status, "running"),
          eq(activeRuns.status, "waiting_for_approval"),
          eq(activeRuns.status, "stopping"),
        ),
        lt(activeRuns.startedAt, runCutoff),
      ),
    )
    .all();

  if (stuckRuns.length > 0) {
    logger.info({ count: stuckRuns.length }, "found stuck active_runs");
    for (const r of stuckRuns) {
      logger.info(
        { id: r.id, chatId: r.chatId, status: r.status, ageMs: now - r.startedAt },
        "  stuck",
      );
      if (!args.dryRun) {
        db.update(activeRuns)
          .set({
            status: "cancelled",
            error: "Zombie run cleared by heal-orphans.",
            finishedAt: now,
          })
          .where(eq(activeRuns.id, r.id))
          .run();
      }
    }
  }

  if (orphans.length === 0 && stuckRuns.length === 0) {
    logger.info("nothing to heal");
  } else {
    logger.info(
      {
        orphanMessages: orphans.length,
        stuckRuns: stuckRuns.length,
        dryRun: args.dryRun,
      },
      args.dryRun ? "dry run — no changes applied" : "heal complete",
    );
  }
}

function main() {
  try {
    heal(parseArgs());
  } catch (err) {
    logger.error({ err }, "heal failed");
    process.exitCode = 1;
  } finally {
    closeDb();
  }
}

main();
