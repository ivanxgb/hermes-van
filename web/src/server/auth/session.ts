/**
 * Session management.
 *
 * Sessions are signed cookies. The cookie carries `<sessionId>.<hmac>`.
 * The session row in DB carries `csrfTokenHash` (server-side HMAC of CSRF
 * token) so we don't trust the client's copy.
 *
 * Limits:
 *   - idle timeout: 24 hours (lastSeenAt + 24h)
 *   - absolute timeout: 7 days (createdAt + 7d == expiresAt)
 *   - revocable instantly via webSessions.revokedAt
 */
import { createHmac, randomBytes } from "node:crypto";
import { ulid } from "../lib/id";
import type { Env } from "../lib/env";

export const SESSION_COOKIE_NAME = "hv_session";
export const CSRF_HEADER_NAME = "X-CSRF-Token";
export const CSRF_COOKIE_NAME = "hv_csrf";

export const IDLE_TIMEOUT_MS = 24 * 60 * 60 * 1000;
export const ABSOLUTE_TIMEOUT_MS = 7 * 24 * 60 * 60 * 1000;

export interface SessionToken {
  sessionId: string;
  signature: string;
}

function hmac(secret: string, data: string): string {
  return createHmac("sha256", secret).update(data).digest("hex");
}

export function signSessionId(sessionId: string, secret: string): string {
  return `${sessionId}.${hmac(secret, sessionId)}`;
}

export function parseSessionCookie(
  cookieValue: string,
  secret: string,
): SessionToken | null {
  const parts = cookieValue.split(".");
  if (parts.length !== 2) return null;
  const [sessionId, signature] = parts;
  if (!sessionId || !signature) return null;
  const expected = hmac(secret, sessionId);
  // Length check before timingSafeEqual to avoid throw
  if (signature.length !== expected.length) return null;
  // constant-time comparison
  let diff = 0;
  for (let i = 0; i < signature.length; i++) {
    diff |= signature.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  if (diff !== 0) return null;
  return { sessionId, signature };
}

/** Generate a new session id (ULID) and the matching CSRF token. */
export function newSessionTokens(): {
  sessionId: string;
  csrfToken: string;
} {
  return {
    sessionId: ulid(),
    csrfToken: randomBytes(32).toString("hex"),
  };
}

/** HMAC of the CSRF token, stored server-side in webSessions. */
export function hashCsrfToken(token: string, secret: string): string {
  return hmac(secret, `csrf:${token}`);
}

export function buildSessionCookie(
  signed: string,
  env: Env,
  maxAgeMs: number = ABSOLUTE_TIMEOUT_MS,
): string {
  const secure = env.NODE_ENV === "production";
  const parts = [
    `${SESSION_COOKIE_NAME}=${signed}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    `Max-Age=${Math.floor(maxAgeMs / 1000)}`,
  ];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

export function buildCsrfCookie(token: string, env: Env): string {
  const secure = env.NODE_ENV === "production";
  const parts = [
    `${CSRF_COOKIE_NAME}=${token}`,
    "Path=/",
    // NOT HttpOnly — JS must read it for double-submit
    "SameSite=Strict",
    `Max-Age=${Math.floor(ABSOLUTE_TIMEOUT_MS / 1000)}`,
  ];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

export function buildClearCookies(env: Env): string[] {
  const secure = env.NODE_ENV === "production";
  const flag = secure ? "Secure; " : "";
  return [
    `${SESSION_COOKIE_NAME}=; Path=/; HttpOnly; ${flag}SameSite=Strict; Max-Age=0`,
    `${CSRF_COOKIE_NAME}=; Path=/; ${flag}SameSite=Strict; Max-Age=0`,
  ];
}

/**
 * Check if a session is still valid based on timestamps.
 *
 * @returns 'valid' | 'expired' | 'revoked' | 'idle'
 */
export function sessionStatus(session: {
  expiresAt: number;
  lastSeenAt: number;
  revokedAt: number | null;
}): "valid" | "expired" | "revoked" | "idle" {
  const now = Date.now();
  if (session.revokedAt !== null) return "revoked";
  if (now > session.expiresAt) return "expired";
  if (now > session.lastSeenAt + IDLE_TIMEOUT_MS) return "idle";
  return "valid";
}
