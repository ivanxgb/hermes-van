/**
 * Rough token estimator for displaying a "tokens" hint in the composer.
 *
 * This is intentionally NOT a real BPE tokenizer — bundling a true
 * tokenizer (gpt-tokenizer ships ~2MB minified, tiktoken-wasm even
 * heavier) would balloon the bundle and the answer is still model-
 * specific. A char-count heuristic is good enough for a "your message
 * is ~N tokens" hint.
 *
 * Heuristic:
 *   - English-ish prose: ~4 chars per token (OpenAI's published rule).
 *   - CJK / heavy unicode: each codepoint ≈ 1 token (most BPE models
 *     fragment them more than ASCII), so we count graphemes too.
 *   - Whitespace-only doesn't add tokens.
 *
 * The estimate is rounded up because users care more about not
 * overshooting context than about precision in the low end.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  const trimmed = text.trim();
  if (!trimmed) return 0;

  const chars = trimmed.length;

  // Count CJK / non-ASCII codepoints; each gets ≈1 token in most BPE.
  let cjk = 0;
  for (const ch of trimmed) {
    const code = ch.codePointAt(0) ?? 0;
    if (code > 0x3000) cjk += 1;
  }
  const asciiChars = chars - cjk;
  const asciiTokens = Math.ceil(asciiChars / 4);
  return Math.max(1, asciiTokens + cjk);
}

/**
 * Format a token count for display. Returns "≈12 tokens" for small
 * counts and "≈1.2k tokens" once we cross 1000.
 */
export function formatTokens(n: number): string {
  if (n < 1000) return `≈${n} tokens`;
  return `≈${(n / 1000).toFixed(1)}k tokens`;
}
