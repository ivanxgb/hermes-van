/**
 * Phase 6.F — SearchPalette tests.
 *
 * The component owns: debounced query → chats.search() → ranked rows
 * with [[…]] highlights → keyboard nav + commit. We mock the api module
 * so we don't touch the network, then drive typing/keyboard events and
 * assert the rendered list, highlight markup, and commit callback.
 *
 * Coverage:
 *   1. Idle empty state when first opened.
 *   2. Debounced fetch (one call after the timeout, even with rapid typing).
 *   3. Renders snippet with [[match]] as <mark> spans.
 *   4. Empty results → "No matches" cell.
 *   5. Error state → renders the error from ApiError.
 *   6. ↓/↑ navigation updates aria-selected.
 *   7. Enter commits the active row → onSelect(chatId, messageId).
 *   8. Esc calls onClose.
 *   9. Closed → renders nothing.
 *  10. Reopening clears the previous query.
 */
// @vitest-environment jsdom
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { useState } from "react";

vi.mock("../../src/lib/api", async () => {
  const actual = await vi.importActual<typeof import("../../src/lib/api")>(
    "../../src/lib/api",
  );
  return {
    ...actual,
    chats: {
      search: vi.fn(),
    },
  };
});

import { chats as chatsApi, ApiError } from "../../src/lib/api";
import { SearchPalette } from "../../src/components/SearchPalette";

const SEARCH = chatsApi.search as ReturnType<typeof vi.fn>;

const fixture = (overrides: Partial<{
  id: string;
  chatId: string;
  role: "user" | "assistant";
  content: string;
  snippet: string;
}> = {}) => ({
  id: overrides.id ?? "msg_01",
  chatId: overrides.chatId ?? "chat_01",
  role: overrides.role ?? "assistant",
  content: overrides.content ?? "hello world",
  snippet: overrides.snippet ?? "hello [[world]]",
  status: "completed" as const,
  createdAt: 0,
});

const chatsList: Parameters<typeof SearchPalette>[0]["chats"] = [
  {
    id: "chat_01",
    userId: "u",
    title: "First chat",
    gatewaySessionId: "g1",
    model: null,
    archivedAt: null,
    lastMessageAt: null,
    createdAt: 0,
    updatedAt: 0,
  },
  {
    id: "chat_02",
    userId: "u",
    title: "Second chat",
    gatewaySessionId: "g2",
    model: null,
    archivedAt: null,
    lastMessageAt: null,
    createdAt: 0,
    updatedAt: 0,
  },
];

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("<SearchPalette>", () => {
  test("renders nothing when closed", () => {
    const { container } = render(
      <SearchPalette open={false} onClose={() => {}} chats={chatsList} onSelect={() => {}} />,
    );
    expect(container.querySelector("[data-testid='search-overlay']")).toBeNull();
  });

  test("idle prompt before typing", () => {
    render(
      <SearchPalette open onClose={() => {}} chats={chatsList} onSelect={() => {}} />,
    );
    expect(screen.getByTestId("search-list").textContent).toContain(
      "Type to search across every chat",
    );
    expect(SEARCH).not.toHaveBeenCalled();
  });

  test("debounces rapid typing into a single fetch", async () => {
    SEARCH.mockResolvedValue({ results: [fixture()] });
    render(
      <SearchPalette open onClose={() => {}} chats={chatsList} onSelect={() => {}} />,
    );
    const input = screen.getByTestId("search-input") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "h" } });
    fireEvent.change(input, { target: { value: "he" } });
    fireEvent.change(input, { target: { value: "hello" } });
    expect(SEARCH).not.toHaveBeenCalled(); // still inside debounce window
    await new Promise((r) => setTimeout(r, 250));
    await waitFor(() => expect(SEARCH).toHaveBeenCalledTimes(1));
    expect(SEARCH).toHaveBeenLastCalledWith("hello", { limit: 50 });
  });

  test("renders [[match]] markers as <mark> spans", async () => {
    SEARCH.mockResolvedValue({
      results: [fixture({ snippet: "the [[recipe]] is [[here]]" })],
    });
    render(
      <SearchPalette open onClose={() => {}} chats={chatsList} onSelect={() => {}} />,
    );
    fireEvent.change(screen.getByTestId("search-input"), {
      target: { value: "recipe" },
    });
    await new Promise((r) => setTimeout(r, 250));
    await waitFor(() => expect(SEARCH).toHaveBeenCalled());
    const snippet = await screen.findByTestId("search-snippet");
    const marks = snippet.querySelectorAll("mark");
    expect(marks).toHaveLength(2);
    expect(marks[0]?.textContent).toBe("recipe");
    expect(marks[1]?.textContent).toBe("here");
    // Surrounding text preserved.
    expect(snippet.textContent).toBe("the recipe is here");
  });

  test("renders empty state when there are no matches", async () => {
    SEARCH.mockResolvedValue({ results: [] });
    render(
      <SearchPalette open onClose={() => {}} chats={chatsList} onSelect={() => {}} />,
    );
    fireEvent.change(screen.getByTestId("search-input"), {
      target: { value: "nothing" },
    });
    await new Promise((r) => setTimeout(r, 250));
    await waitFor(() => expect(screen.getByTestId("search-empty")).toBeTruthy());
  });

  test("renders ApiError body.error in the error cell", async () => {
    SEARCH.mockRejectedValue(new ApiError(400, { error: "Invalid query" }));
    render(
      <SearchPalette open onClose={() => {}} chats={chatsList} onSelect={() => {}} />,
    );
    fireEvent.change(screen.getByTestId("search-input"), {
      target: { value: '"unbalanced' },
    });
    await new Promise((r) => setTimeout(r, 250));
    const cell = await screen.findByTestId("search-error");
    expect(cell.textContent).toContain("Invalid query");
  });

  test("ArrowDown / ArrowUp updates aria-selected", async () => {
    SEARCH.mockResolvedValue({
      results: [
        fixture({ id: "m1" }),
        fixture({ id: "m2", chatId: "chat_02", snippet: "another [[hit]]" }),
      ],
    });
    render(
      <SearchPalette open onClose={() => {}} chats={chatsList} onSelect={() => {}} />,
    );
    const input = screen.getByTestId("search-input");
    fireEvent.change(input, { target: { value: "hit" } });
    await new Promise((r) => setTimeout(r, 250));
    await waitFor(() => expect(screen.getByTestId("search-item-m1")).toBeTruthy());
    expect(screen.getByTestId("search-item-m1").getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(screen.getByTestId("search-item-m2").getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(input, { key: "ArrowUp" });
    expect(screen.getByTestId("search-item-m1").getAttribute("aria-selected")).toBe("true");
    // ArrowUp at the top is a no-op (clamped to 0).
    fireEvent.keyDown(input, { key: "ArrowUp" });
    expect(screen.getByTestId("search-item-m1").getAttribute("aria-selected")).toBe("true");
  });

  test("Enter commits the active row, calling onSelect(chatId, messageId)", async () => {
    SEARCH.mockResolvedValue({
      results: [fixture({ id: "msg_target", chatId: "chat_02" })],
    });
    const onSelect = vi.fn();
    const onClose = vi.fn();
    render(
      <SearchPalette open onClose={onClose} chats={chatsList} onSelect={onSelect} />,
    );
    const input = screen.getByTestId("search-input");
    fireEvent.change(input, { target: { value: "world" } });
    await new Promise((r) => setTimeout(r, 250));
    await waitFor(() =>
      expect(screen.getByTestId("search-item-msg_target")).toBeTruthy(),
    );
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSelect).toHaveBeenCalledWith("chat_02", "msg_target");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test("Escape calls onClose", () => {
    const onClose = vi.fn();
    render(
      <SearchPalette open onClose={onClose} chats={chatsList} onSelect={() => {}} />,
    );
    fireEvent.keyDown(screen.getByTestId("search-input"), { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test("reopening clears the previous query", async () => {
    SEARCH.mockResolvedValue({ results: [fixture()] });
    function Harness() {
      const [open, setOpen] = useState(true);
      return (
        <>
          <button data-testid="toggle" onClick={() => setOpen((v) => !v)}>toggle</button>
          <SearchPalette
            open={open}
            onClose={() => setOpen(false)}
            chats={chatsList}
            onSelect={() => {}}
          />
        </>
      );
    }
    render(<Harness />);
    const input = () => screen.getByTestId("search-input") as HTMLInputElement;
    fireEvent.change(input(), { target: { value: "hello" } });
    expect(input().value).toBe("hello");
    // Close and reopen.
    fireEvent.click(screen.getByTestId("toggle"));
    fireEvent.click(screen.getByTestId("toggle"));
    expect(input().value).toBe("");
  });
});
