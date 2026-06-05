/**
 * LLM cost estimator — Phase 6.G.
 *
 * Maps a model identifier to a USD price-per-million-tokens for input
 * and output, then computes the dollar cost of a usage record. The
 * model→price table covers the providers the user is most likely to
 * route through their gateway (Anthropic Sonnet/Opus, OpenAI GPT-4o
 * / o-series, Mistral, common open-weights via OpenRouter).
 *
 * Why bake the table in here instead of fetching it:
 *   - The dashboard is a UX nicety, not a billing system. Off-by-a-few-
 *     percent estimates are fine.
 *   - Prices change rarely (weeks → months). Pinning them in source
 *     keeps the dashboard offline-capable and traceable in git history.
 *   - Adding a new model is a one-line PR.
 *
 * If a model isn't in the table, costAt() returns 0 and the UI shows
 * "—" so the operator knows to add it. We never silently fall back to
 * a generic price.
 *
 * Token shape: every provider we care about returns
 *   { prompt_tokens, completion_tokens }
 * either at the top level or under `usage` (sometimes nested as
 * `input_tokens` / `output_tokens` on Anthropic's responses API).
 * normalizeUsage() handles both.
 */
export interface UsageRecord {
  promptTokens: number;
  completionTokens: number;
}

export interface PricePoint {
  /** USD per 1M input/prompt tokens. */
  input: number;
  /** USD per 1M output/completion tokens. */
  output: number;
}

/**
 * Model → price catalog. Keys are matched case-insensitively against
 * a substring of the reported model id, so `claude-sonnet-4-5` and
 * `anthropic/claude-sonnet-4` both hit the `claude-sonnet-4` entry.
 *
 * Order matters when multiple keys could match — pickPrice() returns
 * the first hit when iterating insertion order, so list more specific
 * keys before generic ones.
 *
 * Prices last reviewed: May 2026. Bump when providers ship new tiers.
 */
export const MODEL_PRICES: Record<string, PricePoint> = {
  // Anthropic
  "claude-opus-4": { input: 15, output: 75 },
  "claude-sonnet-4": { input: 3, output: 15 },
  "claude-haiku-4": { input: 0.8, output: 4 },
  "claude-3-5-sonnet": { input: 3, output: 15 },
  "claude-3-5-haiku": { input: 0.8, output: 4 },
  "claude-3-opus": { input: 15, output: 75 },
  // OpenAI
  "gpt-4o-mini": { input: 0.15, output: 0.6 },
  "gpt-4o": { input: 2.5, output: 10 },
  "gpt-4-turbo": { input: 10, output: 30 },
  o1: { input: 15, output: 60 },
  "o1-mini": { input: 3, output: 12 },
  // Mistral / open-weights via providers like OpenRouter
  "mistral-large": { input: 2, output: 6 },
  "mistral-medium": { input: 0.4, output: 2 },
  "deepseek-chat": { input: 0.27, output: 1.1 },
  "deepseek-coder": { input: 0.27, output: 1.1 },
  "llama-3.1-405b": { input: 3, output: 3 },
  "llama-3.1-70b": { input: 0.5, output: 0.75 },
};

export function pickPrice(model: string | null | undefined): PricePoint | null {
  if (!model) return null;
  const norm = model.toLowerCase();
  for (const [key, price] of Object.entries(MODEL_PRICES)) {
    if (norm.includes(key.toLowerCase())) return price;
  }
  return null;
}

/**
 * Read a `usage` blob in any of the shapes our gateway might emit and
 * coerce to a uniform UsageRecord. Returns null if the payload doesn't
 * look like a usage record at all.
 */
export function normalizeUsage(raw: unknown): UsageRecord | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const inner = (r["usage"] as Record<string, unknown> | undefined) ?? r;
  const promptTokens =
    Number(inner["prompt_tokens"] ?? inner["input_tokens"] ?? inner["promptTokens"] ?? 0) || 0;
  const completionTokens =
    Number(
      inner["completion_tokens"] ??
        inner["output_tokens"] ??
        inner["completionTokens"] ??
        0,
    ) || 0;
  if (promptTokens === 0 && completionTokens === 0) return null;
  return { promptTokens, completionTokens };
}

/** Cost in USD for a given usage at a given model price (or 0 if unknown). */
export function costFor(usage: UsageRecord, model: string | null | undefined): number {
  const p = pickPrice(model);
  if (!p) return 0;
  return (usage.promptTokens * p.input + usage.completionTokens * p.output) / 1_000_000;
}
