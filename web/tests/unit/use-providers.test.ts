/**
 * use-providers tests — fetch wrapper + cache TTL + hook lifecycle.
 */
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import {
  clearProvidersCache,
  fetchProviders,
  useProviders,
} from "../../src/lib/use-providers";

const PAYLOAD = {
  providers: [
    {
      slug: "custom:kiro",
      name: "kiro",
      label: "Kiro",
      is_current: true,
      is_user_defined: true,
      models: ["claude-opus-4.7", "claude-sonnet-4.5"],
      total_models: 13,
      source: "user-config",
      api_url: "http://127.0.0.1:8001/v1",
    },
    {
      slug: "openai-codex",
      name: "openai-codex",
      label: "Openai-Codex",
      is_current: false,
      is_user_defined: false,
      models: ["gpt-5"],
      total_models: 6,
      source: "auto",
      api_url: "",
    },
  ],
  current: { provider: "custom:kiro", model: "claude-opus-4.7" },
};

beforeEach(() => {
  clearProvidersCache();
  vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
    return new Response(JSON.stringify(PAYLOAD), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("fetchProviders", () => {
  test("returns mapped shape", async () => {
    const data = await fetchProviders();
    expect(data.providers).toHaveLength(2);
    expect(data.providers[0]?.slug).toBe("custom:kiro");
    expect(data.current).toEqual({
      provider: "custom:kiro",
      model: "claude-opus-4.7",
    });
  });

  test("caches across calls within TTL", async () => {
    const a = await fetchProviders();
    const b = await fetchProviders();
    expect(a).toBe(b);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  test("force=true bypasses cache", async () => {
    await fetchProviders();
    await fetchProviders(true);
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
  });
});

describe("useProviders hook", () => {
  test("transitions idle → ready", async () => {
    const { result } = renderHook(() => useProviders(true));
    await waitFor(() => {
      expect(result.current.status).toBe("ready");
    });
    expect(result.current.data?.providers).toHaveLength(2);
    expect(result.current.error).toBeNull();
  });

  test("enabled=false skips fetch", async () => {
    const { result } = renderHook(() => useProviders(false));
    await new Promise((r) => setTimeout(r, 10));
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(result.current.status).toBe("idle");
  });

  test("error path", async () => {
    vi.mocked(globalThis.fetch).mockRejectedValueOnce(new Error("nope"));
    const { result } = renderHook(() => useProviders(true));
    await waitFor(() => {
      expect(result.current.status).toBe("error");
    });
    expect(result.current.error).toContain("nope");
  });

  test("refresh() forces a new fetch", async () => {
    const { result } = renderHook(() => useProviders(true));
    await waitFor(() => {
      expect(result.current.status).toBe("ready");
    });
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    await result.current.refresh();
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
  });
});
