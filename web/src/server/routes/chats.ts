/**
 * Chat REST routes. All endpoints require auth; mutations require CSRF.
 *
 * Mounted at /api/chats.
 *
 * Endpoints:
 *   GET    /api/chats                   list user's chats (active by default)
 *   POST   /api/chats                   create a new chat
 *   GET    /api/chats/:id               read one chat
 *   PATCH  /api/chats/:id               rename / archive / unarchive
 *   DELETE /api/chats/:id               delete (cascades to messages + runs)
 *   GET    /api/chats/:id/messages      list messages for a chat
 *
 * Trust boundary: every handler routes through ScopedDb (forUser),
 * so cross-user reads/writes are impossible by construction.
 */
import { Hono } from "hono";
import { z } from "zod";
import { authRequired, csrfRequired } from "../middleware";
import { getDb } from "../db";
import { forUser } from "../db/scoped";
import { ulid } from "../lib/id";

export const chatRoutes = new Hono();

// All chat routes require auth.
chatRoutes.use("*", authRequired);

// ─── List ───────────────────────────────────────────────────────────────

const listQuerySchema = z.object({
  includeArchived: z
    .string()
    .optional()
    .transform((v) => v === "true" || v === "1"),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});

chatRoutes.get("/", async (c) => {
  const user = c.get("user");
  if (!user) return c.json({ error: "Unauthenticated" }, 401);

  const parsed = listQuerySchema.safeParse({
    includeArchived: c.req.query("includeArchived"),
    limit: c.req.query("limit"),
  });
  if (!parsed.success) {
    return c.json({ error: "Invalid query", issues: parsed.error.issues }, 400);
  }

  const chats = forUser(getDb(), user.id).chats.list({
    includeArchived: parsed.data.includeArchived,
    limit: parsed.data.limit,
  });

  return c.json({ chats });
});

// ─── Create ─────────────────────────────────────────────────────────────

const createSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  model: z.string().min(1).max(128).optional(),
});

chatRoutes.post("/", csrfRequired, async (c) => {
  const user = c.get("user");
  if (!user) return c.json({ error: "Unauthenticated" }, 401);

  const body = await c.req.json().catch(() => ({}));
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Invalid input", issues: parsed.error.issues }, 400);
  }

  const id = ulid();
  // gatewaySessionId opaco — same as chat id, but we keep them separate
  // in the schema so we can rotate the upstream session if needed (e.g.
  // if the gateway memory gets corrupted) without changing the client id.
  const chat = forUser(getDb(), user.id).chats.insert({
    id,
    title: parsed.data.title?.trim() || "New chat",
    gatewaySessionId: `hv_${id}`,
    model: parsed.data.model ?? null,
  });

  return c.json({ chat }, 201);
});

// ─── Search ─────────────────────────────────────────────────────────────
// FTS5-backed search across the user's message log. Limited to the
// authed user via ScopedDb. Optional chatId narrows to one chat.
//
// IMPORTANT: this must be registered before any /:id routes — Hono
// matches in registration order, and "_search" would otherwise be
// captured as a chat id parameter.

const searchSchema = z.object({
  q: z.string().min(1).max(500),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  chatId: z.string().min(1).max(64).optional(),
});

chatRoutes.get("/_search", async (c) => {
  const user = c.get("user");
  if (!user) return c.json({ error: "Unauthenticated" }, 401);

  const parsed = searchSchema.safeParse({
    q: c.req.query("q"),
    limit: c.req.query("limit"),
    chatId: c.req.query("chatId"),
  });
  if (!parsed.success) {
    return c.json({ error: "Invalid query", issues: parsed.error.issues }, 400);
  }

  const scoped = forUser(getDb(), user.id);
  const results = scoped.messages.search(parsed.data.q, {
    limit: parsed.data.limit,
    chatId: parsed.data.chatId,
  });

  return c.json({ results });
});

// ─── Read one ───────────────────────────────────────────────────────────

const idParam = z.string().min(1).max(64);

chatRoutes.get("/:id", async (c) => {
  const user = c.get("user");
  if (!user) return c.json({ error: "Unauthenticated" }, 401);

  const idResult = idParam.safeParse(c.req.param("id"));
  if (!idResult.success) return c.json({ error: "Invalid id" }, 400);

  const chat = forUser(getDb(), user.id).chats.byId(idResult.data);
  if (!chat) return c.json({ error: "Chat not found" }, 404);

  return c.json({ chat });
});

// ─── Update (rename / archive / unarchive) ──────────────────────────────

const patchSchema = z
  .object({
    title: z.string().min(1).max(200).optional(),
    archived: z.boolean().optional(),
  })
  .refine((v) => v.title !== undefined || v.archived !== undefined, {
    message: "At least one of 'title' or 'archived' is required",
  });

chatRoutes.patch("/:id", csrfRequired, async (c) => {
  const user = c.get("user");
  if (!user) return c.json({ error: "Unauthenticated" }, 401);

  const idResult = idParam.safeParse(c.req.param("id"));
  if (!idResult.success) return c.json({ error: "Invalid id" }, 400);

  const body = await c.req.json().catch(() => ({}));
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Invalid input", issues: parsed.error.issues }, 400);
  }

  const scoped = forUser(getDb(), user.id);
  const existing = scoped.chats.byId(idResult.data);
  if (!existing) return c.json({ error: "Chat not found" }, 404);

  if (parsed.data.title !== undefined) {
    scoped.chats.rename(idResult.data, parsed.data.title.trim());
  }
  if (parsed.data.archived === true) {
    scoped.chats.archive(idResult.data);
  } else if (parsed.data.archived === false) {
    scoped.chats.unarchive(idResult.data);
  }

  const chat = scoped.chats.byId(idResult.data);
  return c.json({ chat });
});

// ─── Delete ─────────────────────────────────────────────────────────────

chatRoutes.delete("/:id", csrfRequired, async (c) => {
  const user = c.get("user");
  if (!user) return c.json({ error: "Unauthenticated" }, 401);

  const idResult = idParam.safeParse(c.req.param("id"));
  if (!idResult.success) return c.json({ error: "Invalid id" }, 400);

  const scoped = forUser(getDb(), user.id);
  const existing = scoped.chats.byId(idResult.data);
  if (!existing) return c.json({ error: "Chat not found" }, 404);

  scoped.chats.delete(idResult.data);
  return c.json({ ok: true });
});

// ─── Messages ───────────────────────────────────────────────────────────

const messagesQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(500).optional(),
  before: z.coerce.number().int().nonnegative().optional(),
});

chatRoutes.get("/:id/messages", async (c) => {
  const user = c.get("user");
  if (!user) return c.json({ error: "Unauthenticated" }, 401);

  const idResult = idParam.safeParse(c.req.param("id"));
  if (!idResult.success) return c.json({ error: "Invalid id" }, 400);

  const parsed = messagesQuerySchema.safeParse({
    limit: c.req.query("limit"),
    before: c.req.query("before"),
  });
  if (!parsed.success) {
    return c.json({ error: "Invalid query", issues: parsed.error.issues }, 400);
  }

  const scoped = forUser(getDb(), user.id);
  const chat = scoped.chats.byId(idResult.data);
  if (!chat) return c.json({ error: "Chat not found" }, 404);

  const messages = scoped.messages.listForChat(idResult.data, {
    limit: parsed.data.limit,
    before: parsed.data.before,
  });

  return c.json({ messages });
});

// ─── Export markdown ────────────────────────────────────────────────────
// Plain-text dump of the chat for archiving. We strip pending/streaming
// rows because they're not user-visible final content.

chatRoutes.get("/:id/export.md", async (c) => {
  const user = c.get("user");
  if (!user) return c.json({ error: "Unauthenticated" }, 401);

  const idResult = idParam.safeParse(c.req.param("id"));
  if (!idResult.success) return c.json({ error: "Invalid id" }, 400);

  const scoped = forUser(getDb(), user.id);
  const chat = scoped.chats.byId(idResult.data);
  if (!chat) return c.json({ error: "Chat not found" }, 404);

  const messages = scoped.messages
    .listForChat(idResult.data)
    .filter(
      (m) =>
        (m.role === "user" || m.role === "assistant") &&
        m.status === "completed" &&
        m.content.length > 0,
    );

  const lines: string[] = [];
  lines.push(`# ${chat.title}`);
  lines.push("");
  lines.push(`> Exported from hermes-van — ${new Date().toISOString()}`);
  lines.push(`> Chat: \`${chat.id}\` · Messages: ${messages.length}`);
  if (chat.model) lines.push(`> Model: \`${chat.model}\``);
  lines.push("");
  lines.push("---");
  lines.push("");

  for (const m of messages) {
    const heading = m.role === "user" ? "## You" : "## Assistant";
    lines.push(heading);
    lines.push("");
    lines.push(m.content);
    lines.push("");
  }

  const body = lines.join("\n");
  // Best-effort filename: lowercase title, alphanumerics + dashes only.
  const slug = chat.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "chat";
  const filename = `${slug}-${chat.id.slice(-8)}.md`;

  c.header("Content-Type", "text/markdown; charset=utf-8");
  c.header("Content-Disposition", `attachment; filename="${filename}"`);
  return c.body(body);
});

// ─── Active run for a chat ──────────────────────────────────────────────
// Returns the single in-flight run (if any) so a page reload can resume
// streaming via the SSE proxy. We do not expose upstreamRunId — the
// client only ever sees the local ULID.

const ACTIVE_STATUSES = new Set([
  "queued",
  "running",
  "waiting_for_approval",
  "stopping",
]);

chatRoutes.get("/:id/active-run", async (c) => {
  const user = c.get("user");
  if (!user) return c.json({ error: "Unauthenticated" }, 401);

  const idResult = idParam.safeParse(c.req.param("id"));
  if (!idResult.success) return c.json({ error: "Invalid id" }, 400);

  const scoped = forUser(getDb(), user.id);
  const chat = scoped.chats.byId(idResult.data);
  if (!chat) return c.json({ error: "Chat not found" }, 404);

  const runs = scoped.activeRuns.listForChat(idResult.data);
  const live = runs.find((r) => ACTIVE_STATUSES.has(r.status));
  if (!live) return c.json({ run: null });

  return c.json({
    run: {
      id: live.id,
      chatId: live.chatId,
      messageId: live.messageId,
      status: live.status,
      startedAt: live.startedAt,
    },
  });
});
