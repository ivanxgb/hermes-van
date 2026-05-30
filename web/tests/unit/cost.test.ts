/**
 * Phase 6.G — cost.ts unit tests.
 *
 *   1. pickPrice matches by case-insensitive substring (anthropic/claude-...
 *      → claude-sonnet-4 entry).
 *   2. Unknown models return null (we never silently fall back).
 *   3. normalizeUsage handles top-level + nested shapes + Anthropic
 *      input_tokens / output_tokens naming.
 *   4. costFor returns 0 for unknown models and dollar values for known.
 *   5. Catalog invariants: every entry has positive prices.
 */
import { describe, expect, test } from "vitest";
import {
  MODEL_PRICES,
  costFor,
  normalizeUsage,
  pickPrice,
} from "../../src/server/lib/cost";

describe("pickPrice", () => {
  test("matches case-insensitive substring", () => {
    expect(pickPrice("anthropic/claude-sonnet-4-5")).toEqual(
      MODEL_PRICES["claude-sonnet-4"],
    );
    expect(pickPrice("Claude-Opus-4-1")).toEqual(MODEL_PRICES["claude-opus-4"]);
    expect(pickPrice("openai/gpt-4o-mini-2024-07")).toEqual(
      MODEL_PRICES["gpt-4o-mini"],
    );
  });

  test("returns null for unknown models", () => {
    expect(pickPrice("vendor/unknown-model-xyz")).toBeNull();
    expect(pickPrice("")).toBeNull();
    expect(pickPrice(null)).toBeNull();
    expect(pickPrice(undefined)).toBeNull();
  });
});

describe("normalizeUsage", () => {
  test("nested under usage with prompt_tokens / completion_tokens", () => {
    expect(
      normalizeUsage({ usage: { prompt_tokens: 10, completion_tokens: 5 } }),
    ).toEqual({ promptTokens: 10, completionTokens: 5 });
  });

  test("top-level prompt_tokens / completion_tokens", () => {
    expect(
      normalizeUsage({ prompt_tokens: 4, completion_tokens: 12 }),
    ).toEqual({ promptTokens: 4, completionTokens: 12 });
  });

  test("Anthropic-style input_tokens / output_tokens nested", () => {
    expect(
      normalizeUsage({ usage: { input_tokens: 100, output_tokens: 200 } }),
    ).toEqual({ promptTokens: 100, completionTokens: 200 });
  });

  test("camelCase variant", () => {
    expect(
      normalizeUsage({ promptTokens: 7, completionTokens: 9 }),
    ).toEqual({ promptTokens: 7, completionTokens: 9 });
  });

  test("returns null for empty/zero usage", () => {
    expect(normalizeUsage(null)).toBeNull();
    expect(normalizeUsage({})).toBeNull();
    expect(normalizeUsage({ prompt_tokens: 0, completion_tokens: 0 })).toBeNull();
    expect(normalizeUsage("not an object")).toBeNull();
  });
});

describe("costFor", () => {
  test("returns 0 when model is unknown", () => {
    expect(
      costFor({ promptTokens: 1000, completionTokens: 500 }, "unknown-model"),
    ).toBe(0);
  });

  test("calculates expected USD for claude-sonnet-4 (3/15 per M)", () => {
    // 1M prompt + 1M completion = 3 + 15 = $18
    const c = costFor(
      { promptTokens: 1_000_000, completionTokens: 1_000_000 },
      "claude-sonnet-4",
    );
    expect(c).toBeCloseTo(18, 5);
  });

  test("scales linearly with token counts", () => {
    const u1 = { promptTokens: 1_000, completionTokens: 1_000 };
    const u2 = { promptTokens: 2_000, completionTokens: 2_000 };
    expect(costFor(u2, "gpt-4o")).toBeCloseTo(costFor(u1, "gpt-4o") * 2, 8);
  });
});

describe("MODEL_PRICES catalog", () => {
  test("every entry has positive input + output prices", () => {
    for (const [name, p] of Object.entries(MODEL_PRICES)) {
      expect(p.input, `${name} input must be > 0`).toBeGreaterThan(0);
      expect(p.output, `${name} output must be > 0`).toBeGreaterThan(0);
    }
  });

  test("output price is always >= input price for any single model", () => {
    // Known industry pattern: completions are at least as expensive
    // as prompts. If this stops being true for a future model we'll
    // explicitly relax the assertion in the same commit.
    for (const [name, p] of Object.entries(MODEL_PRICES)) {
      expect(p.output, `${name} output >= input`).toBeGreaterThanOrEqual(p.input);
    }
  });
});
