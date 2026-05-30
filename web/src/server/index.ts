/**
 * Hono server entry. Mounted under Vite dev for HMR; in production it
 * runs standalone via @hono/node-server.
 *
 * Routes:
 *   /api/health        → liveness + gateway probe
 *   /auth/*            → setup, login, recovery, logout, me
 */
import "dotenv/config";
import { Hono } from "hono";
import { logger as honoLogger } from "hono/logger";
import { authRoutes } from "./auth/routes";
import { chatRoutes } from "./routes/chats";
import { authRequired } from "./middleware";
import { securityHeaders } from "./middleware";
import { loadEnv } from "./lib/env";
import { logger } from "./lib/logger";

const app = new Hono();

app.use("*", securityHeaders);
if (process.env["NODE_ENV"] !== "test") {
  app.use("*", honoLogger((message) => logger.info({ component: "http" }, message)));
}

app.get("/api/health", async (c) => {
  const env = loadEnv();
  let gateway: { ok: boolean; latencyMs: number; error?: string } = {
    ok: false,
    latencyMs: 0,
  };
  const start = Date.now();
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 2000);
    const res = await fetch(`${env.HERMES_VAN_GATEWAY_URL}/health`, {
      signal: ctrl.signal,
      headers: { Authorization: `Bearer ${env.HERMES_VAN_GATEWAY_KEY}` },
    });
    clearTimeout(t);
    gateway = { ok: res.ok, latencyMs: Date.now() - start };
    if (!res.ok) gateway.error = `gateway returned ${res.status}`;
  } catch (err) {
    gateway = {
      ok: false,
      latencyMs: Date.now() - start,
      error: (err as Error).message,
    };
  }
  return c.json({
    status: gateway.ok ? "ok" : "degraded",
    service: "hermes-van",
    version: "0.1.0",
    time: new Date().toISOString(),
    gateway,
  });
});

// /auth/* mounts via subapp
app.route("/auth", authRoutes);

// /api/chats/* — REST surface for chat CRUD (auth required)
app.route("/api/chats", chatRoutes);

// /api/me convenience proxy: requires auth
app.get("/api/me", authRequired, async (c) => {
  const user = c.get("user");
  if (!user) return c.json({ error: "Unauthenticated" }, 401);
  return c.json({
    userId: user.id,
    username: user.username,
    sessionId: user.sessionId,
  });
});

export default app;
