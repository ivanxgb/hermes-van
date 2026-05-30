/**
 * Auth route handlers. Mounted at /auth/*.
 *
 * Endpoints:
 *   POST   /auth/setup/options       (consume setup token, build registration options)
 *   POST   /auth/setup/verify        (verify registration response, create user, login)
 *   POST   /auth/login/options       (build authentication options for username)
 *   POST   /auth/login/verify        (verify, create session, set cookies)
 *   POST   /auth/recovery            (use recovery code, log in, regenerate codes)
 *   POST   /auth/logout              (revoke current session)
 *   POST   /auth/logout-all          (revoke all sessions for user)
 *   GET    /auth/me                  (current user + session info)
 */
import { Hono, type Context } from "hono";
import { getCookie } from "hono/cookie";
import { z } from "zod";
import { and, eq, isNull } from "drizzle-orm";
import { getDb } from "../db";
import * as schema from "../db/schema";
import { forUser } from "../db/scoped";
import { loadEnv } from "../lib/env";
import { ulid } from "../lib/id";
import { logger } from "../lib/logger";
import {
  ABSOLUTE_TIMEOUT_MS,
  CSRF_COOKIE_NAME,
  buildClearCookies,
  buildCsrfCookie,
  buildSessionCookie,
  hashCsrfToken,
  newSessionTokens,
  signSessionId,
} from "./session";
import {
  buildAuthenticationOptions,
  buildRegistrationOptions,
  bufferToBase64Url,
  consumeChallenge,
  rememberChallenge,
  verifyAuthentication,
  verifyRegistration,
} from "./webauthn";
import {
  generateBatch as generateRecoveryBatch,
  hashCode as hashRecoveryCode,
  verifyCode as verifyRecoveryCode,
} from "./recovery";
import { emitAudit } from "./audit";
import { authRequired, csrfRequired, rateLimitedByIp } from "../middleware";
import { RATE_LIMITS } from "./ratelimit";
import { createHash } from "node:crypto";

export const authRoutes = new Hono();

function ipOf(c: Context): string {
  return c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
}

function uaOf(c: Context): string {
  return c.req.header("user-agent") ?? "unknown";
}

function hashSetupToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

// ─── Setup (first-user / new credential bootstrap) ──────────────────────

const setupOptionsSchema = z.object({
  setupToken: z.string().min(16),
  username: z
    .string()
    .min(2)
    .max(64)
    .regex(/^[a-zA-Z0-9_-]+$/, "Username may only contain letters, digits, _ and -"),
  displayName: z.string().min(1).max(128),
});

authRoutes.post(
  "/setup/options",
  rateLimitedByIp("setup", RATE_LIMITS.setupPerIp),
  async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = setupOptionsSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "Invalid input", issues: parsed.error.issues }, 400);
    }

    const env = loadEnv();
    const db = getDb();
    const tokenHash = hashSetupToken(parsed.data.setupToken);
    const now = Date.now();

    // Find a valid setup token
    const tokens = db
      .select()
      .from(schema.setupTokens)
      .where(and(eq(schema.setupTokens.tokenHash, tokenHash), isNull(schema.setupTokens.usedAt)))
      .all();

    const tok = tokens.find((t) => t.expiresAt > now);
    if (!tok) {
      emitAudit(db, {
        event: "setup.token_expired",
        ip: ipOf(c),
        userAgent: uaOf(c),
        metadata: { reason: "not_found_or_expired" },
      });
      return c.json({ error: "Invalid or expired setup token" }, 400);
    }

    // Reject duplicate username
    const existing = db
      .select()
      .from(schema.users)
      .where(eq(schema.users.username, parsed.data.username))
      .get();
    if (existing) {
      return c.json({ error: "Username already taken" }, 409);
    }

    const userId = ulid();
    const { options, webauthnUserId } = await buildRegistrationOptions(env, {
      id: userId,
      username: parsed.data.username,
      displayName: parsed.data.displayName,
    });

    rememberChallenge(parsed.data.setupToken, {
      challenge: options.challenge,
      userId,
      webauthnUserId,
    });

    return c.json({
      options,
      pendingUserId: userId,
    });
  },
);

const setupVerifySchema = z.object({
  setupToken: z.string().min(16),
  username: z
    .string()
    .min(2)
    .max(64)
    .regex(/^[a-zA-Z0-9_-]+$/),
  displayName: z.string().min(1).max(128),
  response: z.unknown(),
});

authRoutes.post(
  "/setup/verify",
  rateLimitedByIp("setup", RATE_LIMITS.setupPerIp),
  async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = setupVerifySchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "Invalid input", issues: parsed.error.issues }, 400);
    }

    const env = loadEnv();
    const db = getDb();
    const tokenHash = hashSetupToken(parsed.data.setupToken);
    const now = Date.now();

    const tok = db
      .select()
      .from(schema.setupTokens)
      .where(and(eq(schema.setupTokens.tokenHash, tokenHash), isNull(schema.setupTokens.usedAt)))
      .get();
    if (!tok || tok.expiresAt <= now) {
      return c.json({ error: "Invalid or expired setup token" }, 400);
    }

    const challenge = consumeChallenge(parsed.data.setupToken);
    if (!challenge?.userId) {
      return c.json({ error: "Setup challenge expired; restart flow" }, 400);
    }

    const verification = await verifyRegistration({
      env,
      expectedChallenge: challenge.challenge,
      response: parsed.data.response as Parameters<typeof verifyRegistration>[0]["response"],
    });
    if (!verification.verified || !verification.registrationInfo) {
      return c.json({ error: "Registration verification failed" }, 400);
    }

    const reg = verification.registrationInfo.credential;
    const userId = challenge.userId;
    const credentialId = reg.id;
    const publicKey = bufferToBase64Url(reg.publicKey);
    const counter = reg.counter;
    const transports = JSON.stringify(reg.transports ?? []);

    // Generate recovery codes
    const codes = generateRecoveryBatch();
    const codeHashes = await Promise.all(codes.map((c) => hashRecoveryCode(c)));

    // Atomic-ish: insert user, credential, recovery codes, mark token used
    db.transaction((tx) => {
      tx.insert(schema.users)
        .values({
          id: userId,
          username: parsed.data.username,
          displayName: parsed.data.displayName,
        })
        .run();

      tx.insert(schema.webauthnCredentials)
        .values({
          id: ulid(),
          userId,
          credentialId,
          publicKey,
          counter,
          transports,
          backedUp: verification.registrationInfo!.credentialBackedUp,
          deviceType: verification.registrationInfo!.credentialDeviceType,
          nickname: null,
          lastUsedAt: null,
        })
        .run();

      for (const h of codeHashes) {
        tx.insert(schema.recoveryCodes).values({ id: ulid(), userId, codeHash: h }).run();
      }

      tx.update(schema.setupTokens)
        .set({ usedAt: Date.now() })
        .where(eq(schema.setupTokens.id, tok.id))
        .run();
    });

    emitAudit(db, {
      userId,
      event: "user.created",
      ip: ipOf(c),
      userAgent: uaOf(c),
    });
    emitAudit(db, {
      userId,
      event: "credential.added",
      ip: ipOf(c),
      userAgent: uaOf(c),
      metadata: { deviceType: verification.registrationInfo.credentialDeviceType },
    });
    emitAudit(db, {
      event: "setup.token_consumed",
      userId,
      ip: ipOf(c),
      userAgent: uaOf(c),
    });

    // Auto-login: create session, set cookies
    const { sessionId, csrfToken } = newSessionTokens();
    const csrfHash = hashCsrfToken(csrfToken, env.HERMES_WEB_SESSION_SECRET);
    forUser(db, userId).webSessions.insert({
      id: sessionId,
      expiresAt: Date.now() + ABSOLUTE_TIMEOUT_MS,
      ip: ipOf(c),
      userAgent: uaOf(c),
      csrfTokenHash: csrfHash,
    });
    setSessionCookies(c, sessionId, csrfToken);

    emitAudit(db, {
      userId,
      event: "login.ok",
      ip: ipOf(c),
      userAgent: uaOf(c),
      metadata: { method: "setup_autologin" },
    });

    return c.json({
      userId,
      username: parsed.data.username,
      recoveryCodes: codes,
      csrfToken,
    });
  },
);

// ─── Login ───────────────────────────────────────────────────────────────

const loginOptionsSchema = z.object({
  username: z.string().min(1).max(64),
});

authRoutes.post(
  "/login/options",
  rateLimitedByIp("login", RATE_LIMITS.loginPerIp),
  async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = loginOptionsSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "Invalid input" }, 400);
    }
    const env = loadEnv();
    const db = getDb();
    const user = db
      .select()
      .from(schema.users)
      .where(eq(schema.users.username, parsed.data.username))
      .get();

    let allowCredentialIds: string[] = [];
    if (user) {
      allowCredentialIds = forUser(db, user.id).webauthnCredentials.list().map((c) => c.credentialId);
    } else {
      // Avoid username enumeration: log audit but still return a fake challenge
      emitAudit(db, {
        event: "login.no_user",
        ip: ipOf(c),
        userAgent: uaOf(c),
        metadata: { username: parsed.data.username },
      });
    }

    const options = await buildAuthenticationOptions(env, allowCredentialIds);
    const challengeKey = `login:${options.challenge}`;
    rememberChallenge(challengeKey, {
      challenge: options.challenge,
      userId: user?.id,
    });

    return c.json({ options });
  },
);

const loginVerifySchema = z.object({
  username: z.string().min(1).max(64),
  response: z.unknown(),
});

authRoutes.post(
  "/login/verify",
  rateLimitedByIp("login", RATE_LIMITS.loginPerIp),
  async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = loginVerifySchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "Invalid input" }, 400);
    }

    const env = loadEnv();
    const db = getDb();
    const user = db
      .select()
      .from(schema.users)
      .where(eq(schema.users.username, parsed.data.username))
      .get();
    if (!user) {
      // Generic failure to prevent username enumeration
      return c.json({ error: "Authentication failed" }, 401);
    }

    const responseObj = parsed.data.response as { response: { clientDataJSON: string } } & Record<
      string,
      unknown
    >;
    // Decode clientDataJSON to get the challenge — needed for lookup
    let clientChallenge: string | null = null;
    try {
      const cdJson = JSON.parse(
        Buffer.from(responseObj.response.clientDataJSON, "base64url").toString(),
      ) as { challenge: string };
      clientChallenge = cdJson.challenge;
    } catch {
      return c.json({ error: "Malformed response" }, 400);
    }
    const stored = consumeChallenge(`login:${clientChallenge}`);
    if (!stored) {
      return c.json({ error: "Challenge expired" }, 400);
    }

    const credentialId = (parsed.data.response as { id: string }).id;
    const cred = forUser(db, user.id).webauthnCredentials.byCredentialId(credentialId);
    if (!cred) {
      emitAudit(db, {
        userId: user.id,
        event: "login.fail",
        ip: ipOf(c),
        userAgent: uaOf(c),
        metadata: { reason: "credential_not_found" },
      });
      return c.json({ error: "Authentication failed" }, 401);
    }

    const verification = await verifyAuthentication({
      env,
      expectedChallenge: stored.challenge,
      response: parsed.data.response as Parameters<typeof verifyAuthentication>[0]["response"],
      credential: {
        id: cred.credentialId,
        publicKey: cred.publicKey,
        counter: cred.counter,
        transports: cred.transports ? (JSON.parse(cred.transports) as string[]) : [],
      },
    });

    if (!verification.verified) {
      emitAudit(db, {
        userId: user.id,
        event: "login.fail",
        ip: ipOf(c),
        userAgent: uaOf(c),
        metadata: { reason: "verification_failed" },
      });
      return c.json({ error: "Authentication failed" }, 401);
    }

    const newCounter = verification.authenticationInfo.newCounter;
    forUser(db, user.id).webauthnCredentials.updateCounter(cred.id, newCounter, Date.now());

    // Create session
    const { sessionId, csrfToken } = newSessionTokens();
    const csrfHash = hashCsrfToken(csrfToken, env.HERMES_WEB_SESSION_SECRET);
    forUser(db, user.id).webSessions.insert({
      id: sessionId,
      expiresAt: Date.now() + ABSOLUTE_TIMEOUT_MS,
      ip: ipOf(c),
      userAgent: uaOf(c),
      csrfTokenHash: csrfHash,
    });
    setSessionCookies(c, sessionId, csrfToken);

    emitAudit(db, {
      userId: user.id,
      event: "login.ok",
      ip: ipOf(c),
      userAgent: uaOf(c),
    });

    return c.json({ userId: user.id, username: user.username, csrfToken });
  },
);

// ─── Recovery ───────────────────────────────────────────────────────────

const recoverySchema = z.object({
  username: z.string().min(1).max(64),
  code: z.string().min(8).max(80),
});

authRoutes.post(
  "/recovery",
  rateLimitedByIp("recovery", RATE_LIMITS.recoveryPerIp),
  async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = recoverySchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "Invalid input" }, 400);
    }
    const env = loadEnv();
    const db = getDb();
    const user = db
      .select()
      .from(schema.users)
      .where(eq(schema.users.username, parsed.data.username))
      .get();
    if (!user) {
      return c.json({ error: "Recovery failed" }, 401);
    }

    const codes = forUser(db, user.id).recoveryCodes.listUnused();
    let matchedId: string | null = null;
    for (const c of codes) {
      if (await verifyRecoveryCode(parsed.data.code, c.codeHash)) {
        matchedId = c.id;
        break;
      }
    }
    if (!matchedId) {
      emitAudit(db, {
        userId: user.id,
        event: "recovery.fail",
        ip: ipOf(c),
        userAgent: uaOf(c),
      });
      return c.json({ error: "Recovery failed" }, 401);
    }

    forUser(db, user.id).recoveryCodes.markUsed(matchedId);
    emitAudit(db, {
      userId: user.id,
      event: "recovery.used",
      ip: ipOf(c),
      userAgent: uaOf(c),
    });

    // Issue session
    const { sessionId, csrfToken } = newSessionTokens();
    const csrfHash = hashCsrfToken(csrfToken, env.HERMES_WEB_SESSION_SECRET);
    forUser(db, user.id).webSessions.insert({
      id: sessionId,
      expiresAt: Date.now() + ABSOLUTE_TIMEOUT_MS,
      ip: ipOf(c),
      userAgent: uaOf(c),
      csrfTokenHash: csrfHash,
    });
    setSessionCookies(c, sessionId, csrfToken);

    emitAudit(db, {
      userId: user.id,
      event: "login.ok",
      ip: ipOf(c),
      userAgent: uaOf(c),
      metadata: { method: "recovery" },
    });

    return c.json({ userId: user.id, username: user.username, csrfToken });
  },
);

// ─── Logout ─────────────────────────────────────────────────────────────

authRoutes.post("/logout", authRequired, csrfRequired, async (c) => {
  const user = c.get("user");
  if (!user) return c.json({ error: "Unauthenticated" }, 401);

  const db = getDb();
  forUser(db, user.id).webSessions.revoke(user.sessionId);
  emitAudit(db, {
    userId: user.id,
    event: "logout.ok",
    ip: ipOf(c),
    userAgent: uaOf(c),
  });

  for (const ck of buildClearCookies(loadEnv())) {
    c.header("Set-Cookie", ck, { append: true });
  }
  return c.json({ ok: true });
});

authRoutes.post("/logout-all", authRequired, csrfRequired, async (c) => {
  const user = c.get("user");
  if (!user) return c.json({ error: "Unauthenticated" }, 401);

  const db = getDb();
  const revoked = forUser(db, user.id).webSessions.revokeAll();
  emitAudit(db, {
    userId: user.id,
    event: "session.revoke_all",
    ip: ipOf(c),
    userAgent: uaOf(c),
    metadata: { revoked },
  });

  for (const ck of buildClearCookies(loadEnv())) {
    c.header("Set-Cookie", ck, { append: true });
  }
  return c.json({ ok: true, revoked });
});

// ─── Me ─────────────────────────────────────────────────────────────────

authRoutes.get("/me", authRequired, async (c) => {
  const user = c.get("user");
  if (!user) return c.json({ error: "Unauthenticated" }, 401);
  const env = loadEnv();
  const cookieValue = getCookie(c, CSRF_COOKIE_NAME);
  return c.json({
    userId: user.id,
    username: user.username,
    sessionId: user.sessionId,
    csrfToken: cookieValue ?? null,
    rpId: env.HERMES_WEB_RP_ID,
  });
});

// ─── helpers ────────────────────────────────────────────────────────────

function setSessionCookies(c: Context, sessionId: string, csrfToken: string): void {
  const env = loadEnv();
  const signed = signSessionId(sessionId, env.HERMES_WEB_SESSION_SECRET);
  c.header("Set-Cookie", buildSessionCookie(signed, env), { append: true });
  c.header("Set-Cookie", buildCsrfCookie(csrfToken, env), { append: true });
}

// dummy refs for tree-shaking guards
void logger;
