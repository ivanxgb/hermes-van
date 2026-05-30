/**
 * Security incident alerter.
 *
 * Fires a JSON POST to HERMES_VAN_ALERT_WEBHOOK whenever a high-severity
 * audit event lands. Designed for fan-out to Slack/Discord/Telegram bot
 * proxies or the Hermes gateway's webhook ingress — they all accept
 * application/json and we don't try to format-guess.
 *
 * The send is fire-and-forget on a microtask: we do NOT block the auth
 * route. If the webhook is unreachable, the failure goes to the logger
 * and lifey-cycle moves on. The alerter is never the reason a login or
 * a revoke succeeds or fails.
 *
 * Contract:
 *   - When the webhook env is unset, this module is a no-op (logs once
 *     at debug level on the first dropped event per process).
 *   - Payload is intentionally compact (so Slack/Discord can still
 *     render it; full audit metadata stays in the DB).
 *   - Bearer auth is optional — set HERMES_VAN_ALERT_BEARER if your
 *     receiver expects an Authorization header.
 *   - Send timeout is 5s. The receiver decides what to do with the body.
 */
import { logger } from "./logger";
import { loadEnv } from "./env";

/** Severity tier for routing/quieting on the receiver side. */
export type AlertSeverity = "info" | "warning" | "critical";

export interface AlertPayload {
  /** Slug used by the receiver to route or de-dup. */
  event: string;
  severity: AlertSeverity;
  /** Short human-friendly headline. */
  title: string;
  /** Optional longer description. */
  description?: string;
  /** Free-form context the receiver may render. */
  metadata?: Record<string, unknown>;
}

let warnedDisabled = false;

/**
 * Fire-and-forget alert dispatch. Returns immediately; the actual
 * network round-trip happens on a microtask.
 */
export function fireAlert(payload: AlertPayload): void {
  const env = loadEnv();
  if (!env.HERMES_VAN_ALERT_WEBHOOK) {
    if (!warnedDisabled) {
      warnedDisabled = true;
      logger.debug({}, "alerts: HERMES_VAN_ALERT_WEBHOOK unset, dropping");
    }
    return;
  }

  // Don't await — fire-and-forget.
  void deliver(env.HERMES_VAN_ALERT_WEBHOOK, env.HERMES_VAN_ALERT_BEARER, payload).catch(
    (err) => {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err), event: payload.event },
        "alerts: dispatch failed",
      );
    },
  );
}

async function deliver(
  url: string,
  bearer: string | undefined,
  payload: AlertPayload,
): Promise<void> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "User-Agent": "hermes-van-alerter/1.0",
  };
  if (bearer) headers["Authorization"] = `Bearer ${bearer}`;

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 5_000);

  // Add a stable timestamp + service tag so the receiver can group
  // correctly across instances.
  const body = JSON.stringify({
    service: "hermes-van",
    ts: new Date().toISOString(),
    ...payload,
  });

  try {
    const res = await fetch(url, {
      method: "POST",
      headers,
      body,
      signal: ctrl.signal,
    });
    if (!res.ok) {
      logger.warn(
        { status: res.status, event: payload.event },
        "alerts: receiver returned non-2xx",
      );
    }
  } finally {
    clearTimeout(t);
  }
}

/** Test-only: reset the warned-once flag. */
export function _resetAlertCache(): void {
  warnedDisabled = false;
}
