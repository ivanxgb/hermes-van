/**
 * Sliding-window IP rate limiter (in-memory).
 *
 * Phase 1 single-instance simple counter. Phase 5 may move to redis if
 * needed, but for our scale a Map is plenty.
 *
 * Buckets are pruned lazily on every check.
 */

interface Bucket {
  hits: number[];
  blockedUntil: number | null;
}

const buckets = new Map<string, Bucket>();

export interface RateLimitConfig {
  /** Number of allowed events */
  limit: number;
  /** Sliding window in milliseconds */
  windowMs: number;
  /** If hit, block for this many ms */
  blockMs?: number;
}

/**
 * @returns { allowed, retryAfterMs } — allowed=false means caller must reject.
 */
export function rateCheck(
  bucketKey: string,
  cfg: RateLimitConfig,
): { allowed: boolean; retryAfterMs: number } {
  const now = Date.now();
  let bucket = buckets.get(bucketKey);
  if (!bucket) {
    bucket = { hits: [], blockedUntil: null };
    buckets.set(bucketKey, bucket);
  }
  if (bucket.blockedUntil !== null && bucket.blockedUntil > now) {
    return { allowed: false, retryAfterMs: bucket.blockedUntil - now };
  } else if (bucket.blockedUntil !== null) {
    bucket.blockedUntil = null;
  }
  // Drop hits outside window
  const cutoff = now - cfg.windowMs;
  bucket.hits = bucket.hits.filter((t) => t > cutoff);
  if (bucket.hits.length >= cfg.limit) {
    if (cfg.blockMs) {
      bucket.blockedUntil = now + cfg.blockMs;
    }
    return {
      allowed: false,
      retryAfterMs: cfg.blockMs ?? cfg.windowMs,
    };
  }
  bucket.hits.push(now);
  return { allowed: true, retryAfterMs: 0 };
}

/** Test helper: reset all buckets. */
export function _resetRateLimits(): void {
  buckets.clear();
}

// In dev/test the rate limits would chew through legitimate Playwright
// runs in seconds (8+ user registrations per suite > 10/h cap). The
// Phase 1 thresholds remain canonical for production; we relax them
// off-prod so e2e doesn't fight the rate limiter.
const isProd = process.env["NODE_ENV"] === "production";
const PROD_TO_DEV_MULT = isProd ? 1 : 100;

export const RATE_LIMITS = {
  loginPerIp: {
    limit: 5 * PROD_TO_DEV_MULT,
    windowMs: 15 * 60 * 1000, // 15 min
    blockMs: 15 * 60 * 1000,
  } satisfies RateLimitConfig,
  loginPerUser: {
    limit: 10 * PROD_TO_DEV_MULT,
    windowMs: 60 * 60 * 1000, // 1 hour
    blockMs: 30 * 60 * 1000,
  } satisfies RateLimitConfig,
  recoveryPerIp: {
    limit: 3 * PROD_TO_DEV_MULT,
    windowMs: 60 * 60 * 1000, // 1 hour
    blockMs: 60 * 60 * 1000,
  } satisfies RateLimitConfig,
  setupPerIp: {
    limit: 10 * PROD_TO_DEV_MULT,
    windowMs: 60 * 60 * 1000,
    blockMs: 60 * 60 * 1000,
  } satisfies RateLimitConfig,
};
