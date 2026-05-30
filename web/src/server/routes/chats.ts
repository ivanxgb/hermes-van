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
