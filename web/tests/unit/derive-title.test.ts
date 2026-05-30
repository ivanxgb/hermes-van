// @vitest-environment node
import { describe, expect, test } from "vitest";
import { deriveChatTitle } from "../../src/lib/derive-title";

describe("deriveChatTitle", () => {
  test("empty input → 'New chat'", () => {
    expect(deriveChatTitle("")).toBe("New chat");
    expect(deriveChatTitle("   ")).toBe("New chat");
  });

  test("very short input → 'New chat'", () => {
    expect(deriveChatTitle("hi")).toBe("New chat");
  });

  test("short message returns the trimmed line", () => {
    expect(deriveChatTitle("Refactor the auth flow")).toBe(
      "Refactor the auth flow",
    );
  });

  test("strips trailing punctuation", () => {
    expect(deriveChatTitle("How do I deploy?")).toBe("How do I deploy");
    expect(deriveChatTitle("Fix the bug!!!")).toBe("Fix the bug");
  });

  test("uses only the first line of multi-line prompts", () => {
    expect(
      deriveChatTitle("Audit my code\n\n```js\nconst x = 1;\n```"),
    ).toBe("Audit my code");
  });

  test("strips surrounding markdown emphasis", () => {
    expect(deriveChatTitle("**fix the bug**")).toBe("fix the bug");
    expect(deriveChatTitle("`hello world`")).toBe("hello world");
  });

  test("long lines are truncated at word boundary with ellipsis", () => {
    const long =
      "Walk me through how to set up a complete production deployment pipeline including CI";
    const out = deriveChatTitle(long);
    expect(out.endsWith("…")).toBe(true);
    expect(out.length).toBeLessThanOrEqual(61);
    expect(out.startsWith("Walk me through")).toBe(true);
  });

  test("CRLF line endings are normalized", () => {
    expect(deriveChatTitle("first line\r\nsecond")).toBe("first line");
  });
});
