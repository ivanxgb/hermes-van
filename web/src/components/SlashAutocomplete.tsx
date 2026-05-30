/**
 * Inline slash-command autocomplete for the composer.
 *
 * Triggers when the input starts with "/". Shows a popup above the
 * textarea with matching commands; ↑/↓ navigates, Tab/Enter completes
 * (replaces input with the full command name + space), Esc dismisses.
 *
 * The popup is purely presentational — keyboard handling lives in the
 * composer's onKeyDown so it can intercept before form submit.
 */
import type { CSSProperties } from "react";
import { SLASH_COMMANDS } from "./CommandPalette";

export interface SlashMatch {
  name: string;
  desc: string;
}

export function getSlashMatches(input: string): SlashMatch[] {
  if (!input.startsWith("/")) return [];
  const q = input.toLowerCase();
  return SLASH_COMMANDS.filter((c) => c.name.toLowerCase().startsWith(q));
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
          <span className="slash-name">{m.name}</span>
          <span className="slash-desc">{m.desc}</span>
        </button>
      ))}
    </div>
  );
}
