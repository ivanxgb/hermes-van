/**
 * Derive a short, human-friendly chat title from the first user message.
 *
 * Rules:
 *  - Strip leading/trailing whitespace.
 *  - Take the first line (newline-bounded). Multi-line prompts often
 *    start with the question and follow with code/context — using the
 *    first line keeps the gist.
 *  - Drop trailing punctuation that adds no info (?!. spaces).
 *  - Cap at MAX_LEN characters; if we cut, append a single ellipsis.
 *  - If the result is shorter than MIN_LEN, fall back to "New chat" so
 *    we don't replace a meaningful default with garbage.
 *
 * Pure function — no I/O. Deterministic for testing.
 */
const MAX_LEN = 60;
const MIN_LEN = 3;

export function deriveChatTitle(input: string): string {
  if (!input) return "New chat";
  const firstLine = input.replace(/\r\n/g, "\n").split("\n")[0] ?? "";
  let cleaned = firstLine.trim();
  // Strip surrounding markdown emphasis / code fences if the user
  // pasted them in (e.g. "**fix the bug**").
  cleaned = cleaned.replace(/^[`*_~]+|[`*_~]+$/g, "").trim();
  if (cleaned.length < MIN_LEN) return "New chat";
  if (cleaned.length <= MAX_LEN) return cleaned.replace(/[.!?]+$/, "").trim();
  // Cut at the last word boundary before MAX_LEN to avoid mid-word breaks.
  const slice = cleaned.slice(0, MAX_LEN);
  const lastSpace = slice.lastIndexOf(" ");
  const cut = lastSpace > MAX_LEN * 0.6 ? slice.slice(0, lastSpace) : slice;
  return `${cut.replace(/[.!?,;:]+$/, "").trim()}…`;
}
