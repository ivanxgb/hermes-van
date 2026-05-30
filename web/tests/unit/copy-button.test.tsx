/**
 * CopyButton tests — clipboard behaviour with both the modern API and
 * the textarea fallback path. We mock navigator.clipboard.writeText
 * directly so we don't depend on jsdom's permission model.
 *
 * Coverage:
 *   1. Click → writeText called with the supplied text → "copied" label.
 *   2. State resets to "copy" after the timeout.
 *   3. writeText rejection → falls back to execCommand("copy"). When
 *      the fallback succeeds we still show "copied".
 *   4. Both paths failing → "failed" label + data-state="failed".
 */
// @vitest-environment jsdom
import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { CopyButton } from "../../src/components/CopyButton";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function withClipboard(writeText: (s: string) => Promise<void>) {
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: vi.fn(writeText) },
  });
}

function withoutClipboard() {
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: undefined,
  });
}

describe("<CopyButton>", () => {
  test("modern path: writeText called, label flips to 'copied'", async () => {
    let captured = "";
    withClipboard(async (s) => {
      captured = s;
    });
    render(<CopyButton text="hello world" testId="cb" />);
    fireEvent.click(screen.getByTestId("cb"));
    await waitFor(() =>
      expect(screen.getByTestId("cb").getAttribute("data-state")).toBe("copied"),
    );
    expect(captured).toBe("hello world");
    expect(screen.getByTestId("cb").textContent).toBe("copied");
  });

  test("state resets back to 'copy' after the timeout", async () => {
    withClipboard(async () => {});
    render(<CopyButton text="x" testId="cb" />);
    fireEvent.click(screen.getByTestId("cb"));
    await waitFor(() =>
      expect(screen.getByTestId("cb").getAttribute("data-state")).toBe("copied"),
    );
    await waitFor(
      () => expect(screen.getByTestId("cb").getAttribute("data-state")).toBe("idle"),
      { timeout: 2_000 },
    );
    expect(screen.getByTestId("cb").textContent).toBe("copy");
  });

  test("fallback path: writeText rejects → execCommand('copy') succeeds", async () => {
    withClipboard(async () => {
      throw new Error("denied");
    });
    // jsdom doesn't ship execCommand — install a stub before spying.
    Object.defineProperty(document, "execCommand", {
      configurable: true,
      writable: true,
      value: () => true,
    });
    const exec = vi
      .spyOn(document, "execCommand")
      .mockImplementation(() => true);
    render(<CopyButton text="fallback" testId="cb" />);
    fireEvent.click(screen.getByTestId("cb"));
    await waitFor(() =>
      expect(screen.getByTestId("cb").getAttribute("data-state")).toBe("copied"),
    );
    expect(exec).toHaveBeenCalledWith("copy");
  });

  test("both paths fail → label shows 'failed'", async () => {
    withoutClipboard();
    Object.defineProperty(document, "execCommand", {
      configurable: true,
      writable: true,
      value: () => false,
    });
    vi.spyOn(document, "execCommand").mockImplementation(() => false);
    render(<CopyButton text="z" testId="cb" />);
    fireEvent.click(screen.getByTestId("cb"));
    await waitFor(() =>
      expect(screen.getByTestId("cb").getAttribute("data-state")).toBe("failed"),
    );
    expect(screen.getByTestId("cb").textContent).toBe("failed");
  });
});
