/**
 * Phase 6.E — diff renderer unit tests.
 *
 * Two layers of coverage:
 *
 *   A. The pure classifier (classifyDiffLine) and isDiffLang — small,
 *      property-style checks that all the leading-char rules behave
 *      correctly with and without `inHunk` state.
 *
 *   B. renderDiff() output shape — assert the produced HTML carries
 *      the right per-line classes and escapes HTML metacharacters
 *      (defends against an attacker pasting `<script>` into a diff).
 *
 *   C. End-to-end through renderMarkdown() — make sure the marked
 *      renderer override fires for ```diff fences and that DOMPurify
 *      lets the .diff-block + .diff-line classes through.
 */
// @vitest-environment jsdom
import { describe, expect, test } from "vitest";
import {
  classifyDiffLine,
  isDiffLang,
  renderDiff,
} from "../../src/lib/diff";
import { renderMarkdown } from "../../src/lib/markdown";

describe("isDiffLang", () => {
  test("recognises canonical names + common aliases", () => {
    for (const lang of ["diff", "patch", "udiff", "DIFF", "Patch", "diff foo"]) {
      expect(isDiffLang(lang)).toBe(true);
    }
  });

  test("does not match other languages", () => {
    for (const lang of ["", "ts", "typescript", "bash", "json", "diff2", null, undefined]) {
      expect(isDiffLang(lang as string | null | undefined)).toBe(false);
    }
  });
});

describe("classifyDiffLine", () => {
  test("@@ headers are always hunks (regardless of state)", () => {
    expect(classifyDiffLine("@@ -1,3 +1,3 @@", false)).toBe("hunk");
    expect(classifyDiffLine("@@ -1,3 +1,3 @@", true)).toBe("hunk");
  });

  test("pre-hunk lines are meta", () => {
    for (const line of [
      "diff --git a/foo.ts b/foo.ts",
      "index abc..def 100644",
      "--- a/foo.ts",
      "+++ b/foo.ts",
      "old mode 100644",
    ]) {
      expect(classifyDiffLine(line, false)).toBe("meta");
    }
  });

  test("in-hunk classification by leading char", () => {
    expect(classifyDiffLine("+added", true)).toBe("add");
    expect(classifyDiffLine("-removed", true)).toBe("remove");
    expect(classifyDiffLine(" context", true)).toBe("context");
    expect(classifyDiffLine("", true)).toBe("context");
    expect(classifyDiffLine("\\ No newline at end of file", true)).toBe("meta");
  });

  test("multi-file --- / +++ inside hunks still classify as meta", () => {
    expect(classifyDiffLine("--- a/file2.ts", true)).toBe("meta");
    expect(classifyDiffLine("+++ b/file2.ts", true)).toBe("meta");
  });
});

describe("renderDiff", () => {
  test("produces a diff-block container and per-line divs", () => {
    const html = renderDiff(
      [
        "--- a/foo.ts",
        "+++ b/foo.ts",
        "@@ -1,3 +1,3 @@",
        " context",
        "-removed",
        "+added",
      ].join("\n"),
    );
    expect(html.startsWith('<div class="diff-block">')).toBe(true);
    expect(html.endsWith("</div>")).toBe(true);
    expect(html).toContain('<div class="diff-line meta">--- a/foo.ts</div>');
    expect(html).toContain('<div class="diff-line meta">+++ b/foo.ts</div>');
    expect(html).toContain('<div class="diff-line hunk">@@ -1,3 +1,3 @@</div>');
    expect(html).toContain('<div class="diff-line context"> context</div>');
    expect(html).toContain('<div class="diff-line remove">-removed</div>');
    expect(html).toContain('<div class="diff-line add">+added</div>');
  });

  test("escapes HTML metacharacters inside content", () => {
    const html = renderDiff(
      [
        "@@ -1 +1 @@",
        '-<script>alert("xss")</script>',
        '+<img src=x onerror=alert(1)>',
      ].join("\n"),
    );
    // No raw < > " inside text — every metachar must be escaped.
    expect(html).not.toMatch(/<script>/);
    expect(html).not.toMatch(/<img /);
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
  });

  test("preserves leading whitespace in context lines (column alignment)", () => {
    const html = renderDiff([
      "@@ -1 +1 @@",
      "    indented context",
    ].join("\n"));
    expect(html).toContain('<div class="diff-line context">    indented context</div>');
  });

  test("tolerates a single trailing newline (the fence closer)", () => {
    const html = renderDiff("@@ -1 +1 @@\n+x\n");
    // Two lines emitted, no empty trailing div.
    expect(html.match(/<div class="diff-line/g)?.length).toBe(2);
  });
});

describe("renderMarkdown integration", () => {
  test("```diff fences route through renderDiff and survive sanitization", () => {
    const md = [
      "```diff",
      "--- a/x",
      "+++ b/x",
      "@@ -1 +1 @@",
      "-old",
      "+new",
      "```",
    ].join("\n");
    const html = renderMarkdown(md);
    expect(html).toContain('class="diff-block"');
    expect(html).toMatch(/class="diff-line meta"/);
    expect(html).toMatch(/class="diff-line add"/);
    expect(html).toMatch(/class="diff-line remove"/);
    expect(html).toMatch(/class="diff-line hunk"/);
  });

  test("```patch fences also render as diffs", () => {
    const html = renderMarkdown("```patch\n@@ -1 +1 @@\n+yes\n```");
    expect(html).toContain('class="diff-block"');
    expect(html).toMatch(/class="diff-line add"/);
  });

  test("regular ```ts fences are unaffected (no diff classes)", () => {
    const html = renderMarkdown("```ts\nconst a = 1;\n```");
    expect(html).not.toContain("diff-block");
    expect(html).toContain("<pre>");
  });
});
