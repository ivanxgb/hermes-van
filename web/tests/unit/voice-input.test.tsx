/**
 * Phase 6.C — voice input component tests.
 *
 * The Web Speech API isn't in JSDOM. We mock window.SpeechRecognition
 * with a minimal in-memory shim that lets us drive the lifecycle
 * (onstart/onresult/onerror/onend) deterministically.
 *
 * Coverage:
 *   1. isVoiceInputSupported() returns false when neither global is set.
 *   2. The button doesn't render when the API is unsupported.
 *   3. Click toggles recognition lifecycle (start → onstart → active).
 *   4. Final transcripts call onTranscript(chunk, true).
 *   5. Interim transcripts call onTranscript(chunk, false).
 *   6. 'aborted' errors are silent (we triggered them).
 *   7. Real errors flip the button back to idle and surface in title.
 *   8. Disabled prop blocks start.
 *   9. Unmount during dictation cleans up via abort().
 */
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import {
  VoiceInput,
  isVoiceInputSupported,
} from "../../src/components/VoiceInput";

interface MockResult {
  isFinal: boolean;
  0: { transcript: string };
}

class MockSpeechRecognition {
  lang = "";
  continuous = false;
  interimResults = false;
  onresult: ((e: Event & { resultIndex: number; results: ArrayLike<MockResult> }) => void) | null = null;
  onerror: ((e: Event & { error: string }) => void) | null = null;
  onend: (() => void) | null = null;
  onstart: (() => void) | null = null;
  startCount = 0;
  stopCount = 0;
  abortCount = 0;

  start() {
    this.startCount++;
    // Fire onstart asynchronously (matches real API).
    setTimeout(() => this.onstart?.(), 0);
  }
  stop() {
    this.stopCount++;
    setTimeout(() => this.onend?.(), 0);
  }
  abort() {
    this.abortCount++;
    setTimeout(() => this.onend?.(), 0);
  }

  // Test helpers — drive the lifecycle from outside.
  emitResult(results: MockResult[], resultIndex = 0) {
    const ev = new Event("result") as Event & {
      resultIndex: number;
      results: ArrayLike<MockResult>;
    };
    Object.defineProperty(ev, "resultIndex", { value: resultIndex });
    Object.defineProperty(ev, "results", { value: results });
    this.onresult?.(ev);
  }
  emitError(code: string) {
    const ev = new Event("error") as Event & { error: string };
    Object.defineProperty(ev, "error", { value: code });
    this.onerror?.(ev);
  }
}

// Track the most recently constructed instance so tests can drive it.
let lastInstance: MockSpeechRecognition | null = null;
function MockCtor(this: MockSpeechRecognition) {
  const inst = new MockSpeechRecognition();
  lastInstance = inst;
  return inst;
}

beforeEach(() => {
  lastInstance = null;
  // Install the mock before render.
  (window as unknown as { SpeechRecognition: unknown }).SpeechRecognition =
    MockCtor as unknown as typeof window.SpeechRecognition;
});

afterEach(() => {
  cleanup();
  delete (window as unknown as { SpeechRecognition?: unknown }).SpeechRecognition;
  delete (window as unknown as { webkitSpeechRecognition?: unknown }).webkitSpeechRecognition;
  vi.useRealTimers();
});

describe("isVoiceInputSupported", () => {
  test("true when window.SpeechRecognition is set", () => {
    expect(isVoiceInputSupported()).toBe(true);
  });
  test("false when neither prefix is present", () => {
    delete (window as unknown as { SpeechRecognition?: unknown }).SpeechRecognition;
    expect(isVoiceInputSupported()).toBe(false);
  });
  test("true with the webkit prefix", () => {
    delete (window as unknown as { SpeechRecognition?: unknown }).SpeechRecognition;
    (window as unknown as { webkitSpeechRecognition: unknown }).webkitSpeechRecognition =
      MockCtor as unknown;
    expect(isVoiceInputSupported()).toBe(true);
  });
});

describe("<VoiceInput>", () => {
  test("renders nothing when the API is not supported", () => {
    delete (window as unknown as { SpeechRecognition?: unknown }).SpeechRecognition;
    const { container } = render(<VoiceInput onTranscript={() => {}} />);
    expect(container.firstChild).toBeNull();
  });

  test("clicking starts recognition and flips active=true", async () => {
    vi.useFakeTimers();
    render(<VoiceInput onTranscript={() => {}} />);
    const btn = screen.getByTestId("composer-voice");
    expect(btn.getAttribute("aria-pressed")).toBe("false");

    await act(async () => {
      fireEvent.click(btn);
      // Flush the async onstart timeout.
      vi.runAllTimers();
    });
    expect(lastInstance?.startCount).toBe(1);
    expect(btn.getAttribute("aria-pressed")).toBe("true");
  });

  test("final transcripts are forwarded with isFinal=true", async () => {
    vi.useFakeTimers();
    const onT = vi.fn();
    render(<VoiceInput onTranscript={onT} />);
    await act(async () => {
      fireEvent.click(screen.getByTestId("composer-voice"));
      vi.runAllTimers();
    });
    act(() => {
      lastInstance?.emitResult([
        { isFinal: true, 0: { transcript: "hello world" } },
      ]);
    });
    expect(onT).toHaveBeenCalledWith("hello world", true);
  });

  test("interim transcripts are forwarded with isFinal=false", async () => {
    vi.useFakeTimers();
    const onT = vi.fn();
    render(<VoiceInput onTranscript={onT} />);
    await act(async () => {
      fireEvent.click(screen.getByTestId("composer-voice"));
      vi.runAllTimers();
    });
    act(() => {
      lastInstance?.emitResult([
        { isFinal: false, 0: { transcript: "hel" } },
      ]);
    });
    expect(onT).toHaveBeenCalledWith("hel", false);
  });

  test("'aborted' error does NOT surface in the title", async () => {
    vi.useFakeTimers();
    render(<VoiceInput onTranscript={() => {}} />);
    await act(async () => {
      fireEvent.click(screen.getByTestId("composer-voice"));
      vi.runAllTimers();
    });
    act(() => {
      lastInstance?.emitError("aborted");
    });
    const btn = screen.getByTestId("composer-voice");
    expect(btn.getAttribute("title") ?? "").not.toMatch(/error/i);
  });

  test("real errors surface and flip the button back to idle", async () => {
    vi.useFakeTimers();
    render(<VoiceInput onTranscript={() => {}} />);
    await act(async () => {
      fireEvent.click(screen.getByTestId("composer-voice"));
      vi.runAllTimers();
    });
    act(() => {
      lastInstance?.emitError("not-allowed");
    });
    const btn = screen.getByTestId("composer-voice");
    expect(btn.getAttribute("aria-pressed")).toBe("false");
    expect(btn.getAttribute("title")).toMatch(/not-allowed/);
  });

  test("disabled blocks start", () => {
    render(<VoiceInput onTranscript={() => {}} disabled />);
    const btn = screen.getByTestId("composer-voice") as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    fireEvent.click(btn);
    expect(lastInstance).toBeNull();
  });

  test("unmount mid-dictation calls abort() for cleanup", async () => {
    vi.useFakeTimers();
    const { unmount } = render(<VoiceInput onTranscript={() => {}} />);
    await act(async () => {
      fireEvent.click(screen.getByTestId("composer-voice"));
      vi.runAllTimers();
    });
    expect(lastInstance?.startCount).toBe(1);
    unmount();
    expect(lastInstance?.abortCount).toBe(1);
  });
});
