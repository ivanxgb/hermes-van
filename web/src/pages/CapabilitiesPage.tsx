/**
 * Capabilities browser — read-only view of gateway skills and toolsets.
 *
 * Phase 4.D — replaces the original "switch model" plan because the gateway
 * exposes only a single model. What's actually variable on the gateway is
 * which skills are loaded and which toolsets are enabled, so we surface
 * those instead. Pure browser; no edits, no enable/disable buttons (those
 * live in the gateway config). The page proves the capability proxy works
 * end-to-end and gives users visibility into what their agent can do.
 */
import { useEffect, useMemo, useState } from "react";
import { useLocation } from "wouter";
import { gateway, type SkillRecord, type ToolsetRecord } from "../lib/api";

type Tab = "skills" | "toolsets";

interface State {
  status: "loading" | "ready" | "error";
  skills: SkillRecord[];
  toolsets: ToolsetRecord[];
  error: string | null;
}

export function CapabilitiesPage() {
  const [, setLocation] = useLocation();
  const [tab, setTab] = useState<Tab>("skills");
  const [filter, setFilter] = useState("");
  const [state, setState] = useState<State>({
    status: "loading",
    skills: [],
    toolsets: [],
    error: null,
  });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [skillsRes, toolsetsRes] = await Promise.all([
          gateway.skills(),
          gateway.toolsets(),
        ]);
        if (cancelled) return;
        setState({
          status: "ready",
          skills: skillsRes.skills ?? [],
          toolsets: toolsetsRes.toolsets ?? [],
          error: null,
        });
      } catch (err) {
        if (cancelled) return;
        setState({
          status: "error",
          skills: [],
          toolsets: [],
          error: err instanceof Error ? err.message : String(err),
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const skillsByCategory = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const filtered = q
      ? state.skills.filter(
          (s) =>
            s.name.toLowerCase().includes(q) ||
            (s.description ?? "").toLowerCase().includes(q),
        )
      : state.skills;
    const groups = new Map<string, SkillRecord[]>();
    for (const s of filtered) {
      const cat = s.category ?? "uncategorized";
      const arr = groups.get(cat) ?? [];
      arr.push(s);
      groups.set(cat, arr);
    }
    return Array.from(groups.entries()).sort(([a], [b]) => a.localeCompare(b));
  }, [state.skills, filter]);

  const filteredToolsets = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return state.toolsets;
    return state.toolsets.filter(
      (t) =>
        t.name.toLowerCase().includes(q) ||
        (t.label ?? "").toLowerCase().includes(q) ||
        (t.tools ?? []).some((tn) => tn.toLowerCase().includes(q)),
    );
  }, [state.toolsets, filter]);

  return (
    <main className="container" data-testid="capabilities-page">
      <div className="topbar">
        <div className="tag">— capabilities</div>
        <div className="topbar-right">
          <button className="btn-text" onClick={() => setLocation("/chat")} type="button">
            back
          </button>
        </div>
      </div>

      <h1>Capabilities.</h1>
      <p className="lead">What the agent on the other end of this connection can do.</p>

      <div className="cap-tabs" role="tablist">
        <button
          className={`cap-tab ${tab === "skills" ? "active" : ""}`}
          onClick={() => setTab("skills")}
          role="tab"
          aria-selected={tab === "skills"}
          type="button"
          data-testid="cap-tab-skills"
        >
          Skills{state.status === "ready" ? ` (${state.skills.length})` : ""}
        </button>
        <button
          className={`cap-tab ${tab === "toolsets" ? "active" : ""}`}
          onClick={() => setTab("toolsets")}
          role="tab"
          aria-selected={tab === "toolsets"}
          type="button"
          data-testid="cap-tab-toolsets"
        >
          Toolsets{state.status === "ready" ? ` (${state.toolsets.length})` : ""}
        </button>
      </div>

      <input
        className="cap-filter"
        type="search"
        placeholder={tab === "skills" ? "filter skills…" : "filter toolsets or tools…"}
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        data-testid="cap-filter"
      />

      {state.status === "loading" && <div className="probe-loading">…loading capabilities</div>}

      {state.status === "error" && (
        <div className="error-box" data-testid="cap-error">
          <div className="tag">— gateway error</div>
          <p>{state.error}</p>
        </div>
      )}

      {state.status === "ready" && tab === "skills" && (
        <section data-testid="cap-skills-list">
          {skillsByCategory.length === 0 && (
            <p className="empty">No skills match the filter.</p>
          )}
          {skillsByCategory.map(([cat, items]) => (
            <div key={cat} className="cap-group">
              <div className="cap-group-title">{cat}</div>
              <ul className="cap-list">
                {items.map((s) => (
                  <li key={s.name} className="cap-item">
                    <div className="cap-name">{s.name}</div>
                    {s.description && <div className="cap-desc">{s.description}</div>}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </section>
      )}

      {state.status === "ready" && tab === "toolsets" && (
        <section data-testid="cap-toolsets-list">
          {filteredToolsets.length === 0 && (
            <p className="empty">No toolsets match the filter.</p>
          )}
          <ul className="cap-list">
            {filteredToolsets.map((t) => (
              <li key={t.name} className={`cap-item ${t.enabled ? "enabled" : "disabled"}`}>
                <div className="cap-row">
                  <span className="cap-name">{t.label ?? t.name}</span>
                  <span className={`cap-badge ${t.enabled ? "on" : "off"}`}>
                    {t.enabled ? "enabled" : "disabled"}
                  </span>
                </div>
                {t.description && <div className="cap-desc">{t.description}</div>}
                {t.tools && t.tools.length > 0 && (
                  <div className="cap-tools">
                    {t.tools.map((tool) => (
                      <code key={tool} className="cap-tool">
                        {tool}
                      </code>
                    ))}
                  </div>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
    </main>
  );
}
