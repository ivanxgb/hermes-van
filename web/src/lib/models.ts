/**
 * Curated registry of LLM identifiers known to be reachable through the
 * Hermes gateway. The gateway accepts free-form model strings (no
 * `/v1/models` endpoint), so this list is editorial — kept in sync by
 * hand as new providers / models come online.
 *
 * `id` is the literal string sent to the gateway. `provider` groups
 * entries in the dropdown. `tags` show capabilities at a glance.
 *
 * To add a custom model on the fly, the selector exposes a "Custom..."
 * input as the last option.
 */

export interface ModelOption {
  id: string;
  label: string;
  provider: string;
  tags?: string[];
  hint?: string;
}

export const MODELS: ModelOption[] = [
  // ── Anthropic via Kiro Gateway (free) ─────────────────────────
  {
    id: "kiro/claude-sonnet-4.5",
    label: "Sonnet 4.5",
    provider: "Kiro (free)",
    tags: ["fast", "tools"],
  },
  {
    id: "kiro/claude-opus-4.7",
    label: "Opus 4.7",
    provider: "Kiro (free)",
    tags: ["smart", "tools"],
  },

  // ── Anthropic direct ──────────────────────────────────────────
  {
    id: "anthropic/claude-opus-4.7",
    label: "Opus 4.7",
    provider: "Anthropic",
    tags: ["smart", "tools", "vision"],
    hint: "Top reasoning model",
  },
  {
    id: "anthropic/claude-sonnet-4.5",
    label: "Sonnet 4.5",
    provider: "Anthropic",
    tags: ["fast", "tools", "vision"],
  },
  {
    id: "anthropic/claude-haiku-4",
    label: "Haiku 4",
    provider: "Anthropic",
    tags: ["fastest", "cheap"],
  },

  // ── Vertex AI (Vintek) ────────────────────────────────────────
  {
    id: "vertex/claude-code-725",
    label: "Claude Code 725",
    provider: "Vertex AI",
    tags: ["coding"],
  },
  {
    id: "vertex/gemini-3.5-pro",
    label: "Gemini 3.5 Pro",
    provider: "Vertex AI",
    tags: ["smart", "vision"],
  },
  {
    id: "vertex/gemini-3-flash",
    label: "Gemini 3 Flash",
    provider: "Vertex AI",
    tags: ["fast", "cheap"],
  },

  // ── OpenAI ────────────────────────────────────────────────────
  {
    id: "openai/gpt-5",
    label: "GPT-5",
    provider: "OpenAI",
    tags: ["smart", "tools"],
  },
  {
    id: "openai/gpt-5-mini",
    label: "GPT-5 mini",
    provider: "OpenAI",
    tags: ["fast", "cheap"],
  },
  {
    id: "openai/o3",
    label: "o3",
    provider: "OpenAI",
    tags: ["reasoning"],
  },

  // ── Local / OSS via gateway ───────────────────────────────────
  {
    id: "kimi-k2",
    label: "Kimi K2",
    provider: "Other",
    tags: ["reasoning"],
  },
  {
    id: "deepseek-r1",
    label: "DeepSeek R1",
    provider: "Other",
    tags: ["reasoning", "cheap"],
  },
];

/** Group models by provider, preserving array order within each group. */
export function modelsByProvider(): Map<string, ModelOption[]> {
  const out = new Map<string, ModelOption[]>();
  for (const m of MODELS) {
    if (!out.has(m.provider)) out.set(m.provider, []);
    out.get(m.provider)!.push(m);
  }
  return out;
}

/** Find a known model by id, or null for free-form / unknown. */
export function findModel(id: string | null | undefined): ModelOption | null {
  if (!id) return null;
  return MODELS.find((m) => m.id === id) ?? null;
}

/**
 * Render-friendly label for a model id. For known models returns
 * "Provider · Label", for unknown ids returns the id itself, for null
 * returns "default".
 */
export function modelDisplay(id: string | null | undefined): string {
  if (!id) return "default";
  const m = findModel(id);
  if (!m) return id;
  return `${m.provider} · ${m.label}`;
}
