/**
 * Import a Hermes session (Telegram, CLI, or any source from
 * ~/.hermes/state.db) into hermes-van as a chat.
 *
 * Usage:
 *   npm run hermes-van:import -- --session=20260531_040244_5e0bed54
 *   npm run hermes-van:import -- --session=20260531_040244_5e0bed54 --user=ivan
 *   npm run hermes-van:import -- --session=20260531_040244_5e0bed54 --replace
 *
 * Mapping rules:
 * - chat.gatewaySessionId = `imported:${session_id}` (idempotency key)
 * - chat.title             = sessions.title (or "Imported · <id>")
 * - chat.model             = sessions.model
 * - chat.lastMessageAt     = max(message.timestamp) × 1000
 * - chat.createdAt         = sessions.started_at × 1000
 *
 * Messages:
 * - role=user         → role=user, status=completed
 * - role=assistant + content non-empty → role=assistant, status=completed
 *                       metadata.reasoning = reasoning_content if present
 * - role=tool         → SKIPPED (rendered inline in assistant text already
 *                       in most cases; full tool stream import is Phase B)
 * - role=session_meta → SKIPPED
 *
 * Idempotency: re-running for the same session_id is a no-op unless
 * --replace is passed (deletes the existing imported chat first).
 */
import "dotenv/config";
import { existsSync } from "node:fs";
import Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import { getDb, getRawDb, closeDb } from "../src/server/db";
import { chats, messages, users } from "../src/server/db/schema";
import { ulid } from "../src/server/lib/id";
import { logger } from "../src/server/lib/logger";

interface Args {
  session: string;
  user?: string;
  replace: boolean;
  source: string;
}

function parseArgs(): Args {
  const out: Args = {
    session: "",
    replace: false,
    source: process.env.HERMES_STATE_DB ?? `${process.env.HOME}/.hermes/state.db`,
  };
  for (const a of process.argv.slice(2)) {
    if (a.startsWith("--session=")) out.session = a.slice("--session=".length);
    else if (a.startsWith("--user=")) out.user = a.slice("--user=".length);
    else if (a === "--replace") out.replace = true;
    else if (a.startsWith("--source=")) out.source = a.slice("--source=".length);
  }
  if (!out.session) {
    console.error("usage: import-telegram --session=<state_session_id> [--user=<username>] [--replace]");
    process.exit(2);
  }
  return out;
}

interface SourceSession {
  id: string;
  source: string;
  title: string | null;
  model: string | null;
  started_at: number;
  ended_at: number | null;
  message_count: number;
}

interface SourceMessage {
  id: number;
  role: string;
  content: string | null;
  reasoning_content: string | null;
  tool_calls: string | null;
  tool_name: string | null;
  timestamp: number;
}

function readSource(args: Args): { session: SourceSession; messages: SourceMessage[] } {
  if (!existsSync(args.source)) {
    throw new Error(`Source DB not found: ${args.source}`);
  }
  // Open read-only — never mutate the source.
  const src = new Database(args.source, { readonly: true, fileMustExist: true });
  try {
    const session = src
      .prepare(
        `SELECT id, source, title, model, started_at, ended_at, message_count
         FROM sessions WHERE id = ?`,
      )
      .get(args.session) as SourceSession | undefined;
    if (!session) {
      throw new Error(`Session not found in source DB: ${args.session}`);
    }
    const rows = src
      .prepare(
        `SELECT id, role, content, reasoning_content, tool_calls, tool_name, timestamp
         FROM messages
         WHERE session_id = ?
         ORDER BY timestamp ASC, id ASC`,
      )
      .all(args.session) as SourceMessage[];
    return { session, messages: rows };
  } finally {
    src.close();
  }
}

function pickUser(username?: string): { id: string; username: string } {
  const db = getDb();
  if (username) {
    const u = db
      .select({ id: users.id, username: users.username })
      .from(users)
      .where(eq(users.username, username))
      .all();
    if (u.length === 0) throw new Error(`User not found: ${username}`);
    return u[0];
  }
  // No username given → only one user must exist.
  const all = db.select({ id: users.id, username: users.username }).from(users).all();
  if (all.length === 0) throw new Error("No users in target DB");
  if (all.length > 1) {
    throw new Error(
      `Multiple users in target DB (${all.map((u) => u.username).join(", ")}); pass --user=<name>`,
    );
  }
  return all[0];
}

function importSession(args: Args): void {
  const { session, messages: srcMessages } = readSource(args);
  const user = pickUser(args.user);
  const db = getDb();
  const raw = getRawDb();

  const gatewaySessionId = `imported:${session.id}`;
  const existing = db
    .select()
    .from(chats)
    .where(eq(chats.gatewaySessionId, gatewaySessionId))
    .all();

  if (existing.length > 0) {
    if (!args.replace) {
      logger.info(
        { sessionId: session.id, chatId: existing[0].id },
        "already imported (pass --replace to overwrite)",
      );
      return;
    }
    // Cascade deletes messages via FK ON DELETE CASCADE.
    db.delete(chats).where(eq(chats.id, existing[0].id)).run();
    logger.info({ chatId: existing[0].id }, "removed prior import");
  }

  // Single transaction so partial imports don't leak.
  const tx = raw.transaction(() => {
    const chatId = ulid();
    const startedMs = Math.round(session.started_at * 1000);
    const lastMs =
      srcMessages.length > 0
        ? Math.round(srcMessages[srcMessages.length - 1].timestamp * 1000)
        : startedMs;
    const title =
      session.title?.trim() ||
      `Imported · ${session.source} · ${session.id.slice(0, 8)}`;

    db.insert(chats)
      .values({
        id: chatId,
        userId: user.id,
        title,
        gatewaySessionId,
        model: session.model,
        archivedAt: null,
        lastMessageAt: lastMs,
        createdAt: startedMs,
        updatedAt: lastMs,
      })
      .run();

    let imported = 0;
    let skipped = 0;
    for (const m of srcMessages) {
      if (m.role === "session_meta" || m.role === "tool") {
        skipped++;
        continue;
      }
      if (m.role !== "user" && m.role !== "assistant") {
        skipped++;
        continue;
      }
      const content = (m.content ?? "").trim();
      if (!content) {
        // Empty assistant messages are tool-call-only turns — skip.
        skipped++;
        continue;
      }
      const ts = Math.round(m.timestamp * 1000);
      const metadata =
        m.reasoning_content || m.tool_calls
          ? JSON.stringify({
              reasoning: m.reasoning_content || undefined,
              toolCalls: m.tool_calls ? safeJSON(m.tool_calls) : undefined,
              imported: true,
            })
          : null;

      db.insert(messages)
        .values({
          id: ulid(),
          chatId,
          userId: user.id,
          role: m.role as "user" | "assistant",
          content,
          runId: null,
          status: "completed",
          error: null,
          metadata,
          createdAt: ts,
          updatedAt: ts,
        })
        .run();
      imported++;
    }

    logger.info(
      {
        chatId,
        sessionId: session.id,
        title,
        imported,
        skipped,
        sourceTotal: srcMessages.length,
      },
      "imported",
    );
  });

  tx();
}

function safeJSON(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

function main() {
  const args = parseArgs();
  try {
    importSession(args);
  } catch (err) {
    logger.error({ err }, "import failed");
    process.exitCode = 1;
  } finally {
    closeDb();
  }
}

main();
