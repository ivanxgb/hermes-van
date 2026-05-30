/**
 * Search palette — full-text search across the user's message history.
 *
 * Talks to GET /api/chats/_search (FTS5-backed). Snippets come back from
 * SQLite with [[ … ]] markers around matches; we render those as <mark>.
 *
 * Open via Cmd/Ctrl+Shift+F. Type to search, ↑↓ to navigate, ↵ to jump
 * to the message in its chat. Esc closes.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { chats as chatsApi, type Chat, type SearchResult, ApiError } from "../lib/api";

interface Props {
  open: boolean;
  onClose: () => void;
  chats: Chat[];
  onSelect: (chatId: string, messageId: string) => void;
}

interface DebouncedSearchState {
  status: "idle" | "loading" | "ready" | "error";
  results: SearchResult[];
  error: string | null;
}

/**
 * Render a snippet with [[match]] markers as React fragments containing
 * <mark> for the highlighted spans. Snippets are server-side, so we
 * don't have to worry about XSS — but we still escape via React text nodes.
 */
function HighlightedSnippet({ snippet }: { snippet: string }) {
  if (!snippet) return null;
  const parts: Array<{ text: string; mark: boolean }> = [];
  let i = 0;
  while (i < snippet.length) {
    const open = snippet.indexOf("[[", i);
    if (open === -1) {
      parts.push({ text: snippet.slice(i), mark: false });
      break;
    }
    if (open > i) parts.push({ text: snippet.slice(i, open), mark: false });
    const close = snippet.indexOf("]]", open + 2);
    if (close === -1) {
      // Malformed snippet — render the rest as plain text.
      parts.push({ text: snippet.slice(open), mark: false });
      break;
    }
    parts.push({ text: snippet.slice(open + 2, close), mark: true });
    i = close + 2;
  }
  return (
    <>
      {parts.map((p, idx) =>
        p.mark ? <mark key={idx}>{p.text}</mark> : <span key={idx}>{p.text}</span>,
      )}
    </>
  );
}

export function SearchPalette({ open, onClose, chats, onSelect }: Props) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [state, setState] = useState<DebouncedSearchState>({
    status: "idle",
    results: [],
    error: null,
  });
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Reset on every open
  useEffect(() => {
    if (open) {
      setQuery("");
      setActive(0);
      setState({ status: "idle", results: [], error: null });
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  // Debounce + abort previous request when typing
  useEffect(() => {
    if (!open) return;
    const trimmed = query.trim();
    if (!trimmed) {
      setState({ status: "idle", results: [], error: null });
      return;
    }
    const controller = new AbortController();
    setState((s) => ({ ...s, status: "loading" }));
    const handle = window.setTimeout(async () => {
      try {
        const { results } = await chatsApi.search(trimmed, { limit: 50 });
        if (controller.signal.aborted) return;
        setState({ status: "ready", results, error: null });
        setActive(0);
      } catch (err) {
        if (controller.signal.aborted) return;
        const msg =
          err instanceof ApiError
            ? typeof err.body === "object" && err.body && "error" in err.body
              ? String((err.body as { error: unknown }).error)
              : `HTTP ${err.status}`
            : err instanceof Error
              ? err.message
              : "Search failed";
        setState({ status: "error", results: [], error: msg });
      }
    }, 200);
    return () => {
      controller.abort();
      window.clearTimeout(handle);
    };
  }, [query, open]);

  // Map chatId -> chat title for fast lookup
  const titles = useMemo(() => {
    const m = new Map<string, string>();
    for (const c of chats) m.set(c.id, c.title);
    return m;
  }, [chats]);

  if (!open) return null;

  function commit(r: SearchResult) {
    onClose();
    onSelect(r.chatId, r.id);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => Math.min(state.results.length - 1, i + 1));
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => Math.max(0, i - 1));
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      const r = state.results[active];
      if (r) commit(r);
    }
  }

  return (
    <div
      className="palette-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="Search messages"
      data-testid="search-overlay"
      onClick={onClose}
    >
      <div
        className="palette search-palette"
        role="combobox"
        aria-expanded="true"
        aria-controls="search-listbox"
        onClick={(e) => e.stopPropagation()}
      >
        <input
          ref={inputRef}
          className="palette-input"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Search messages (FTS5: prefix*, &quot;phrase&quot;, AND/OR)"
          data-testid="search-input"
          autoComplete="off"
          spellCheck={false}
        />
        <ul
          id="search-listbox"
          role="listbox"
          className="palette-list search-list"
          data-testid="search-list"
        >
          {state.status === "loading" && state.results.length === 0 ? (
            <li className="palette-empty">Searching…</li>
          ) : state.status === "error" ? (
            <li className="palette-empty" data-testid="search-error">
              {state.error ?? "Search failed"}
            </li>
          ) : state.status === "idle" ? (
            <li className="palette-empty">Type to search across every chat</li>
          ) : state.results.length === 0 ? (
            <li className="palette-empty" data-testid="search-empty">
              No matches
            </li>
          ) : (
            state.results.map((r, i) => {
              const title = titles.get(r.chatId) ?? r.chatId.slice(-6);
              return (
                <li
                  key={r.id}
                  role="option"
                  aria-selected={i === active}
                  className={`palette-item search-item ${i === active ? "active" : ""}`}
                  data-testid={`search-item-${r.id}`}
                  data-chat-id={r.chatId}
                  data-message-id={r.id}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => commit(r)}
                >
                  <div className="search-line">
                    <span className={`search-role search-role-${r.role}`}>
                      {r.role}
                    </span>
                    <span className="search-title">{title}</span>
                  </div>
                  <div className="search-snippet" data-testid="search-snippet">
                    <HighlightedSnippet snippet={r.snippet} />
                  </div>
                </li>
              );
            })
          )}
        </ul>
        <div className="palette-foot">
          <kbd>↑↓</kbd> nav <kbd>↵</kbd> open <kbd>esc</kbd> close
        </div>
      </div>
    </div>
  );
}
