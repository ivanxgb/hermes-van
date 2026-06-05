import { describe, expect, it } from "vitest";
import {
  buildSessionCookie,
  buildClearCookies,
  hashCsrfToken,
  newSessionTokens,
  parseSessionCookie,
  sessionStatus,
  signSessionId,
  IDLE_TIMEOUT_MS,
  ABSOLUTE_TIMEOUT_MS,
} from "./session";
import type { Env } from "../lib/env";

const env: Env = {
  NODE_ENV: "development",
  HERMES_VAN_GATEWAY_URL: "http://127.0.0.1:8765",
  HERMES_VAN_GATEWAY_KEY: "x".repeat(40),
  HERMES_VAN_DB_PATH: "./data/x.db",
  HERMES_VAN_DB_KEY: "a".repeat(64),
  HERMES_VAN_SESSION_SECRET: "b".repeat(64),
  HERMES_VAN_RP_ID: "localhost",
  HERMES_VAN_RP_ORIGIN: "http://localhost:3015",
  HERMES_VAN_RP_NAME: "test",
  HERMES_VAN_PORT: 3015,
  HERMES_VAN_HOST: "127.0.0.1",
  HERMES_VAN_LOG_LEVEL: "info",
  HERMES_VAN_VAPID_SUBJECT: "mailto:noreply@hermes-van.local",
  HERMES_VAN_BACKUP_RETENTION: 14,
};
const SECRET = env.HERMES_VAN_SESSION_SECRET;

describe("session sign/parse", () => {
  it("signs and parses a session id round-trip", () => {
    const sid = "01HZ123";
    const signed = signSessionId(sid, SECRET);
    const parsed = parseSessionCookie(signed, SECRET);
    expect(parsed?.sessionId).toBe(sid);
  });

  it("rejects tampered signature", () => {
    const sid = "01HZ456";
    const signed = signSessionId(sid, SECRET);
    const [s, sig] = signed.split(".");
    const tampered = `${s}.${"x".repeat(sig?.length ?? 64)}`;
    expect(parseSessionCookie(tampered, SECRET)).toBeNull();
  });

  it("rejects wrong secret", () => {
    const sid = "01HZ789";
    const signed = signSessionId(sid, SECRET);
    expect(parseSessionCookie(signed, "z".repeat(64))).toBeNull();
  });

  it("rejects malformed cookie", () => {
    expect(parseSessionCookie("no-dot", SECRET)).toBeNull();
    expect(parseSessionCookie("a.b.c", SECRET)).toBeNull();
    expect(parseSessionCookie(".sig", SECRET)).toBeNull();
    expect(parseSessionCookie("sid.", SECRET)).toBeNull();
  });
});

describe("csrf hashing", () => {
  it("produces stable hash for same input", () => {
    const t = "csrf-token-123";
    expect(hashCsrfToken(t, SECRET)).toBe(hashCsrfToken(t, SECRET));
  });

  it("differs across tokens", () => {
    expect(hashCsrfToken("a", SECRET)).not.toBe(hashCsrfToken("b", SECRET));
  });

  it("differs across secrets", () => {
    expect(hashCsrfToken("a", SECRET)).not.toBe(hashCsrfToken("a", "c".repeat(64)));
  });
});

describe("newSessionTokens", () => {
  it("produces unique sessionIds", () => {
    const a = newSessionTokens();
    const b = newSessionTokens();
    expect(a.sessionId).not.toBe(b.sessionId);
    expect(a.csrfToken).not.toBe(b.csrfToken);
  });

  it("csrf token is hex-formatted 64 chars", () => {
    const { csrfToken } = newSessionTokens();
    expect(csrfToken).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("buildSessionCookie", () => {
  it("HttpOnly + SameSite=Strict in dev (no Secure)", () => {
    const c = buildSessionCookie("signed", env);
    expect(c).toContain("HttpOnly");
    expect(c).toContain("SameSite=Strict");
    expect(c).not.toContain("Secure");
  });

  it("Secure flag in production", () => {
    const c = buildSessionCookie("signed", { ...env, NODE_ENV: "production" });
    expect(c).toContain("Secure");
  });
});

describe("buildClearCookies", () => {
  it("returns Max-Age=0 for both cookies", () => {
    const cookies = buildClearCookies(env);
    expect(cookies).toHaveLength(2);
    for (const c of cookies) expect(c).toContain("Max-Age=0");
  });
});

describe("sessionStatus", () => {
  const now = Date.now();

  it("returns 'valid' for fresh session", () => {
    expect(
      sessionStatus({
        expiresAt: now + 1_000_000,
        lastSeenAt: now,
        revokedAt: null,
      }),
    ).toBe("valid");
  });

  it("returns 'revoked' if revokedAt is set", () => {
    expect(
      sessionStatus({
        expiresAt: now + 1_000_000,
        lastSeenAt: now,
        revokedAt: now,
      }),
    ).toBe("revoked");
  });

  it("returns 'expired' past absolute timeout", () => {
    expect(
      sessionStatus({
        expiresAt: now - 1000,
        lastSeenAt: now,
        revokedAt: null,
      }),
    ).toBe("expired");
  });

  it("returns 'idle' past idle timeout but within absolute", () => {
    expect(
      sessionStatus({
        expiresAt: now + ABSOLUTE_TIMEOUT_MS,
        lastSeenAt: now - IDLE_TIMEOUT_MS - 1000,
        revokedAt: null,
      }),
    ).toBe("idle");
  });
});
