/**
 * Web Push subscription routes.
 *
 * GET  /api/push/public-key       — exposes the VAPID public key the
 *                                   browser needs to subscribe. 503 if
 *                                   push is not configured.
 * POST /api/push/subscribe        — register a PushSubscription JSON
 *                                   from PushManager.subscribe(); upserts
 *                                   so re-subscribing updates keys.
 * POST /api/push/unsubscribe      — remove by endpoint.
 * POST /api/push/test             — fire a test notification to all of
 *                                   this user's subscriptions. Useful
 *                                   for the settings page button.
 */
import { Hono } from "hono";
import { z } from "zod";
import { ulid } from "../lib/id";
import { authRequired } from "../middleware";
import { csrfRequired } from "../middleware";
import { getDb } from "../db";
import { forUser } from "../db/scoped";
import { vapidPublicKey, pushToUser } from "../lib/push";
import { logger } from "../lib/logger";

export const pushRoutes = new Hono();

pushRoutes.use("*", authRequired);

pushRoutes.get("/public-key", async (c) => {
  const key = vapidPublicKey();
  if (!key) return c.json({ error: "Push not configured" }, 503);
  return c.json({ publicKey: key });
});

const subscribeSchema = z.object({
  endpoint: z.string().url().max(2000),
  keys: z.object({
    p256dh: z.string().min(1).max(200),
    auth: z.string().min(1).max(200),
  }),
});

pushRoutes.post("/subscribe", csrfRequired, async (c) => {
  const user = c.get("user");
  if (!user) return c.json({ error: "Unauthenticated" }, 401);

  const body = await c.req.json().catch(() => null);
  const parsed = subscribeSchema.safeParse(body);
  if (!parsed.success) {
    return c.json(
      { error: "Invalid subscription", issues: parsed.error.issues.map((i) => i.message) },
      400,
    );
  }

  const ua = c.req.header("user-agent") ?? null;
  const scoped = forUser(getDb(), user.id);
  const sub = scoped.pushSubscriptions.upsert({
    id: ulid(),
    endpoint: parsed.data.endpoint,
    p256dh: parsed.data.keys.p256dh,
    auth: parsed.data.keys.auth,
    userAgent: ua,
  });
  return c.json({
    ok: true,
    subscription: {
      id: sub.id,
      endpoint: sub.endpoint,
      createdAt: sub.createdAt,
    },
  });
});

const unsubscribeSchema = z.object({
  endpoint: z.string().url().max(2000),
});

pushRoutes.post("/unsubscribe", csrfRequired, async (c) => {
  const user = c.get("user");
  if (!user) return c.json({ error: "Unauthenticated" }, 401);

  const body = await c.req.json().catch(() => null);
  const parsed = unsubscribeSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Invalid endpoint" }, 400);
  }
  forUser(getDb(), user.id).pushSubscriptions.deleteByEndpoint(parsed.data.endpoint);
  return c.json({ ok: true });
});

pushRoutes.post("/test", csrfRequired, async (c) => {
  const user = c.get("user");
  if (!user) return c.json({ error: "Unauthenticated" }, 401);

  try {
    const result = await pushToUser(user.id, {
      title: "hermes-van test",
      body: "Notifications are wired up.",
      tag: "hv-test",
    });
    return c.json({ ok: true, ...result });
  } catch (err) {
    logger.warn({ err }, "push test failed");
    return c.json(
      { error: "Push send failed", detail: err instanceof Error ? err.message : String(err) },
      502 as never,
    );
  }
});
