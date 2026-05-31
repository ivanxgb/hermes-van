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
 */
import type { CSSProperties } from "react";
import type { CommandRecord } from "../lib/api";
import { matchSlashCommands } from "../lib/use-commands";

export interface SlashMatch {
  name: string; // includes leading slash, e.g. "/new"
  desc: string;
  argsHint?: string;
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
  }));
}

interface Props {
  matches: SlashMatch[];
  active: number;
  onPick: (cmd: SlashMatch) => void;
  onHover: (index: number) => void;
}

export function SlashAutocomplete({ matches, active, onPick, onHover }: Props) {
  if (matches.length === 0) return null;
  const style: CSSProperties = { position: "absolute" };
  return (
    <div
      className="slash-autocomplete"
      role="listbox"
      data-testid="slash-autocomplete"
      style={style}
    >
      {matches.map((m, i) => (
        <button
          key={m.name}
          type="button"
          role="option"
          aria-selected={i === active}
          className={`slash-item ${i === active ? "active" : ""}`}
          data-testid={`slash-item-${m.name.slice(1)}`}
          onMouseEnter={() => onHover(i)}
          onMouseDown={(e) => {
            // mousedown so the textarea doesn't blur before the click fires
            e.preventDefault();
            onPick(m);
          }}
        >
          <span className="slash-name">
            {m.name}
            {m.argsHint ? <span className="slash-args"> {m.argsHint}</span> : null}
          </span>
          <span className="slash-desc">{m.desc}</span>
        </button>
      ))}
    </div>
  );
}
