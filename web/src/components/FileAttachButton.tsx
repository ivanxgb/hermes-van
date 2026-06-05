/**
 * File attachment button — Phase 6.D.2.
 *
 * Wraps a hidden <input type="file">. On selection, uploads to
 * /api/uploads, then calls onAttached() with the markdown snippet to
 * insert into the composer textarea. The snippet is either:
 *
 *   ![filename](/api/uploads/<id>/raw)    for image/* mime types
 *   [filename](/api/uploads/<id>/raw)     for everything else
 *
 * The chat layer's existing markdown pipeline (lib/markdown.ts) already
 * renders these — image previews come for free because <img> is in
 * SAFE_CONFIG.ALLOWED_TAGS and the relative URL passes the URI regex.
 *
 * The MEDIA: protocol form is *also* attached as a hidden data attr on
 * the response so server-side integrations (Hermes gateway) that
 * understand `MEDIA:` prefixes can pick it up — but the chat surface
 * uses plain markdown so previews work without bespoke parsing.
 *
 * Errors surface as a tooltip on the button (size cap, mime denylist,
 * network failure). The textarea retains whatever was typed.
 */
import { useRef, useState } from "react";
import { uploads as uploadsApi } from "../lib/api";

export interface FileAttachButtonProps {
  /** Called with the markdown snippet to splice into the composer. */
  onAttached: (snippet: string) => void;
  /** Optional chatId to associate the upload with. */
  chatId?: string;
  /** Disable while parent is busy (streaming a response). */
  disabled?: boolean;
}

function isImageMime(mime: string): boolean {
  return mime.toLowerCase().startsWith("image/");
}

function escapeMarkdownLabel(s: string): string {
  // Keep filenames readable but defang ] and \ so the link parses.
  return s.replace(/\\/g, "\\\\").replace(/\]/g, "\\]");
}

export function FileAttachButton({
  onAttached,
  chatId,
  disabled,
}: FileAttachButtonProps) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    // Reset the input value immediately so picking the same file twice
    // still triggers a new upload (browsers de-dupe identical values).
    if (inputRef.current) inputRef.current.value = "";
    if (!file) return;
    setError(null);
    setBusy(true);
    try {
      const result = await uploadsApi.upload(file, chatId);
      const label = escapeMarkdownLabel(result.filename);
      const url = `/api/uploads/${result.id}/raw`;
      const snippet = isImageMime(result.mimeType)
        ? `![${label}](${url})`
        : `[${label}](${url})`;
      onAttached(snippet);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <input
        ref={inputRef}
        type="file"
        style={{ display: "none" }}
        data-testid="composer-file-input"
        onChange={onFileChange}
      />
      <button
        type="button"
        className={busy ? "btn-attach busy" : "btn-attach"}
        onClick={() => inputRef.current?.click()}
        disabled={disabled || busy}
        data-testid="composer-attach"
        aria-label="Attach a file"
        title={
          error
            ? `Upload failed: ${error}`
            : busy
              ? "Uploading…"
              : "Attach file"
        }
      >
        {busy ? "…" : "📎"}
      </button>
    </>
  );
}
