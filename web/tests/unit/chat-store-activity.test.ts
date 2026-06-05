/**
 * chat-store activity events — SSE handlers for tool / reasoning blocks.
 *
 * The chat-store wires an EventSource to /api/runs/:id/events and turns
 * the lifecycle SSE events into ActivityBlock entries the UI can render
 * inline. This test drives the EventSource shim deterministically to
 * verify that:
 *
 *   1. tool.started → adds a running tool block
 *   2. tool.completed → flips that block to done with duration
 *   3. tool.failed → flips that block to failed
 *   4. reasoning.available → adds a reasoning block
 *   5. tool.progress (legacy envelope) → routes through to the same shapes
 *   6. tool.progress with tool_name="_thinking" → reasoning block
 *
 * We don't exercise startChatRun / openStream directly because that
 * function is not exported. Instead we drive the publicly-exported
 * surface (loadChat → reconnectIfLive) using a stubbed `chats.activeRun`
 * that hands back a fake run; openStream then attaches to our mock
 * EventSource and we fire events at it.
 */
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// We mock the api module before importing chat-store so it grabs the
// stubbed `chats.activeRun` and `chats.messages`.
vi.mock("../../src/lib/api", () => ({
  chats: {
    list: vi.fn(),
    create: vi.fn(),
    delete: vi.fn(),
    patch: vi.fn(),
    messages: vi.fn(async () => ({ messages: [] })),
    activeRun: vi.fn(async () => ({
      run: {
        id: "run-test",
        chatId: "chat-1",
        messageId: "msg-1",
        startedAt: 1234,
      },
    })),
    startRun: vi.fn(),
  },
  runs: { stop: vi.fn(), approve: vi.fn() },
  gateway: { forkChat: vi.fn() },
}));

// In-memory EventSource shim. Each instance exposes `fire(name, data)`
// for the test to dispatch a typed event the way addEventListener
// receives it.
class MockEventSource {
  static instances: MockEventSource[] = [];
  url: string;
  readyState = 0;
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  CLOSED = 2;
  private listeners = new Map<string, Set<(ev: MessageEvent) => void>>();
  onerror: ((ev: Event) => void) | null = null;
  constructor(url: string) {
    this.url = url;
    MockEventSource.instances.push(this);
  }
  addEventListener(type: string, cb: (ev: MessageEvent) => void) {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(cb);
  }
  removeEventListener(type: string, cb: (ev: MessageEvent) => void) {
    this.listeners.get(type)?.delete(cb);
  }
  fire(type: string, data: Record<string, unknown>) {
    const ev = new MessageEvent(type, { data: JSON.stringify(data) });
    for (const cb of this.listeners.get(type) ?? []) cb(ev);
  }
  close() {
    this.readyState = 2;
  }
}

beforeEach(() => {
  MockEventSource.instances.length = 0;
  // @ts-expect-error — assigning shim
  globalThis.EventSource = MockEventSource;
});

afterEach(() => {
  vi.clearAllMocks();
  // Reset the chat-store between tests by purging its module cache.
  vi.resetModules();
});

async function bootChatStore() {
  // Re-import the store fresh per test so each one starts from a clean
  // chatStates/eventSources map.
  const mod = await import("../../src/lib/chat-store");
  await mod.loadChat("chat-1");
  // The first instance is the EventSource the store opened against
  // /api/runs/run-test/events via reconnectIfLive.
  const es = MockEventSource.instances[0];
  if (!es) throw new Error("EventSource not opened by store");
  return { mod, es };
}

describe("chat-store activity events", () => {
  test("tool.started appends a running block; tool.completed flips it to done", async () => {
    const { mod, es } = await bootChatStore();

    es.fire("tool.started", {
      runId: "run-test",
      tool: "write_file",
      preview: "src/index.ts",
    });

    let blocks = mod.getMessageActivity("chat-1", "msg-1");
    expect(blocks).toHaveLength(1);
    const first = blocks[0]!;
    expect(first.kind).toBe("tool");
    if (first.kind === "tool") {
      expect(first.tool).toBe("write_file");
      expect(first.preview).toBe("src/index.ts");
      expect(first.status).toBe("running");
    }

    es.fire("tool.completed", {
      runId: "run-test",
      tool: "write_file",
      duration: 0.42,
      error: false,
    });

    blocks = mod.getMessageActivity("chat-1", "msg-1");
    expect(blocks).toHaveLength(1);
    const done = blocks[0]!;
    if (done.kind === "tool") {
      expect(done.status).toBe("done");
      expect(done.durationMs).toBe(420);
    }
  });

  test("tool.failed flips the matching running block to failed", async () => {
    const { mod, es } = await bootChatStore();

    es.fire("tool.started", { tool: "terminal", preview: "pnpm test" });
    es.fire("tool.failed", { tool: "terminal", duration: 1.5 });

    const blocks = mod.getMessageActivity("chat-1", "msg-1");
    expect(blocks).toHaveLength(1);
    const b = blocks[0]!;
    if (b.kind === "tool") {
      expect(b.status).toBe("failed");
      expect(b.durationMs).toBe(1500);
    }
  });

  test("reasoning.available appends a reasoning block", async () => {
    const { mod, es } = await bootChatStore();

    es.fire("reasoning.available", {
      text: "Considering the activity stream design...",
    });

    const blocks = mod.getMessageActivity("chat-1", "msg-1");
    expect(blocks).toHaveLength(1);
    const b = blocks[0]!;
    expect(b.kind).toBe("reasoning");
    if (b.kind === "reasoning") {
      expect(b.text).toContain("activity stream");
    }
  });

  test("legacy tool.progress with kind=started routes to a tool block", async () => {
    const { mod, es } = await bootChatStore();

    es.fire("tool.progress", {
      tool_name: "search_files",
      kind: "started",
      preview: "*.ts",
    });

    const blocks = mod.getMessageActivity("chat-1", "msg-1");
    expect(blocks).toHaveLength(1);
    const b = blocks[0]!;
    if (b.kind === "tool") {
      expect(b.tool).toBe("search_files");
      expect(b.status).toBe("running");
    }
  });

  test("legacy tool.progress with tool_name=_thinking routes to a reasoning block", async () => {
    const { mod, es } = await bootChatStore();

    es.fire("tool.progress", {
      tool_name: "_thinking",
      delta: "checking the config",
    });

    const blocks = mod.getMessageActivity("chat-1", "msg-1");
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.kind).toBe("reasoning");
  });

  test("orphan tool.completed (no matching started) still renders a synthetic done row", async () => {
    const { mod, es } = await bootChatStore();

    // Some gateways drop the started event under load. We still want
    // to show the user that something completed, not nothing at all.
    es.fire("tool.completed", {
      tool: "patch",
      duration: 0.05,
      error: false,
    });

    const blocks = mod.getMessageActivity("chat-1", "msg-1");
    expect(blocks).toHaveLength(1);
    const b = blocks[0]!;
    if (b.kind === "tool") {
      expect(b.tool).toBe("patch");
      expect(b.status).toBe("done");
      expect(b.durationMs).toBe(50);
    }
  });
});
