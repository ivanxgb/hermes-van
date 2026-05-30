/**
 * Command palette — keyboard-driven UI for chat switching, new-chat,
 * logout, settings, and slash-style commands.
 *
 * Open via Cmd/Ctrl+K. Type to fuzzy-filter. Enter to run.
 *
 * Commands are sourced from a static registry (cli/web parity) plus the
 * dynamic chat list. Future: pull /v1/capabilities for gateway-side
 * commands, but the static registry covers the common case and avoids
 * an extra round-trip per palette open.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { Chat } from "../lib/api";

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

/** Subset of CLI slash commands that map to web actions. */
export const SLASH_COMMANDS = [
  { name: "/new", desc: "Start a new chat" },
  { name: "/clear", desc: "Clear current chat (delete & recreate)" },
  { name: "/help", desc: "Show keyboard shortcuts" },
  { name: "/model", desc: "Change model for the current chat" },
  { name: "/settings", desc: "Open settings" },
  { name: "/capabilities", desc: "Browse skills and toolsets" },
  { name: "/jobs", desc: "Browse scheduled cron jobs" },
  { name: "/fork", desc: "Fork the current chat" },
  { name: "/logout", desc: "Sign out" },
];

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
      return SLASH_COMMANDS.filter((s) => fuzzyMatch(s.name, query)).map((s) => ({
        id: `slash:${s.name}`,
        label: s.name,
        hint: s.desc,
        group: "slash" as const,
        run: () => onSlash(s.name),
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
  }, [chats, onLogout, onNewChat, onSelectChat, onSettings, onSlash, query]);

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
