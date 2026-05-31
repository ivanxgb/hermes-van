/**
 * ModelSelector — drill-down popover backed by live gateway data.
 *
 * Data source: GET /api/gateway/providers (proxy to /v1/providers on the
 * Hermes gateway). The list of providers and their models is whatever the
 * gateway sees in config.yaml + has working credentials for — same source
 * Telegram /model uses. There is no hardcoded list anywhere in the FE.
 *
 * UX:
 *   - Pill in the chat header shows "<provider · model>" of the active
 *     selection. Tap to open.
 *   - First view: providers (with model count + "current" badge on the
 *     gateway-default provider).
 *   - Tap a provider → drill into its models. Back arrow returns.
 *   - Type in the search box → flat results across every provider.
 *   - Foot row: "Set as default globally" persists via /v1/model/switch
 *     scope=global. Without that, picking a model just sets the chat-local
 *     model (passed on every /v1/runs request).
 *
 * Picking a model fires `onPick(modelId, providerSlug)`. Caller decides
 * how to persist (chat-local vs global). The component itself never
 * mutates global config unless the user explicitly clicks the global btn.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useProviders, fetchProviders } from "../lib/use-providers";
import { gateway, type ProviderRecord } from "../lib/api";

interface Props {
  /** Current model id on the chat (or null = gateway default). */
  value: string | null;
  /**
   * Called when the user picks a model. `providerSlug` is the matching
   * provider slug from the gateway, useful for caller analytics or to
   * scope future overrides. The caller persists the choice.
   */
  onPick: (modelId: string | null, providerSlug: string | null) => void;
  /** Disabled while a run is streaming. */
  disabled?: boolean;
}

interface FlatMatch {
  modelId: string;
  providerSlug: string;
  providerLabel: string;
}

/**
 * Pretty label for the pill: prefer the human "ProviderLabel · model" shape
 * when we know the provider, otherwise fall back to the raw id.
 */
function pillLabel(
  modelId: string | null,
  providers: ProviderRecord[],
  fallbackCurrentProvider: string,
  fallbackCurrentModel: string,
): string {
  if (!modelId) {
    if (fallbackCurrentModel) {
      const owner = providers.find((p) => p.slug === fallbackCurrentProvider);
      return owner
        ? `${owner.label} · ${fallbackCurrentModel}`
        : fallbackCurrentModel;
    }
    return "default";
  }
  const owner = providers.find((p) => (p.models ?? []).includes(modelId));
  return owner ? `${owner.label} · ${modelId}` : modelId;
}

export function ModelSelector({ value, onPick, disabled }: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [drillSlug, setDrillSlug] = useState<string | null>(null);
  const [pendingGlobal, setPendingGlobal] = useState(false);
  const [globalError, setGlobalError] = useState<string | null>(null);
  const [anchorRect, setAnchorRect] = useState<DOMRect | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const pillRef = useRef<HTMLButtonElement | null>(null);
  const popRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const providersState = useProviders(open);
  const providers = providersState.data?.providers ?? [];
  const currentProvider = providersState.data?.current.provider ?? "";
  const currentModel = providersState.data?.current.model ?? "";

  // Track the pill's rect while open so the portalled popover can anchor
  // to it. Re-measured on scroll/resize.
  useLayoutEffect(() => {
    if (!open) return;
    function measure() {
      if (pillRef.current) setAnchorRect(pillRef.current.getBoundingClientRect());
    }
    measure();
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    return () => {
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
    };
  }, [open]);

  // On open: reset, focus, and if the current model belongs to a known
  // provider, drill straight to that provider so the active pick is
  // visible without a tap.
  useEffect(() => {
    if (!open) return;
    setQuery("");
    setActive(0);
    setGlobalError(null);
    const owner = providers.find((p) => (p.models ?? []).includes(value ?? ""));
    setDrillSlug(owner?.slug ?? null);
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [open, value, providers]);

  // Click-outside / Escape closes. The popover is portalled to body so we
  // also have to exempt clicks inside it (otherwise every option click
  // would close before firing).
  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      const t = e.target as Node;
      const inWrap = wrapRef.current?.contains(t);
      const inPop = popRef.current?.contains(t);
      if (!inWrap && !inPop) {
        setOpen(false);
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        if (drillSlug && !query) {
          setDrillSlug(null);
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
  }, [open, drillSlug, query]);

  const inSearch = query.trim().length > 0;
  const inDrill = drillSlug !== null && !inSearch;
  const drillProvider = useMemo(
    () => (drillSlug ? providers.find((p) => p.slug === drillSlug) : null),
    [providers, drillSlug],
  );

  const searchMatches = useMemo<FlatMatch[]>(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const out: FlatMatch[] = [];
    for (const p of providers) {
      for (const m of p.models ?? []) {
        if (
          m.toLowerCase().includes(q) ||
          p.label.toLowerCase().includes(q) ||
          p.slug.toLowerCase().includes(q)
        ) {
          out.push({ modelId: m, providerSlug: p.slug, providerLabel: p.label });
        }
      }
    }
    return out;
  }, [providers, query]);

  function commit(modelId: string, providerSlug: string) {
    setOpen(false);
    onPick(modelId, providerSlug);
  }

  function clearLocal() {
    setOpen(false);
    onPick(null, null);
  }

  async function applyGlobal(modelId: string, providerSlug: string) {
    setPendingGlobal(true);
    setGlobalError(null);
    try {
      await gateway.switchModel({
        model: modelId,
        provider: providerSlug,
        scope: "global",
      });
      // Refresh provider data so `is_current` reflects the new default.
      await fetchProviders(true);
      await providersState.refresh();
      setOpen(false);
      onPick(modelId, providerSlug);
    } catch (err) {
      setGlobalError(err instanceof Error ? err.message : String(err));
    } finally {
      setPendingGlobal(false);
    }
  }

  // Keyboard navigation list.
  type NavItem =
    | { kind: "provider"; data: ProviderRecord }
    | { kind: "model"; modelId: string; providerSlug: string; providerLabel: string };

  const navList: NavItem[] = inSearch
    ? searchMatches.map((m) => ({ kind: "model" as const, ...m }))
    : inDrill && drillProvider
      ? (drillProvider.models ?? []).map((m) => ({
          kind: "model" as const,
          modelId: m,
          providerSlug: drillProvider.slug,
          providerLabel: drillProvider.label,
        }))
      : providers.map((p) => ({ kind: "provider" as const, data: p }));

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
      if (item.kind === "provider") {
        setDrillSlug(item.data.slug);
        setActive(0);
      } else {
        commit(item.modelId, item.providerSlug);
      }
      return;
    }
    if (e.key === "ArrowLeft" && inDrill && !query) {
      e.preventDefault();
      setDrillSlug(null);
      setActive(0);
    }
  }

  // Active model id is either the chat-local override (`value`) or the
  // gateway default if no override is set.
  const activeModelId = value ?? currentModel;

  return (
    <div className="model-selector" ref={wrapRef}>
      <button
        ref={pillRef}
        type="button"
        className="model-pill"
        onClick={() => !disabled && setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-disabled={disabled}
        disabled={disabled}
        data-testid="model-pill"
        title={value ?? `Using gateway default (${currentModel || "none"})`}
      >
        <span className="model-pill-label">
          {pillLabel(value, providers, currentProvider, currentModel)}
        </span>
        <span className="model-pill-caret" aria-hidden="true">▾</span>
      </button>

      {open && typeof document !== "undefined"
        ? createPortal(
            <div
              ref={popRef}
              className="model-popover portalled"
              role="listbox"
              data-testid="model-popover"
              style={popoverStyle(anchorRect)}
            >
              <div className="model-head">
                {inDrill && drillProvider ? (
                  <button
                    type="button"
                    className="model-back"
                    onClick={() => {
                      setDrillSlug(null);
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
                    inDrill && drillProvider
                      ? `Search ${drillProvider.label}…`
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

              {providersState.status === "loading" && providers.length === 0 ? (
                <div className="model-loading">…loading providers</div>
              ) : null}

              {providersState.status === "error" ? (
                <div className="model-error" data-testid="model-error">
                  gateway error: {providersState.error}
                </div>
              ) : null}

              <div className="model-list">
                {inSearch ? (
                  searchMatches.length === 0 ? (
                    <div className="model-empty">no matches</div>
                  ) : (
                    searchMatches.map((m, i) => (
                      <button
                        key={`${m.providerSlug}/${m.modelId}`}
                        type="button"
                        role="option"
                        aria-selected={i === active}
                        className={`model-item ${i === active ? "active" : ""} ${
                          m.modelId === activeModelId ? "current" : ""
                        }`}
                        onClick={() => commit(m.modelId, m.providerSlug)}
                        onMouseEnter={() => setActive(i)}
                        data-testid={`model-item-${m.modelId}`}
                      >
                        <div className="model-item-main">
                          <span className="model-item-label">{m.modelId}</span>
                          <span className="model-item-provider">
                            {m.providerLabel}
                          </span>
                        </div>
                      </button>
                    ))
                  )
                ) : inDrill && drillProvider ? (
                  (drillProvider.models ?? []).length === 0 ? (
                    <div className="model-empty">no models reported</div>
                  ) : (
                    (drillProvider.models ?? []).map((m, i) => (
                      <button
                        key={m}
                        type="button"
                        role="option"
                        aria-selected={i === active}
                        className={`model-item ${i === active ? "active" : ""} ${
                          m === activeModelId ? "current" : ""
                        }`}
                        onClick={() => commit(m, drillProvider.slug)}
                        onMouseEnter={() => setActive(i)}
                        data-testid={`model-item-${m}`}
                      >
                        <span className="model-item-label">{m}</span>
                        {drillProvider.is_current && m === currentModel ? (
                          <span className="model-item-tag">default</span>
                        ) : null}
                      </button>
                    ))
                  )
                ) : providers.length === 0 && providersState.status === "ready" ? (
                  <div className="model-empty">no providers configured</div>
                ) : (
                  providers.map((p, i) => (
                    <button
                      key={p.slug}
                      type="button"
                      role="option"
                      aria-selected={i === active}
                      className={`model-provider-item ${
                        i === active ? "active" : ""
                      } ${p.is_current ? "current" : ""}`}
                      onClick={() => {
                        setDrillSlug(p.slug);
                        setActive(0);
                      }}
                      onMouseEnter={() => setActive(i)}
                      data-testid={`model-provider-${p.slug}`}
                    >
                      <span className="model-provider-name">{p.label}</span>
                      <span className="model-provider-meta">
                        {p.is_current ? (
                          <span className="model-provider-current">default</span>
                        ) : null}
                        {p.total_models} model{p.total_models === 1 ? "" : "s"}
                        <span className="model-provider-caret">›</span>
                      </span>
                    </button>
                  ))
                )}
              </div>

              <div className="model-foot">
                {value && providers.length > 0 ? (
                  (() => {
                    const owner = providers.find((p) =>
                      (p.models ?? []).includes(value),
                    );
                    if (!owner) return null;
                    return (
                      <button
                        type="button"
                        className="model-foot-btn"
                        disabled={pendingGlobal}
                        onClick={() => applyGlobal(value, owner.slug)}
                        data-testid="model-set-global"
                      >
                        {pendingGlobal ? "saving…" : "Set as default globally"}
                      </button>
                    );
                  })()
                ) : null}
                {value ? (
                  <button
                    type="button"
                    className="model-foot-btn"
                    onClick={clearLocal}
                    data-testid="model-clear"
                  >
                    Use gateway default
                  </button>
                ) : null}
                {globalError ? (
                  <div className="model-foot-error" data-testid="model-foot-error">
                    {globalError}
                  </div>
                ) : null}
              </div>
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}

/**
 * Inline style for the portalled popover. Anchors the popover beneath
 * the pill on every viewport size — `right` aligned to the pill's right
 * edge so the popover hugs the same column. If there's not enough room
 * below, flip above.
 */
function popoverStyle(rect: DOMRect | null): React.CSSProperties {
  if (!rect) return { visibility: "hidden" };
  if (typeof window === "undefined") return {};
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const margin = 8;
  const popoverWidth = Math.min(360, vw - margin * 2);
  const idealTop = rect.bottom + 4;
  const maxHeight = Math.min(420, vh - idealTop - margin);
  // If less than 220px below, flip above
  const flip = maxHeight < 220 && rect.top > 240;
  const top = flip ? Math.max(margin, rect.top - 4) : idealTop;
  const transform = flip ? "translateY(-100%)" : undefined;
  // Right-align to pill's right edge, but never go off-screen left
  const right = Math.max(margin, vw - rect.right);
  return {
    position: "fixed",
    top,
    right,
    width: popoverWidth,
    maxHeight: flip ? Math.min(420, rect.top - margin) : maxHeight,
    transform,
  };
}
