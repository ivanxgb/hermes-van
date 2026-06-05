/**
 * useProviders — fetches the live list of providers + models from the
 * gateway via the /api/gateway/providers proxy.
 *
 * Single source of truth is `hermes_cli.model_switch.list_picker_providers`
 * on the backend, the same data the Telegram /model picker uses. There is
 * NO hardcoded list; whatever is registered in config.yaml + has working
 * credentials shows up here, and only that.
 *
 * Cached in-module so the popover opens instantly on the second tap.
 * The cache TTL is short (60s) so adding a provider in config.yaml is
 * picked up on the next refresh without a full reload.
 */
import { useEffect, useState } from "react";
import { gateway, type ProvidersResponse } from "./api";

const CACHE_TTL_MS = 60_000;

interface CachedProviders {
  data: ProvidersResponse;
  fetchedAt: number;
}

let cache: CachedProviders | null = null;
let inflight: Promise<ProvidersResponse> | null = null;

export function clearProvidersCache(): void {
  cache = null;
  inflight = null;
}

export async function fetchProviders(force = false): Promise<ProvidersResponse> {
  const now = Date.now();
  if (!force && cache && now - cache.fetchedAt < CACHE_TTL_MS) {
    return cache.data;
  }
  if (inflight) return inflight;

  inflight = (async () => {
    try {
      const data = await gateway.providers();
      cache = { data, fetchedAt: Date.now() };
      return data;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

export interface UseProvidersState {
  status: "idle" | "loading" | "ready" | "error";
  data: ProvidersResponse | null;
  error: string | null;
  refresh: () => Promise<void>;
}

export function useProviders(enabled = true): UseProvidersState {
  const [state, setState] = useState<{
    status: "idle" | "loading" | "ready" | "error";
    data: ProvidersResponse | null;
    error: string | null;
  }>(() => ({
    status: cache ? "ready" : "idle",
    data: cache?.data ?? null,
    error: null,
  }));

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    if (!cache || Date.now() - cache.fetchedAt >= CACHE_TTL_MS) {
      setState((s) => ({ ...s, status: "loading" }));
    }
    fetchProviders()
      .then((data) => {
        if (cancelled) return;
        setState({ status: "ready", data, error: null });
      })
      .catch((err) => {
        if (cancelled) return;
        setState({
          status: "error",
          data: null,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    return () => {
      cancelled = true;
    };
  }, [enabled]);

  async function refresh() {
    setState((s) => ({ ...s, status: "loading" }));
    try {
      const data = await fetchProviders(true);
      setState({ status: "ready", data, error: null });
    } catch (err) {
      setState({
        status: "error",
        data: null,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { ...state, refresh };
}
