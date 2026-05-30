/**
 * Diff / patch renderer — Phase 6.E.
 *
 * Takes the body of a fenced code block (lang == "diff" or "patch")
 * and returns sanitization-friendly HTML with per-line classes:
 *
 *   <div class="diff-block">
 *     <div class="diff-line hunk">@@ -1,5 +1,7 @@</div>
 *     <div class="diff-line meta">--- a/foo.ts</div>
 *     <div class="diff-line meta">+++ b/foo.ts</div>
 *     <div class="diff-line context">  unchanged line</div>
 *     <div class="diff-line add">+  added line</div>
 *     <div class="diff-line remove">-  removed line</div>
 *   </div>
 *
 * Why DIY instead of pulling diff2html / shiki:
 *   - Both pull >1MB of dependencies and themes we don't need.
 *   - Our markdown sanitizer (DOMPurify) already understands span/div +
 *     class, so this output passes through cleanly.
 *   - The format is well-defined enough that a 50-line classifier is
 *     correct for unified diffs (the only format the agent emits).
 *
 * The classifier is intentionally line-shaped, not range-aware: each
 * line is classified by its leading char. That misclassifies edge
 * cases like a content line that happens to start with "+" or "-" if
 * we're not inside a hunk — but unified diffs always introduce hunks
 * with `@@`, so we just track in-hunk state and treat pre-hunk lines
 * as `meta`.
 */
const ESC_HTML = /[&<>"]/g;
const ESC_HTML_MAP: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
};

function escapeHtml(s: string): string {
  return s.replace(ESC_HTML, (c) => ESC_HTML_MAP[c] ?? c);
}

export type DiffLineKind = "add" | "remove" | "context" | "hunk" | "meta";

export interface ClassifiedDiffLine {
  kind: DiffLineKind;
  raw: string;
}

/**
 * Classify a single line. Pure function — no state. The `inHunk` flag
 * disambiguates content lines (which need a hunk header above them to
 * be considered add/remove) from header lines like `--- a/file`.
 */
export function classifyDiffLine(line: string, inHunk: boolean): DiffLineKind {
  if (line.startsWith("@@")) return "hunk";
  if (!inHunk) {
    // Pre-hunk metadata: index/diff/--- /+++ /old mode/new mode/etc.
    return "meta";
  }
  if (line.startsWith("+++")) return "meta"; // file header inside multi-file patches
  if (line.startsWith("---")) return "meta";
  if (line.startsWith("+")) return "add";
  if (line.startsWith("-")) return "remove";
  if (line.startsWith("\\")) return "meta"; // \ No newline at end of file
  // " ", "" (empty diff line), or any other → context.
  return "context";
}

/**
 * Render an entire diff body to HTML. Each line becomes a div with
 * `diff-line <kind>`. Whitespace is preserved verbatim — we never
 * collapse leading spaces because diff context relies on column
 * alignment to be readable.
 */
export function renderDiff(code: string): string {
  const lines = code.split("\n");
  // Trim only one trailing empty line that comes from the final \n
  // before the fence; preserve all internal blank lines.
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();

  let inHunk = false;
  const out: string[] = ['<div class="diff-block">'];
  for (const line of lines) {
    const kind = classifyDiffLine(line, inHunk);
    if (kind === "hunk") inHunk = true;
    out.push(`<div class="diff-line ${kind}">${escapeHtml(line)}</div>`);
  }
  out.push("</div>");
  return out.join("");
}

/**
 * True when a fenced-code language tag should trigger diff rendering.
 * Accepts the canonical names plus a few aliases agents commonly emit.
 */
export function isDiffLang(lang: string | undefined | null): boolean {
  if (!lang) return false;
  const norm = lang.trim().toLowerCase().split(/\s+/, 1)[0]!;
  return norm === "diff" || norm === "patch" || norm === "udiff";
}
