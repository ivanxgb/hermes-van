import { describe, expect, it } from "vitest";
import {
  generateBatch,
  generateCode,
  hashCode,
  normalize,
  verifyCode,
  constantTimeEqual,
} from "./recovery";

describe("generateCode", () => {
  it("produces 5 groups of 5 separated by hyphens", () => {
    const code = generateCode();
    expect(code).toMatch(/^[A-Z0-9]{5}(-[A-Z0-9]{5}){4}$/);
  });

  it("uses no vowels or 0/1", () => {
    for (let i = 0; i < 20; i++) {
      const code = generateCode();
      expect(code).not.toMatch(/[AEIOU01]/);
    }
  });
});

describe("generateBatch", () => {
  it("returns 10 unique codes", () => {
    const batch = generateBatch();
    expect(batch).toHaveLength(10);
    expect(new Set(batch).size).toBe(10);
  });
});

describe("normalize", () => {
  it("strips whitespace and hyphens; uppercases", () => {
    expect(normalize("  abc-de fg  ")).toBe("ABCDEFG");
    expect(normalize("AbC-dEf")).toBe("ABCDEF");
  });
});

describe("hashCode + verifyCode", () => {
  it("verifies the original code", async () => {
    const code = generateCode();
    const h = await hashCode(code);
    expect(await verifyCode(code, h)).toBe(true);
  });

  it("verifies normalized variants", async () => {
    const code = generateCode();
    const h = await hashCode(code);
    // user types it lowercase without hyphens — should still match
    expect(await verifyCode(code.toLowerCase().replace(/-/g, ""), h)).toBe(true);
  });

  it("rejects wrong codes", async () => {
    const h = await hashCode("ABCDE-FGHIJ-KLMNP-QRSTU-VWXYZ");
    expect(await verifyCode("ZZZZZ-ZZZZZ-ZZZZZ-ZZZZZ-ZZZZZ", h)).toBe(false);
  });

  it("rejects on malformed hash", async () => {
    expect(await verifyCode("any", "not-an-argon2-hash")).toBe(false);
  });
});

describe("constantTimeEqual", () => {
  it("equal strings", () => {
    expect(constantTimeEqual("abc", "abc")).toBe(true);
  });

  it("different strings", () => {
    expect(constantTimeEqual("abc", "abd")).toBe(false);
  });

  it("different lengths", () => {
    expect(constantTimeEqual("a", "ab")).toBe(false);
  });
});
