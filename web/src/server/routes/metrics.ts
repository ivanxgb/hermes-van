/**
 * Metrics dashboard routes — Phase 6.G.
 *
 *   GET /api/metrics/usage   — UsageSummary computed from messages.metadata
 *
 * Read-only; auth required. Scoped per-user — the caller can only see
 * their own message log.
 */
import { Hono } from "hono";
import { authRequired } from "../middleware";
import { getDb } from "../db";
import { logger } from "../lib/logger";
import { hasUsageData, summarizeUsage } from "../lib/metrics";

export const metricsRoutes = new Hono();

metricsRoutes.use("*", authRequired);

metricsRoutes.get("/usage", (c) => {
  const user = c.get("user");
  if (!user) return c.json({ error: "Unauthenticated" }, 401);
  try {
    const db = getDb();
    if (!hasUsageData(db, user.id)) {
      // Empty-but-valid response — UI renders the empty state.
      return c.json({
        totals: {
          messages: 0,
          promptTokens: 0,
          completionTokens: 0,
          estUsd: 0,
          pricelessRows: 0,
        },
        byModel: [],
        byChat: [],
        byDay: [],
      });
    }
    const summary = summarizeUsage(db, user.id);
    return c.json(summary);
  } catch (err) {
    logger.warn({ err }, "metrics summarizeUsage failed");
    return c.json(
      {
        error: "Metrics error",
        detail: err instanceof Error ? err.message : String(err),
      },
      500,
    );
  }
});
