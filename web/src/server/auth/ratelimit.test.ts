import { describe, expect, it, beforeEach } from "vitest";
import { rateCheck, _resetRateLimits, RATE_LIMITS } from "./ratelimit";

describe("rateCheck", () => {
  beforeEach(() => _resetRateLimits());

  it("allows up to limit, denies thereafter", () => {
    const cfg = { limit: 3, windowMs: 1000 };
    expect(rateCheck("a", cfg).allowed).toBe(true);
    expect(rateCheck("a", cfg).allowed).toBe(true);
    expect(rateCheck("a", cfg).allowed).toBe(true);
    expect(rateCheck("a", cfg).allowed).toBe(false);
  });

  it("isolates buckets by key", () => {
    const cfg = { limit: 1, windowMs: 1000 };
    expect(rateCheck("a", cfg).allowed).toBe(true);
    expect(rateCheck("b", cfg).allowed).toBe(true);
    expect(rateCheck("a", cfg).allowed).toBe(false);
    expect(rateCheck("b", cfg).allowed).toBe(false);
  });

  it("returns retryAfterMs when blocked", () => {
    const cfg = { limit: 1, windowMs: 1000, blockMs: 5000 };
    rateCheck("c", cfg);
    const r = rateCheck("c", cfg);
    expect(r.allowed).toBe(false);
    expect(r.retryAfterMs).toBeGreaterThan(0);
    expect(r.retryAfterMs).toBeLessThanOrEqual(5000);
  });

  it("RATE_LIMITS contains expected keys", () => {
    expect(RATE_LIMITS.loginPerIp.limit).toBe(5);
    expect(RATE_LIMITS.recoveryPerIp.limit).toBe(3);
    expect(RATE_LIMITS.setupPerIp.limit).toBe(10);
  });
});
