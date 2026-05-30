/**
 * ModelSelector — drill-down popup for picking which model the active
 * chat should run against.
 *
 * UX:
 *   - First view: list of providers (Kiro, Anthropic, Vertex AI, …)
 *     with a small caption showing how many models each one carries.
 *   - Tap a provider → drill into its model list. Back arrow returns.
 *   - Type in the search box at any level → flat result list filtered
 *     across every provider (escapes the drill).
 *   - Footer offers Custom… (free-form id) and "Use gateway default"
 *     when a model is currently set.
 *
 * State stays local; the caller owns the actual patch via onPick.
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

type View =
  | { kind: "providers" }
  | { kind: "models"; provider: string }
  | { kind: "search"; query: string };

export function ModelSelector({ value, onPick, disabled }: Props) {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<View>({ kind: "providers" });
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Reset on each open. If the chat has a model from a known provider,
  // open straight to that provider's list so the current pick is right
  // there — saves a tap.
  useEffect(() => {
    if (!open) return;
    setQuery("");
    setActive(0);
    const current = MODELS.find((m) => m.id === value);
    setView(
      current
        ? { kind: "models", provider: current.provider }
        : { kind: "providers" },
    );
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [open, value]);

  // Click outside / Escape closes.
  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        if (view.kind === "models" && !query) {
          setView({ kind: "providers" });
        } else {
          setOpen(false);
        }
      }
    }
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, view, query]);

  // Provider summary for the first view.
  const providers = useMemo(() => {
    const out = new Map<string, ModelOption[]>();
    for (const m of MODELS) {
      if (!out.has(m.provider)) out.set(m.provider, []);
      out.get(m.provider)!.push(m);
    }
    return Array.from(out.entries());
  }, []);

  // Flat search results when the user types.
  const searchMatches = useMemo<ModelOption[]>(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return MODELS.filter(
      (m) =>
        m.id.toLowerCase().includes(q) ||
        m.label.toLowerCase().includes(q) ||
        m.provider.toLowerCase().includes(q),
    );
  }, [query]);

  const inSearch = query.trim().length > 0;
  const inModels = view.kind === "models" && !inSearch;
  const modelList = inModels
    ? MODELS.filter((m) => m.provider === view.provider)
    : [];

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

  // Pick the active list for keyboard navigation. Providers, models,
  // or search results — whichever is on screen.
  const navList: { type: "provider" | "model"; key: string; data: unknown }[] =
    inSearch
      ? searchMatches.map((m) => ({ type: "model", key: m.id, data: m }))
      : inModels
        ? modelList.map((m) => ({ type: "model", key: m.id, data: m }))
        : providers.map(([p, ms]) => ({ type: "provider", key: p, data: ms }));

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => Math.min(navList.length - 1, i + 1));
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => Math.max(0, i - 1));
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      const item = navList[active];
      if (!item) return;
      if (item.type === "provider") {
        setView({ kind: "models", provider: item.key });
        setActive(0);
      } else {
        commit(item.data as ModelOption);
      }
      return;
    }
    if (e.key === "ArrowLeft" && inModels && !query) {
      e.preventDefault();
      setView({ kind: "providers" });
      setActive(0);
    }
  }

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
          <div className="model-head">
            {inModels ? (
              <button
                type="button"
                className="model-back"
                onClick={() => {
                  setView({ kind: "providers" });
                  setActive(0);
                }}
                aria-label="Back to providers"
                data-testid="model-back"
              >
                ←
              </button>
            ) : null}
            <input
              ref={inputRef}
              className="model-search"
              placeholder={
                inModels
                  ? `Search ${view.provider}…`
                  : "Search providers and models…"
              }
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
          </div>

          <div className="model-list">
            {inSearch ? (
              searchMatches.length === 0 ? (
                <div className="model-empty">no matches</div>
              ) : (
                searchMatches.map((m, i) => (
                  <button
                    key={m.id}
                    type="button"
                    role="option"
                    aria-selected={i === active}
                    className={`model-item ${i === active ? "active" : ""} ${
                      m.id === value ? "current" : ""
                    }`}
                    onClick={() => commit(m)}
                    onMouseEnter={() => setActive(i)}
                    data-testid={`model-item-${m.id}`}
                  >
                    <div className="model-item-main">
                      <span className="model-item-label">{m.label}</span>
                      <span className="model-item-provider">
                        {m.provider}
                      </span>
                    </div>
                    <span className="model-item-tags">
                      {(m.tags ?? []).map((t) => (
                        <span key={t} className="model-tag">
                          {t}
                        </span>
                      ))}
                    </span>
                  </button>
                ))
              )
            ) : inModels ? (
              modelList.map((m, i) => (
                <button
                  key={m.id}
                  type="button"
                  role="option"
                  aria-selected={i === active}
                  className={`model-item ${i === active ? "active" : ""} ${
                    m.id === value ? "current" : ""
                  }`}
                  onClick={() => commit(m)}
                  onMouseEnter={() => setActive(i)}
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
              ))
            ) : (
              providers.map(([p, ms], i) => (
                <button
                  key={p}
                  type="button"
                  role="option"
                  aria-selected={i === active}
                  className={`model-provider-item ${
                    i === active ? "active" : ""
                  }`}
                  onClick={() => {
                    setView({ kind: "models", provider: p });
                    setActive(0);
                  }}
                  onMouseEnter={() => setActive(i)}
                  data-testid={`model-provider-${p}`}
                >
                  <span className="model-provider-name">{p}</span>
                  <span className="model-provider-meta">
                    {ms.length} model{ms.length === 1 ? "" : "s"}
                    <span className="model-provider-caret">›</span>
                  </span>
                </button>
              ))
            )}
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
