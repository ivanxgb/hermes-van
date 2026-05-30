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
import { authRequired } from "../middleware";
import { listSkills, listToolsets } from "../gateway/client";
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
