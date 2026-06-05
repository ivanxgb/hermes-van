/**
 * Voice input button — Phase 6.C.
 *
 * Wraps the browser's Web Speech API (`SpeechRecognition`). The button
 * is hidden when the API isn't available (Firefox desktop, most non-
 * Chromium browsers). When supported:
 *
 *   - Click once to start dictating. Interim transcripts stream into
 *     the composer in real-time.
 *   - Click again to stop. The final transcript replaces the interim
 *     text.
 *   - Auto-stops after the platform's natural silence-end-of-speech
 *     event (`onend`).
 *   - Errors (no-speech, audio-capture, not-allowed) flip the button
 *     back to idle and surface a tooltip; the parent textarea retains
 *     whatever was typed manually.
 *
 * The component is controlled: it doesn't own the text. It calls
 * `onTranscript` with each interim+final result, and the parent merges
 * it into composer state. This means a user who starts dictating, then
 * types, doesn't lose their typed text — the next interim chunk
 * appends instead of replacing.
 *
 * Design choice: the public API takes a `getCurrent` getter so the
 * component reads the latest composer value at speech-event time
 * rather than at registration time. Avoids stale-closure bugs where
 * the textarea's current value lags behind what the user typed
 * mid-dictation.
 */
import { useEffect, useRef, useState } from "react";

// Web Speech API isn't part of lib.dom.d.ts. Minimal local typings.
interface SpeechRecognitionResult {
  isFinal: boolean;
  0: { transcript: string };
}
interface SpeechRecognitionEvent extends Event {
  resultIndex: number;
  results: ArrayLike<SpeechRecognitionResult>;
}
interface SpeechRecognitionErrorEvent extends Event {
  error: string;
}
interface SpeechRecognitionInstance {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start: () => void;
  stop: () => void;
  abort: () => void;
  onresult: ((e: SpeechRecognitionEvent) => void) | null;
  onerror: ((e: SpeechRecognitionErrorEvent) => void) | null;
  onend: (() => void) | null;
  onstart: (() => void) | null;
}
interface SpeechRecognitionCtor {
  new (): SpeechRecognitionInstance;
}

declare global {
  interface Window {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  }
}

export function isVoiceInputSupported(): boolean {
  if (typeof window === "undefined") return false;
  return !!(window.SpeechRecognition || window.webkitSpeechRecognition);
}

export interface VoiceInputProps {
  /** Called with each new transcript chunk (interim + final). */
  onTranscript: (chunk: string, isFinal: boolean) => void;
  /** BCP-47 language tag. Defaults to the browser's UI language. */
  lang?: string;
  /** Disable while parent is busy (e.g. streaming a response). */
  disabled?: boolean;
}

export function VoiceInput({ onTranscript, lang, disabled }: VoiceInputProps) {
  const [supported] = useState(isVoiceInputSupported);
  const [active, setActive] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const recRef = useRef<SpeechRecognitionInstance | null>(null);

  useEffect(() => {
    return () => {
      // Clean up if the component unmounts mid-dictation.
      try {
        recRef.current?.abort();
      } catch {
        // ignore
      }
    };
  }, []);

  if (!supported) return null;

  function start() {
    if (active || disabled) return;
    const Ctor = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!Ctor) return;
    const rec = new Ctor();
    rec.lang = lang ?? (typeof navigator !== "undefined" ? navigator.language : "en-US");
    rec.continuous = true;
    rec.interimResults = true;
    rec.onstart = () => {
      setActive(true);
      setError(null);
    };
    rec.onresult = (e) => {
      // Walk the new results from resultIndex onward. Each chunk is
      // either interim (still being transcribed) or final.
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i]!;
        onTranscript(r[0].transcript, r.isFinal);
      }
    };
    rec.onerror = (e) => {
      // 'aborted' fires whenever we call stop(); not an error worth showing.
      if (e.error !== "aborted") setError(e.error);
      setActive(false);
    };
    rec.onend = () => {
      setActive(false);
    };
    recRef.current = rec;
    try {
      rec.start();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setActive(false);
    }
  }

  function stop() {
    try {
      recRef.current?.stop();
    } catch {
      // ignore
    }
    setActive(false);
  }

  return (
    <button
      type="button"
      className={active ? "btn-voice active" : "btn-voice"}
      onClick={() => (active ? stop() : start())}
      disabled={disabled && !active}
      data-testid="composer-voice"
      aria-pressed={active}
      aria-label={active ? "Stop voice input" : "Start voice input"}
      title={
        error
          ? `Voice input error: ${error}`
          : active
            ? "Listening… click to stop"
            : "Voice input"
      }
    >
      <span aria-hidden="true" className="btn-voice-dot" />
      {active ? "● rec" : "🎤"}
    </button>
  );
}
