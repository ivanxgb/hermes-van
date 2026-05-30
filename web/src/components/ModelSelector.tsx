/**
 * ModelSelector — popup dropdown for picking which model the active
 * chat should run against.
 *
 * Triggered by clicking the model pill in the chat header. The pill
 * shows current model (or "default"). Dropdown groups models by
 * provider, lets the user search by typing, and offers a "Custom..."
 * row that opens a window.prompt for free-form ids.
 *
 * State is local (open/closed, query, active index). The caller owns
 * the actual model assignment via onPick.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { MODELS, type ModelOption, modelDisplay } from "../lib/models";

interface Props {
  /** Current model id on the chat (or null = gateway default). */
  value: string | null;
  /** Called when the user picks a model or clears it (null). */
  onPick: (id: string | null) => void;
  /** Disabled while a run is streaming. */
  disabled?: boolean;
}

export function ModelSelector({ value, onPick, disabled }: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Reset query each open + focus the search box.
  useEffect(() => {
    if (!open) return;
    setQuery("");
    setActive(0);
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [open]);

  // Click outside / Escape closes.
  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const matches = useMemo<ModelOption[]>(() => {
    const q = query.trim().toLowerCase();
    if (!q) return MODELS;
    return MODELS.filter(
      (m) =>
        m.id.toLowerCase().includes(q) ||
        m.label.toLowerCase().includes(q) ||
        m.provider.toLowerCase().includes(q),
    );
  }, [query]);

  // Group while preserving filter ordering.
  const groups = useMemo(() => {
    const out = new Map<string, ModelOption[]>();
    for (const m of matches) {
      if (!out.has(m.provider)) out.set(m.provider, []);
      out.get(m.provider)!.push(m);
    }
    return out;
  }, [matches]);

  function commit(m: ModelOption) {
    setOpen(false);
    onPick(m.id);
  }

  function pickCustom() {
    setOpen(false);
    const next = window.prompt(
      "Custom model id\nEmpty to use gateway default.",
      value ?? "",
    );
    if (next === null) return;
    const trimmed = next.trim();
    onPick(trimmed.length === 0 ? null : trimmed);
  }

  function clear() {
    setOpen(false);
    onPick(null);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => Math.min(matches.length - 1, i + 1));
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => Math.max(0, i - 1));
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      const cmd = matches[active];
      if (cmd) commit(cmd);
    }
  }

  let runningIndex = -1;

  return (
    <div className="model-selector" ref={wrapRef}>
      <button
        type="button"
        className="model-pill"
        onClick={() => !disabled && setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-disabled={disabled}
        disabled={disabled}
        data-testid="model-pill"
        title={value ?? "Using gateway default"}
      >
        <span className="model-pill-label">{modelDisplay(value)}</span>
        <span className="model-pill-caret" aria-hidden="true">▾</span>
      </button>

      {open ? (
        <div
          className="model-popover"
          role="listbox"
          data-testid="model-popover"
        >
          <input
            ref={inputRef}
            className="model-search"
            placeholder="Search models…"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
            }}
            onKeyDown={onKeyDown}
            data-testid="model-search"
            spellCheck={false}
            autoComplete="off"
          />
          <div className="model-list">
            {Array.from(groups.entries()).map(([provider, items]) => (
              <div key={provider} className="model-group">
                <div className="model-group-head">{provider}</div>
                {items.map((m) => {
                  runningIndex += 1;
                  const idx = runningIndex;
                  return (
                    <button
                      key={m.id}
                      type="button"
                      role="option"
                      aria-selected={idx === active || m.id === value}
                      className={`model-item ${
                        idx === active ? "active" : ""
                      } ${m.id === value ? "current" : ""}`}
                      onClick={() => commit(m)}
                      onMouseEnter={() => setActive(idx)}
                      data-testid={`model-item-${m.id}`}
                    >
                      <span className="model-item-label">{m.label}</span>
                      <span className="model-item-tags">
                        {(m.tags ?? []).map((t) => (
                          <span key={t} className="model-tag">
                            {t}
                          </span>
                        ))}
                      </span>
                    </button>
                  );
                })}
              </div>
            ))}
            {matches.length === 0 ? (
              <div className="model-empty">no matches</div>
            ) : null}
          </div>
          <div className="model-foot">
            <button
              type="button"
              className="model-foot-btn"
              onClick={pickCustom}
              data-testid="model-custom"
            >
              Custom…
            </button>
            {value ? (
              <button
                type="button"
                className="model-foot-btn"
                onClick={clear}
                data-testid="model-clear"
              >
                Use gateway default
              </button>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
