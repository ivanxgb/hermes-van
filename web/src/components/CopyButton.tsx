/**
 * Inline copy-to-clipboard button for message bodies.
 *
 * Uses navigator.clipboard.writeText with a textarea fallback for
 * non-secure contexts (older browsers or http://). Shows a transient
 * "copied" state for ~1.2s so the user gets feedback without a toast.
 */
import { useEffect, useRef, useState } from "react";

interface Props {
  text: string;
  /** Optional test id for e2e selectors. */
  testId?: string;
}

async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Fall through to legacy path.
  }
  if (typeof document === "undefined") return false;
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.setAttribute("readonly", "");
  ta.style.position = "fixed";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch {
    ok = false;
  }
  document.body.removeChild(ta);
  return ok;
}

export function CopyButton({ text, testId }: Props) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const timer = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    };
  }, []);

  async function onClick() {
    const ok = await copyToClipboard(text);
    setState(ok ? "copied" : "failed");
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setState("idle"), 1200);
  }

  const label =
    state === "copied" ? "copied" : state === "failed" ? "failed" : "copy";
  return (
    <button
      type="button"
      className={`btn-copy btn-copy-${state}`}
      onClick={onClick}
      data-testid={testId}
      data-state={state}
      aria-label="Copy message"
      title="Copy to clipboard"
    >
      {label}
    </button>
  );
}
