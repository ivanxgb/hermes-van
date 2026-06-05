/**
 * use-commands tests — cache, fuzzy match, slash filtering.
 *
 * The hook talks to /api/gateway/commands; we stub global fetch so each
 * test hits the in-module cache + match helpers without a live gateway.
 */
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import {
  clearCommandsCache,
  fetchCommands,
  fuzzyMatchCommands,
  matchSlashCommands,
  useCommands,
} from "../../src/lib/use-commands";
import type { CommandRecord } from "../../src/lib/api";

const SAMPLE: CommandRecord[] = [
  {
    name: "new",
    description: "Start a new session",
    category: "Session",
    aliases: ["reset"],
    args_hint: "[name]",
    subcommands: [],
    source: "builtin",
  },
  {
    name: "model",
    description: "Switch model",
    category: "Configuration",
    aliases: [],
    args_hint: "[name]",
    subcommands: [],
    source: "builtin",
  },
  {
    name: "stop",
    description: "Kill background processes",
    category: "Session",
    aliases: [],
    args_hint: "",
    subcommands: [],
    source: "builtin",
  },
];

beforeEach(() => {
  clearCommandsCache();
  vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
    return new Response(JSON.stringify({ commands: SAMPLE }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("matchSlashCommands", () => {
  test("returns empty when input doesn't start with /", () => {
    expect(matchSlashCommands(SAMPLE, "new")).toEqual([]);
  });

  test("filters by name prefix, case-insensitive", () => {
    const out = matchSlashCommands(SAMPLE, "/m");
    expect(out.map((c) => c.name)).toEqual(["model"]);
  });

  test("matches the bare slash to all entries", () => {
    expect(matchSlashCommands(SAMPLE, "/")).toHaveLength(3);
  });
});

describe("fuzzyMatchCommands", () => {
  test("strips leading slash and matches across name + description", () => {
    const out = fuzzyMatchCommands(SAMPLE, "/swt");
    expect(out.map((c) => c.name)).toContain("model"); // "Switch model"
  });

  test("empty query returns everything", () => {
    expect(fuzzyMatchCommands(SAMPLE, "")).toHaveLength(3);
  });

  test("matches characters in order", () => {
    const out = fuzzyMatchCommands(SAMPLE, "stp");
    expect(out.map((c) => c.name)).toContain("stop");
  });
});

describe("fetchCommands cache", () => {
  test("hits network only once within TTL", async () => {
    const a = await fetchCommands();
    const b = await fetchCommands();
    expect(a).toBe(b); // same reference from cache
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  test("force=true bypasses cache", async () => {
    await fetchCommands();
    await fetchCommands(true);
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
  });
});

describe("useCommands hook", () => {
  test("loads commands and exposes status=ready", async () => {
    const { result } = renderHook(() => useCommands(true));
    await waitFor(() => {
      expect(result.current.status).toBe("ready");
    });
    expect(result.current.commands).toHaveLength(3);
    expect(result.current.error).toBeNull();
  });

  test("enabled=false skips fetching", async () => {
    const { result } = renderHook(() => useCommands(false));
    // Allow microtasks
    await new Promise((r) => setTimeout(r, 10));
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(result.current.status).toBe("idle");
  });

  test("network failure surfaces as status=error", async () => {
    vi.mocked(globalThis.fetch).mockRejectedValueOnce(new Error("offline"));
    const { result } = renderHook(() => useCommands(true));
    await waitFor(() => {
      expect(result.current.status).toBe("error");
    });
    expect(result.current.error).toContain("offline");
  });
});
