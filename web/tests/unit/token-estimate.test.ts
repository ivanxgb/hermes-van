/**
 * Token estimate tests — heuristic, not a real tokenizer.
 *
 * Coverage:
 *   1. Empty / whitespace-only → 0.
 *   2. ASCII prose → ~chars/4, rounded up.
 *   3. CJK string → roughly 1 token per character.
 *   4. Mixed string → ASCII contribution + CJK contribution.
 *   5. Single short word → minimum 1 token.
 *   6. formatTokens(): plain "≈N tokens" under 1k, "≈1.2k tokens" above.
 */
import { describe, expect, test } from "vitest";
import { estimateTokens, formatTokens } from "../../src/lib/token-estimate";

describe("estimateTokens", () => {
  test("empty / whitespace returns 0", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("   \n\t  ")).toBe(0);
  });

  test("ASCII prose ≈ chars / 4", () => {
    // 24 chars (after trim) → ceil(24/4) = 6
    expect(estimateTokens("hello world hello world!")).toBe(6);
    // 16 chars → ceil(16/4) = 4
    expect(estimateTokens("the quick brown ")).toBe(4);
  });

  test("CJK string ≈ 1 token per codepoint", () => {
    // 5 CJK chars → 5 tokens (no ASCII contribution).
    expect(estimateTokens("你好世界吗")).toBe(5);
  });

  test("mixed ASCII + CJK adds both contributions", () => {
    // "hello " (6 ascii incl. trailing space) trimmed → 5 ascii =>
    // ceil(5/4) = 2 ; plus 2 CJK = 4 total.
    expect(estimateTokens("hello 你好")).toBe(4);
  });

  test("single short word floors at 1 token", () => {
    expect(estimateTokens("hi")).toBe(1);
    expect(estimateTokens("a")).toBe(1);
  });
});

describe("formatTokens", () => {
  test("under 1000 uses plain integer", () => {
    expect(formatTokens(0)).toBe("≈0 tokens");
    expect(formatTokens(7)).toBe("≈7 tokens");
    expect(formatTokens(999)).toBe("≈999 tokens");
  });

  test("≥1000 collapses to 1 decimal k", () => {
    expect(formatTokens(1000)).toBe("≈1.0k tokens");
    expect(formatTokens(1234)).toBe("≈1.2k tokens");
    expect(formatTokens(12500)).toBe("≈12.5k tokens");
  });
});
