/**
 * Inline slash-command autocomplete for the composer.
 *
 * Triggers when the input starts with "/". Shows a popup above the
 * textarea with matching commands; ↑/↓ navigates, Tab/Enter completes
 * (replaces input with the full command name + space), Esc dismisses.
 *
 * Source of commands is the live gateway registry via `useCommands()`,
 * so the list reflects whatever the gateway actually accepts (built-in
 * commands filtered for gateway availability + plugin commands).
 *
 * Layout:
 *   - When the user has only typed `/` (no filter chars), commands are
 *     grouped by category with sticky-style headers so the list reads
 *     like a menu rather than a flat dump of 45 entries.
 *   - When a filter is active (`/mo`, `/cl`, etc.) we drop grouping and
 *     show a flat list — usually only a handful of matches anyway.
 */
import type { CSSProperties } from "react";
import type { CommandRecord } from "../lib/api";
import { matchSlashCommands } from "../lib/use-commands";

export interface SlashMatch {
  name: string; // includes leading slash, e.g. "/new"
  desc: string;
  argsHint?: string;
  category?: string;
  aliases?: string[];
}

/**
 * Convert the registry into the shape the composer keyboard handler
 * expects, restricted to commands whose name starts with `input`.
 */
export function getSlashMatches(
  commands: CommandRecord[],
  input: string,
): SlashMatch[] {
  return matchSlashCommands(commands, input).map((c) => ({
    name: `/${c.name}`,
    desc: c.description,
    argsHint: c.args_hint || undefined,
    category: c.category || undefined,
    aliases: c.aliases?.length ? c.aliases : undefined,
  }));
}

interface Props {
  matches: SlashMatch[];
  active: number;
  onPick: (cmd: SlashMatch) => void;
  onHover: (index: number) => void;
  /** Set true when the input is exactly "/" — turns on category headers. */
  grouped?: boolean;
}

export function SlashAutocomplete({
  matches,
  active,
  onPick,
  onHover,
  grouped = false,
}: Props) {
  if (matches.length === 0) return null;
  const style: CSSProperties = { position: "absolute" };

  // Build a render plan: list of items in display order. When grouped,
  // we walk the categories in stable order and emit a header before
  // each group. Active index references the underlying matches array
  // so keyboard nav stays consistent regardless of headers.
  type Row =
    | { kind: "header"; key: string; label: string }
    | { kind: "item"; key: string; index: number; match: SlashMatch };

  const rows: Row[] = [];
  if (grouped) {
    const seen = new Map<string, number[]>();
    matches.forEach((m, i) => {
      const cat = m.category ?? "Other";
      if (!seen.has(cat)) seen.set(cat, []);
      seen.get(cat)!.push(i);
    });
    for (const [cat, indices] of seen) {
      rows.push({ kind: "header", key: `h:${cat}`, label: cat });
      for (const i of indices) {
        const m = matches[i];
        if (!m) continue;
        rows.push({ kind: "item", key: `i:${i}:${m.name}`, index: i, match: m });
      }
    }
  } else {
    matches.forEach((m, i) => {
      rows.push({ kind: "item", key: `i:${i}:${m.name}`, index: i, match: m });
    });
  }

  return (
    <div
      className="slash-autocomplete"
      role="listbox"
      data-testid="slash-autocomplete"
      style={style}
    >
      {rows.map((row) =>
        row.kind === "header" ? (
          <div
            key={row.key}
            className="slash-header"
            role="presentation"
            data-testid={`slash-header-${row.label}`}
          >
            {row.label}
          </div>
        ) : (
          <button
            key={row.key}
            type="button"
            role="option"
            aria-selected={row.index === active}
            className={`slash-item ${row.index === active ? "active" : ""}`}
            data-testid={`slash-item-${row.match.name.slice(1)}`}
            onMouseEnter={() => onHover(row.index)}
            onMouseDown={(e) => {
              // mousedown so the textarea doesn't blur before the click fires
              e.preventDefault();
              onPick(row.match);
            }}
          >
            <span className="slash-name">
              {row.match.name}
              {row.match.argsHint ? (
                <span className="slash-args"> {row.match.argsHint}</span>
              ) : null}
              {row.match.aliases && row.match.aliases.length > 0 ? (
                <span className="slash-aliases">
                  {" "}/{row.match.aliases.join(", /")}
                </span>
              ) : null}
            </span>
            <span className="slash-desc">{row.match.desc}</span>
          </button>
        ),
      )}
    </div>
  );
}
