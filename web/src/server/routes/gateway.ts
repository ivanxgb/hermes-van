/**
 * Gateway capability proxies — read-only views of what the agent can do.
 *
 * Mounted at /api/gateway. All endpoints require auth so we don't leak
 * skill catalog details to anonymous traffic, and so a future feature
 * gate (e.g. admin-only) plugs in without extra plumbing. The proxy
 * also keeps HERMES_VAN_GATEWAY_KEY server-side — the browser never
 * sees the upstream key.
 *
 * Endpoints:
 *   GET /api/gateway/skills    — list skills (name, description, category)
 *   GET /api/gateway/toolsets  — list toolsets (name, label, enabled, tools[])
 */
import { Hono } from "hono";
import { ulid } from "ulid";
import { authRequired } from "../middleware";
import { listSkills, listToolsets, listJobs, forkSession } from "../gateway/client";
import { getDb } from "../db";
import { forUser } from "../db/scoped";
import { logger } from "../lib/logger";

export const gatewayRoutes = new Hono();

gatewayRoutes.use("*", authRequired);

gatewayRoutes.get("/skills", async (c) => {
  try {
    const skills = await listSkills();
    return c.json({ skills });
  } catch (err) {
    logger.warn({ err }, "gateway listSkills failed");
    return c.json(
      { error: "Gateway error", detail: err instanceof Error ? err.message : String(err) },
      502 as never,
    );
  }
});

gatewayRoutes.get("/toolsets", async (c) => {
  try {
    const toolsets = await listToolsets();
    return c.json({ toolsets });
  } catch (err) {
    logger.warn({ err }, "gateway listToolsets failed");
    return c.json(
      { error: "Gateway error", detail: err instanceof Error ? err.message : String(err) },
      502 as never,
    );
  }
});

gatewayRoutes.get("/jobs", async (c) => {
  try {
    const jobs = await listJobs();
    // Strip `prompt` from the listing — it's often very long, contains
    // user-authored task instructions, and isn't useful for an at-a-glance
    // browser. UIs that want it can fetch the full record per-job later.
    const trimmed = jobs.map((j) => {
      const copy = { ...j };
      if (typeof copy["prompt"] === "string" && (copy["prompt"] as string).length > 200) {
        copy["prompt_preview"] = (copy["prompt"] as string).slice(0, 200);
        delete copy["prompt"];
      }
      return copy;
    });
    return c.json({ jobs: trimmed });
  } catch (err) {
    logger.warn({ err }, "gateway listJobs failed");
    return c.json(
      { error: "Gateway error", detail: err instanceof Error ? err.message : String(err) },
      502 as never,
    );
  }
});

/**
 * POST /api/gateway/chats/:id/fork
 *
 * Forks the upstream gateway session backing this chat, then creates a
 * new local chat scoped to the same user that points at the new session.
 * Messages are NOT copied locally — the gateway already retains the
 * forked transcript on its side, and a fork is meant to start a fresh
 * branch from a shared point.
 */
gatewayRoutes.post("/chats/:id/fork", async (c) => {
  const user = c.get("user");
  if (!user) return c.json({ error: "Unauthenticated" }, 401);

  const chatId = c.req.param("id");
  const scoped = forUser(getDb(), user.id);
  const chat = scoped.chats.byId(chatId);
  if (!chat) return c.json({ error: "Chat not found" }, 404);

  let forkedSession: Record<string, unknown>;
  try {
    forkedSession = await forkSession(chat.gatewaySessionId);
  } catch (err) {
    logger.warn({ err, chatId }, "gateway forkSession failed");
    return c.json(
      { error: "Gateway error", detail: err instanceof Error ? err.message : String(err) },
      502 as never,
    );
  }

  const newGatewaySessionId = forkedSession["id"] as string | undefined;
  if (!newGatewaySessionId) {
    return c.json({ error: "Gateway returned no session id" }, 502 as never);
  }

  const newId = ulid();
  const newChat = scoped.chats.insert({
    id: newId,
    title: `${chat.title} (fork)`,
    gatewaySessionId: newGatewaySessionId,
    model: chat.model,
  });

  return c.json({ chat: newChat, upstreamSession: forkedSession }, 201);
});
