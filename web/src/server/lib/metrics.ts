/**
 * Usage metrics aggregator — Phase 6.G.
 *
 * Walks the local `messages` table and rolls up:
 *   - total messages
 *   - total prompt + completion tokens
 *   - estimated USD cost (when the chat's model maps to MODEL_PRICES)
 *   - per-model breakdown
 *   - per-chat breakdown (top N most expensive)
 *   - per-day series for the last 30 days
 *
 * Reads metadata JSON inline. Most assistant messages have
 * `{"usage": {prompt_tokens, completion_tokens}}`; legacy rows or
 * provider variants are tolerated by normalizeUsage().
 *
 * Cost mapping: each chat carries a `model` column. We trust that
 * value as the model that produced every assistant message in the
 * chat — it's the contract enforced when starting a run. Future
 * mid-chat model swaps would need per-message model tracking; for
 * now this is accurate enough for a dashboard.
 */
import { sql } from "drizzle-orm";
import * as schema from "../db/schema";
import { getDb } from "../db";
import { costFor, normalizeUsage } from "./cost";

type Db = ReturnType<typeof getDb>;

export interface UsageSummary {
  totals: {
    messages: number;
    promptTokens: number;
    completionTokens: number;
    estUsd: number;
    /** Number of usage rows we couldn't price (model unknown). */
    pricelessRows: number;
  };
  byModel: Array<{
    model: string;
    messages: number;
    promptTokens: number;
    completionTokens: number;
    estUsd: number;
  }>;
  byChat: Array<{
    chatId: string;
    title: string;
    model: string | null;
    messages: number;
    promptTokens: number;
    completionTokens: number;
    estUsd: number;
  }>;
  /** ISO date (YYYY-MM-DD) → totals for the last 30 days. */
  byDay: Array<{
    date: string;
    promptTokens: number;
    completionTokens: number;
    estUsd: number;
  }>;
}

interface RawRow {
  chat_id: string;
  chat_title: string;
  model: string | null;
  metadata: string | null;
  created_at: number;
}

/**
 * Pull all assistant messages with non-null metadata for a single
 * user. We do the JSON parsing in TypeScript rather than SQL because
 * SQLite's JSON1 is optional and we don't want to bind to it; the
 * upper bound on a single user's metadata-bearing message log is in
 * the low thousands, so this is cheap.
 */
function fetchUsageRows(db: Db, userId: string): RawRow[] {
  return db.all<RawRow>(sql`
    SELECT m.chat_id   AS chat_id,
           c.title     AS chat_title,
           c.model     AS model,
           m.metadata  AS metadata,
           m.created_at AS created_at
    FROM ${schema.messages} m
    JOIN ${schema.chats} c ON c.id = m.chat_id
    WHERE m.user_id = ${userId}
      AND m.role = 'assistant'
      AND m.metadata IS NOT NULL
      AND m.metadata != ''
  `);
}

function dayKey(ts: number): string {
  const d = new Date(ts);
  const y = d.getUTCFullYear();
  const mo = String(d.getUTCMonth() + 1).padStart(2, "0");
  const da = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${mo}-${da}`;
}

interface ChatBucket {
  chatId: string;
  title: string;
  model: string | null;
  messages: number;
  promptTokens: number;
  completionTokens: number;
  estUsd: number;
}

interface ModelBucket {
  model: string;
  messages: number;
  promptTokens: number;
  completionTokens: number;
  estUsd: number;
}

interface DayBucket {
  date: string;
  promptTokens: number;
  completionTokens: number;
  estUsd: number;
}

export function summarizeUsage(db: Db, userId: string): UsageSummary {
  const rows = fetchUsageRows(db, userId);

  let messages = 0;
  let promptTokens = 0;
  let completionTokens = 0;
  let estUsd = 0;
  let pricelessRows = 0;

  const chats = new Map<string, ChatBucket>();
  const models = new Map<string, ModelBucket>();
  const days = new Map<string, DayBucket>();

  // 30-day window cutoff for the daily series.
  const now = Date.now();
  const thirtyDaysAgo = now - 30 * 24 * 60 * 60 * 1000;

  for (const row of rows) {
    let parsed: unknown;
    try {
      parsed = row.metadata ? JSON.parse(row.metadata) : null;
    } catch {
      // Corrupt metadata. Skip.
      continue;
    }
    const usage = normalizeUsage(parsed);
    if (!usage) continue;

    messages++;
    promptTokens += usage.promptTokens;
    completionTokens += usage.completionTokens;
    const cost = costFor(usage, row.model);
    if (cost === 0 && row.model) pricelessRows++;
    estUsd += cost;

    // Per-chat
    let cb = chats.get(row.chat_id);
    if (!cb) {
      cb = {
        chatId: row.chat_id,
        title: row.chat_title || "(untitled)",
        model: row.model,
        messages: 0,
        promptTokens: 0,
        completionTokens: 0,
        estUsd: 0,
      };
      chats.set(row.chat_id, cb);
    }
    cb.messages++;
    cb.promptTokens += usage.promptTokens;
    cb.completionTokens += usage.completionTokens;
    cb.estUsd += cost;

    // Per-model
    const modelKey = row.model || "(unspecified)";
    let mb = models.get(modelKey);
    if (!mb) {
      mb = {
        model: modelKey,
        messages: 0,
        promptTokens: 0,
        completionTokens: 0,
        estUsd: 0,
      };
      models.set(modelKey, mb);
    }
    mb.messages++;
    mb.promptTokens += usage.promptTokens;
    mb.completionTokens += usage.completionTokens;
    mb.estUsd += cost;

    // Per-day (only within the 30-day window)
    if (row.created_at >= thirtyDaysAgo) {
      const k = dayKey(row.created_at);
      let db2 = days.get(k);
      if (!db2) {
        db2 = { date: k, promptTokens: 0, completionTokens: 0, estUsd: 0 };
        days.set(k, db2);
      }
      db2.promptTokens += usage.promptTokens;
      db2.completionTokens += usage.completionTokens;
      db2.estUsd += cost;
    }
  }

  // byChat: top 20 by cost (then by tokens to break ties when no
  // pricing is known).
  const byChat = Array.from(chats.values())
    .sort((a, b) => {
      if (b.estUsd !== a.estUsd) return b.estUsd - a.estUsd;
      return (
        b.promptTokens + b.completionTokens - (a.promptTokens + a.completionTokens)
      );
    })
    .slice(0, 20);

  const byModel = Array.from(models.values()).sort((a, b) => b.estUsd - a.estUsd);
  const byDay = Array.from(days.values()).sort((a, b) => a.date.localeCompare(b.date));

  return {
    totals: { messages, promptTokens, completionTokens, estUsd, pricelessRows },
    byModel,
    byChat,
    byDay,
  };
}

/**
 * Lightweight head check used by the route to avoid building a full
 * summary when the user has no metered messages at all. Returns true
 * if at least one assistant message has metadata.
 */
export function hasUsageData(db: Db, userId: string): boolean {
  const r = db.get<{ c: number }>(sql`
    SELECT count(*) AS c FROM ${schema.messages}
    WHERE user_id = ${userId}
      AND role = 'assistant'
      AND metadata IS NOT NULL
      AND metadata != ''
    LIMIT 1
  `);
  return (r?.c ?? 0) > 0;
}
