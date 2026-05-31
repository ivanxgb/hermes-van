/**
 * Command palette — keyboard-driven UI for chat switching, new-chat,
 * logout, settings, and slash-style commands.
 *
 * Open via Cmd/Ctrl+K. Type to fuzzy-filter. Enter to run.
 *
 * Slash commands come from the live gateway registry via `useCommands()`,
 * so the palette mirrors what the gateway actually accepts (plus plugin
 * commands). No hardcoded list.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { Chat } from "../lib/api";
import { useCommands, fuzzyMatchCommands } from "../lib/use-commands";

export interface PaletteCommand {
  id: string;
  label: string;
  hint?: string;
  group: "chats" | "actions" | "slash";
  run: () => void | Promise<void>;
}

interface Props {
  open: boolean;
  onClose: () => void;
  chats: Chat[];
  onSelectChat: (id: string) => void;
  onNewChat: () => void | Promise<void>;
  onSettings: () => void;
  onLogout: () => void | Promise<void>;
  onSlash: (slash: string) => void;
}

/** Cheap fuzzy match: every char of the query appears in order. */
function fuzzyMatch(haystack: string, needle: string): boolean {
  if (!needle) return true;
  const h = haystack.toLowerCase();
  const n = needle.toLowerCase();
  let i = 0;
  for (const ch of h) {
    if (ch === n[i]) i += 1;
    if (i === n.length) return true;
  }
  return i === n.length;
}

export function CommandPalette({
  open,
  onClose,
  chats,
  onSelectChat,
  onNewChat,
  onSettings,
  onLogout,
  onSlash,
}: Props) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  // Only fetch commands while the palette is mounted with open=true.
  const slash = useCommands(open);

  // Reset state on each open
  useEffect(() => {
    if (open) {
      setQuery("");
      setActive(0);
      // focus once the dialog mounts
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  const items = useMemo<PaletteCommand[]>(() => {
    const isSlash = query.startsWith("/");
    if (isSlash) {
      return fuzzyMatchCommands(slash.commands, query).map((c) => ({
        id: `slash:${c.name}`,
        label: `/${c.name}${c.args_hint ? ` ${c.args_hint}` : ""}`,
        hint: c.description,
        group: "slash" as const,
        run: () => onSlash(`/${c.name}`),
      }));
    }
    const actions: PaletteCommand[] = [
      {
        id: "act:new",
        label: "New chat",
        hint: "⌘ N",
        group: "actions",
        run: onNewChat,
      },
      {
        id: "act:settings",
        label: "Settings",
        hint: "/",
        group: "actions",
        run: onSettings,
      },
      {
        id: "act:logout",
        label: "Sign out",
        group: "actions",
        run: onLogout,
      },
    ];
    const chatItems: PaletteCommand[] = chats.map((c) => ({
      id: `chat:${c.id}`,
      label: c.title,
      hint: c.id.slice(-6),
      group: "chats",
      run: () => onSelectChat(c.id),
    }));
    return [...chatItems, ...actions].filter((cmd) =>
      fuzzyMatch(cmd.label, query),
    );
  }, [chats, onLogout, onNewChat, onSelectChat, onSettings, onSlash, query, slash.commands]);

  // Clamp active when items shrinks
  useEffect(() => {
    if (active >= items.length) setActive(Math.max(0, items.length - 1));
  }, [items.length, active]);

  if (!open) return null;

  function commit(cmd: PaletteCommand) {
    onClose();
    void cmd.run();
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => Math.min(items.length - 1, i + 1));
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => Math.max(0, i - 1));
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      const cmd = items[active];
      if (cmd) commit(cmd);
    }
  }

  return (
    <div
      className="palette-overlay"
      role="dialog"
      aria-modal="true"
      data-testid="palette-overlay"
      onClick={onClose}
    >
      <div
        className="palette"
        role="combobox"
        aria-expanded="true"
        aria-controls="palette-listbox"
        onClick={(e) => e.stopPropagation()}
      >
        <input
          ref={inputRef}
          className="palette-input"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Type to search chats, actions, or / for slash commands"
          data-testid="palette-input"
          autoComplete="off"
          spellCheck={false}
        />
        {query.startsWith("/") && slash.status === "loading" ? (
          <div className="palette-loading">…loading commands</div>
        ) : null}
        {query.startsWith("/") && slash.status === "error" ? (
          <div className="palette-error">gateway error: {slash.error}</div>
        ) : null}
        <ul
          id="palette-listbox"
          role="listbox"
          className="palette-list"
          data-testid="palette-list"
        >
          {items.length === 0 ? (
            <li className="palette-empty">No matches</li>
          ) : (
            items.map((cmd, i) => (
              <li
                key={cmd.id}
                role="option"
                aria-selected={i === active}
                className={`palette-item ${i === active ? "active" : ""}`}
                data-testid={`palette-item-${cmd.id}`}
                data-group={cmd.group}
                onMouseEnter={() => setActive(i)}
                onClick={() => commit(cmd)}
              >
                <span className="palette-label">{cmd.label}</span>
                {cmd.hint ? <span className="palette-hint">{cmd.hint}</span> : null}
                <span className="palette-group">{cmd.group}</span>
              </li>
            ))
          )}
        </ul>
        <div className="palette-foot">
          <kbd>↑↓</kbd> nav <kbd>↵</kbd> run <kbd>esc</kbd> close
        </div>
      </div>
    </div>
  );
}
