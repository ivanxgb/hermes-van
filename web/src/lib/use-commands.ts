/**
 * useCommands — fetches the live slash command registry from the gateway.
 *
 * Single source of truth: GET /api/gateway/commands → /v1/commands.
 * Gateway-only commands are filtered server-side, plugin commands are
 * appended. This hook just caches and exposes them.
 *
 * The cache TTL is generous (5 min) because the registry only changes
 * with a gateway restart or plugin reload — the user can `clearCommandsCache()`
 * after a /reload-mcp etc. if needed.
 */
import { useEffect, useState } from "react";
import { gateway, type CommandRecord } from "./api";

const CACHE_TTL_MS = 5 * 60_000;

interface CachedCommands {
  data: CommandRecord[];
  fetchedAt: number;
}

let cache: CachedCommands | null = null;
let inflight: Promise<CommandRecord[]> | null = null;

export function clearCommandsCache(): void {
  cache = null;
  inflight = null;
}

export async function fetchCommands(force = false): Promise<CommandRecord[]> {
  const now = Date.now();
  if (!force && cache && now - cache.fetchedAt < CACHE_TTL_MS) {
    return cache.data;
  }
  if (inflight) return inflight;

  inflight = (async () => {
    try {
      const { commands } = await gateway.commands();
      cache = { data: commands, fetchedAt: Date.now() };
      return commands;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

export interface UseCommandsState {
  status: "idle" | "loading" | "ready" | "error";
  commands: CommandRecord[];
  error: string | null;
}

/**
 * Subscribes the calling component to the (cached) command registry.
 * `enabled=false` skips the fetch entirely — handy when the parent owns
 * lazy mounting and wants to defer the round-trip until the menu opens.
 */
export function useCommands(enabled = true): UseCommandsState {
  const [state, setState] = useState<UseCommandsState>(() => ({
    status: cache ? "ready" : "idle",
    commands: cache?.data ?? [],
    error: null,
  }));

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    if (!cache || Date.now() - cache.fetchedAt >= CACHE_TTL_MS) {
      setState((s) => ({ ...s, status: "loading" }));
    }
    fetchCommands()
      .then((commands) => {
        if (cancelled) return;
        setState({ status: "ready", commands, error: null });
      })
      .catch((err) => {
        if (cancelled) return;
        setState({
          status: "error",
          commands: [],
          error: err instanceof Error ? err.message : String(err),
        });
      });
    return () => {
      cancelled = true;
    };
  }, [enabled]);

  return state;
}

/** Match a query against the registry, returning entries whose name
 * starts with the query (slash included, case-insensitive). Used by
 * the inline composer autocomplete. */
export function matchSlashCommands(
  commands: CommandRecord[],
  input: string,
): CommandRecord[] {
  if (!input.startsWith("/")) return [];
  const q = input.toLowerCase();
  return commands.filter((c) => `/${c.name}`.toLowerCase().startsWith(q));
}

/** Fuzzy-match for the command palette: every char appears in order
 * inside the name or description. */
export function fuzzyMatchCommands(
  commands: CommandRecord[],
  query: string,
): CommandRecord[] {
  const q = query.replace(/^\//, "").toLowerCase();
  if (!q) return commands;
  return commands.filter((c) => {
    const haystack = `${c.name} ${c.description}`.toLowerCase();
    let i = 0;
    for (const ch of haystack) {
      if (ch === q[i]) i += 1;
      if (i === q.length) return true;
    }
    return i === q.length;
  });
}
