/**
 * Hono middlewares: security headers, CSRF, auth, rate limit.
 */
import type { MiddlewareHandler } from "hono";
import { getCookie } from "hono/cookie";
import { eq } from "drizzle-orm";
import { getDb } from "../db";
import * as schema from "../db/schema";
import { loadEnv } from "../lib/env";
import { logger } from "../lib/logger";
import {
  CSRF_COOKIE_NAME,
  CSRF_HEADER_NAME,
  IDLE_TIMEOUT_MS,
  SESSION_COOKIE_NAME,
  hashCsrfToken,
  parseSessionCookie,
  sessionStatus,
} from "../auth/session";
import { rateCheck, type RateLimitConfig } from "../auth/ratelimit";
import { constantTimeEqual } from "../auth/recovery";

declare module "hono" {
  interface ContextVariableMap {
    user?: {
      id: string;
      username: string;
      sessionId: string;
    };
  }
}

/** Apply baseline security headers on every response. */
export const securityHeaders: MiddlewareHandler = async (c, next) => {
  await next();
  const env = loadEnv();
  c.header("X-Content-Type-Options", "nosniff");
  c.header("X-Frame-Options", "DENY");
  c.header("Referrer-Policy", "no-referrer");
  c.header("Cross-Origin-Opener-Policy", "same-origin");
  c.header("Cross-Origin-Resource-Policy", "same-origin");
  c.header("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  if (env.NODE_ENV === "production") {
    // HSTS is emitted by Nginx (hsts/preload-eligible there). Keeping it
    // here too caused duplicate headers; the upstream proxy is the
    // canonical surface for transport-level security headers.
  }
};

/** Look up the active session and inject `user` into context. */
export const authRequired: MiddlewareHandler = async (c, next) => {
  const env = loadEnv();
  const cookieValue = getCookie(c, SESSION_COOKIE_NAME);
  if (!cookieValue) {
    return c.json({ error: "Unauthenticated" }, 401);
  }
  const parsed = parseSessionCookie(cookieValue, env.HERMES_VAN_SESSION_SECRET);
  if (!parsed) {
    return c.json({ error: "Invalid session" }, 401);
  }

  const db = getDb();
  const session = db
    .select()
    .from(schema.webSessions)
    .where(eq(schema.webSessions.id, parsed.sessionId))
    .get();

  if (!session) {
    return c.json({ error: "Session not found" }, 401);
  }

  const status = sessionStatus(session);
  if (status !== "valid") {
    return c.json({ error: `Session ${status}` }, 401);
  }

  const user = db
    .select()
    .from(schema.users)
    .where(eq(schema.users.id, session.userId))
    .get();
  if (!user) {
    return c.json({ error: "User not found" }, 401);
  }

  // Touch lastSeenAt (approximation; only update if drifted by >1min)
  const now = Date.now();
  if (now - session.lastSeenAt > 60_000) {
    db.update(schema.webSessions)
      .set({ lastSeenAt: now })
      .where(eq(schema.webSessions.id, session.id))
      .run();
  }

  c.set("user", { id: user.id, username: user.username, sessionId: session.id });
  await next();
  return;
};

/**
 * CSRF: double-submit cookie. Required on every mutation (POST/PUT/PATCH/DELETE).
 *
 * The client reads the hv_csrf cookie via JS (it's not HttpOnly) and sends
 * it back in the X-CSRF-Token header. Server validates that the cookie
 * value, header value, and HMAC stored in webSessions.csrfTokenHash
 * all match.
 */
export const csrfRequired: MiddlewareHandler = async (c, next) => {
  const method = c.req.method;
  if (["GET", "HEAD", "OPTIONS"].includes(method)) {
    await next();
    return;
  }

  const env = loadEnv();
  const cookieToken = getCookie(c, CSRF_COOKIE_NAME);
  const headerToken = c.req.header(CSRF_HEADER_NAME);

  if (!cookieToken || !headerToken) {
    return c.json({ error: "Missing CSRF token" }, 403);
  }
  if (!constantTimeEqual(cookieToken, headerToken)) {
    return c.json({ error: "CSRF token mismatch" }, 403);
  }

  const user = c.get("user");
  if (user) {
    const db = getDb();
    const session = db
      .select()
      .from(schema.webSessions)
      .where(eq(schema.webSessions.id, user.sessionId))
      .get();
    if (!session) {
      return c.json({ error: "Session vanished" }, 401);
    }
    const expected = hashCsrfToken(cookieToken, env.HERMES_VAN_SESSION_SECRET);
    if (!constantTimeEqual(expected, session.csrfTokenHash)) {
      logger.warn(
        { userId: user.id, sessionId: user.sessionId },
        "csrf token mismatch against session hash",
      );
      return c.json({ error: "CSRF token invalid" }, 403);
    }
  }

  await next();
  return;
};

/** Suppress unused-import warning. */
void IDLE_TIMEOUT_MS;

/**
 * IP-based rate limiter middleware factory.
 * Bucket key prefix should be unique per route family (login, recovery, …).
 */
export function rateLimitedByIp(prefix: string, cfg: RateLimitConfig): MiddlewareHandler {
  return async (c, next) => {
    const ip = c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
    const result = rateCheck(`${prefix}:${ip}`, cfg);
    if (!result.allowed) {
      c.header("Retry-After", String(Math.ceil(result.retryAfterMs / 1000)));
      return c.json(
        { error: "Rate limit exceeded", retryAfterMs: result.retryAfterMs },
        429,
      );
    }
    await next();
    return;
  };
}
