/**
 * Web Push (VAPID) helper.
 *
 * Wraps the `web-push` library so the rest of the codebase only deals
 * with our shape: pushToUser(userId, payload). VAPID keys come from env;
 * if either key is missing the helper degrades to no-op so dev/test
 * works without hitting Apple/Google push services.
 *
 * Why VAPID? It's the only standardized auth model for Web Push, and
 * it avoids any cloud vendor (FCM/APNs handle delivery via the
 * subscription's `endpoint` URL but VAPID identifies us as the sender).
 *
 * Generation:
 *   pnpm hermes-van:vapid    # writes new keys; print to stdout for .env
 */
import webpush from "web-push";
import { logger } from "./logger";
import { loadEnv } from "./env";
import { getDb } from "../db";
import { forUser } from "../db/scoped";
import * as schema from "../db/schema";

let configured = false;

function ensureConfigured(): boolean {
  if (configured) return true;
  const env = loadEnv();
  if (!env.HERMES_VAN_VAPID_PUBLIC || !env.HERMES_VAN_VAPID_PRIVATE) {
    return false;
  }
  webpush.setVapidDetails(
    env.HERMES_VAN_VAPID_SUBJECT,
    env.HERMES_VAN_VAPID_PUBLIC,
    env.HERMES_VAN_VAPID_PRIVATE,
  );
  configured = true;
  return true;
}

/** Returns the public key, or null if push is disabled. */
export function vapidPublicKey(): string | null {
  const env = loadEnv();
  return env.HERMES_VAN_VAPID_PUBLIC ?? null;
}

export interface PushPayload {
  title: string;
  body: string;
  /** Optional URL the SW should open() on click. */
  url?: string;
  /** Tag groups duplicate notifications under one. */
  tag?: string;
}

export interface PushResult {
  sent: number;
  failed: number;
  removed: number;
}

/**
 * Push a payload to every registered subscription for the user. Failed
 * subscriptions get their fail counter bumped; on 410 Gone or 404 the
 * subscription is removed (the browser threw it away on the client).
 *
 * Returns counts; the caller decides how to surface them. Doesn't throw
 * unless VAPID keys are misconfigured (programming error).
 */
export async function pushToUser(userId: string, payload: PushPayload): Promise<PushResult> {
  if (!ensureConfigured()) {
    logger.debug({ userId }, "push: VAPID not configured, skipping");
    return { sent: 0, failed: 0, removed: 0 };
  }

  const scoped = forUser(getDb(), userId);
  const subs = scoped.pushSubscriptions.list();
  if (subs.length === 0) return { sent: 0, failed: 0, removed: 0 };

  let sent = 0;
  let failed = 0;
  let removed = 0;

  await Promise.all(
    subs.map(async (s) => {
      try {
        await webpush.sendNotification(
          { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
          JSON.stringify(payload),
          { TTL: 60 },
        );
        sent++;
      } catch (err) {
        const status =
          err && typeof err === "object" && "statusCode" in err
            ? (err as { statusCode: number }).statusCode
            : 0;
        if (status === 404 || status === 410) {
          scoped.pushSubscriptions.deleteByEndpoint(s.endpoint);
          removed++;
          logger.info({ userId, endpoint: s.endpoint, status }, "push: subscription gone, removed");
        } else {
          scoped.pushSubscriptions.incrementFail(s.id);
          failed++;
          logger.warn(
            { userId, endpoint: s.endpoint, status, err: String(err).slice(0, 200) },
            "push: send failed",
          );
        }
      }
    }),
  );

  return { sent, failed, removed };
}

/** Test-only: reset configured flag so a new env can be picked up. */
export function _resetVapidCache(): void {
  configured = false;
}

/**
 * Push a payload to EVERY active subscription regardless of user.
 *
 * Used by the SIGTERM hook so the server can tell every connected
 * client "I'm restarting, reload when you can." Bounded: caps total
 * fanout at 200 to avoid making shutdown wait on a giant queue.
 *
 * Returns counts; same shape as pushToUser.
 */
export async function pushToAll(payload: PushPayload, opts?: { limitMs?: number }): Promise<PushResult> {
  if (!ensureConfigured()) {
    return { sent: 0, failed: 0, removed: 0 };
  }
  const raw = getDb();
  const subs = raw
    .select()
    .from(schema.pushSubscriptions)
    .limit(200)
    .all();
  if (subs.length === 0) return { sent: 0, failed: 0, removed: 0 };

  let sent = 0;
  let failed = 0;
  const limitMs = opts?.limitMs ?? 4000;
  const deadline = Date.now() + limitMs;

  await Promise.allSettled(
    subs.map(async (s) => {
      if (Date.now() > deadline) return;
      try {
        await webpush.sendNotification(
          { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
          JSON.stringify(payload),
          { TTL: 30 },
        );
        sent++;
      } catch {
        failed++;
        // Don't bother updating fail counters on shutdown — we're dying.
      }
    }),
  );

  return { sent, failed, removed: 0 };
}
