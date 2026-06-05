/**
 * Phase 6.D.2 — FileAttachButton tests.
 *
 * The component owns: file picker → uploads.upload() → markdown
 * snippet handed to the parent. We mock the api module so we don't
 * touch the network, then drive the change event with a synthetic
 * File and assert the snippet shape per mime-type class.
 *
 * Coverage:
 *   1. Image mime → ![filename](/api/uploads/<id>/raw)
 *   2. Non-image → [filename](/api/uploads/<id>/raw)
 *   3. Filenames containing markdown special chars are escaped.
 *   4. Upload errors surface in the title and DON'T call onAttached.
 *   5. Disabled blocks the click.
 *   6. The file input is reset after a selection so picking the same
 *      file twice still triggers a new upload.
 */
// @vitest-environment jsdom
import { afterEach, describe, expect, test, vi, beforeEach } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("../../src/lib/api", () => ({
  uploads: {
    upload: vi.fn(),
  },
}));

import { uploads as uploadsApi } from "../../src/lib/api";
import { FileAttachButton } from "../../src/components/FileAttachButton";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

beforeEach(() => {
  vi.clearAllMocks();
});

function pickFile(file: File) {
  const input = screen.getByTestId("composer-file-input") as HTMLInputElement;
  // Override the read-only `files` and `value` properties so the
  // change handler sees what we're "selecting".
  Object.defineProperty(input, "files", { configurable: true, value: [file] });
  fireEvent.change(input);
}

describe("<FileAttachButton>", () => {
  test("image mime emits markdown image snippet", async () => {
    (uploadsApi.upload as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "01HZZZZZZZZZZZZZZZZZZZZZZZ",
      filename: "cat.png",
      mimeType: "image/png",
      sizeBytes: 12,
      sha256: "a".repeat(64),
      chatId: null,
      createdAt: Date.now(),
      mediaUrl: "MEDIA:/api/uploads/01HZZZZZZZZZZZZZZZZZZZZZZZ/raw",
      deduplicated: false,
    });
    const onAttached = vi.fn();
    render(<FileAttachButton onAttached={onAttached} />);
    pickFile(new File(["xxxxxxxxxxxx"], "cat.png", { type: "image/png" }));
    await waitFor(() => expect(onAttached).toHaveBeenCalled());
    expect(onAttached.mock.calls[0]?.[0]).toBe(
      "![cat.png](/api/uploads/01HZZZZZZZZZZZZZZZZZZZZZZZ/raw)",
    );
  });

  test("non-image mime emits plain link snippet", async () => {
    (uploadsApi.upload as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "01HABCABCABCABCABCABCABCABC",
      filename: "report.pdf",
      mimeType: "application/pdf",
      sizeBytes: 1234,
      sha256: "b".repeat(64),
      chatId: null,
      createdAt: Date.now(),
      mediaUrl: "MEDIA:/api/uploads/01HABCABCABCABCABCABCABCABC/raw",
      deduplicated: false,
    });
    const onAttached = vi.fn();
    render(<FileAttachButton onAttached={onAttached} />);
    pickFile(new File(["pdf-bytes"], "report.pdf", { type: "application/pdf" }));
    await waitFor(() => expect(onAttached).toHaveBeenCalled());
    expect(onAttached.mock.calls[0]?.[0]).toBe(
      "[report.pdf](/api/uploads/01HABCABCABCABCABCABCABCABC/raw)",
    );
  });

  test("escapes ] and \\ in filenames so the link parses", async () => {
    (uploadsApi.upload as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "01HXX",
      filename: "weird]name\\here.txt",
      mimeType: "text/plain",
      sizeBytes: 1,
      sha256: "c".repeat(64),
      chatId: null,
      createdAt: 0,
      mediaUrl: "MEDIA:/api/uploads/01HXX/raw",
      deduplicated: false,
    });
    const onAttached = vi.fn();
    render(<FileAttachButton onAttached={onAttached} />);
    pickFile(new File(["x"], "weird]name\\here.txt", { type: "text/plain" }));
    await waitFor(() => expect(onAttached).toHaveBeenCalled());
    const snippet = onAttached.mock.calls[0]?.[0] as string;
    expect(snippet).toContain("weird\\]name\\\\here.txt");
    expect(snippet.startsWith("[")).toBe(true);
  });

  test("upload error surfaces in title and does not call onAttached", async () => {
    (uploadsApi.upload as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("file exceeds limit (26214400 bytes)"),
    );
    const onAttached = vi.fn();
    render(<FileAttachButton onAttached={onAttached} />);
    pickFile(new File(["x"], "big.bin", { type: "application/pdf" }));
    await waitFor(() =>
      expect(screen.getByTestId("composer-attach").getAttribute("title") ?? "").toMatch(
        /failed/i,
      ),
    );
    expect(onAttached).not.toHaveBeenCalled();
  });

  test("disabled blocks click + upload", () => {
    const onAttached = vi.fn();
    render(<FileAttachButton onAttached={onAttached} disabled />);
    const btn = screen.getByTestId("composer-attach") as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    fireEvent.click(btn);
    expect(uploadsApi.upload).not.toHaveBeenCalled();
  });

  test("input value resets after selection so the same file re-uploads", async () => {
    (uploadsApi.upload as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "01HONE",
      filename: "a.txt",
      mimeType: "text/plain",
      sizeBytes: 1,
      sha256: "d".repeat(64),
      chatId: null,
      createdAt: 0,
      mediaUrl: "MEDIA:/api/uploads/01HONE/raw",
      deduplicated: false,
    });
    render(<FileAttachButton onAttached={() => {}} />);
    pickFile(new File(["x"], "a.txt", { type: "text/plain" }));
    await waitFor(() => expect(uploadsApi.upload).toHaveBeenCalledTimes(1));
    const input = screen.getByTestId("composer-file-input") as HTMLInputElement;
    // After upload the input is cleared by the component so a second
    // pick of the same file fires a fresh change event.
    expect(input.value).toBe("");
  });
});
