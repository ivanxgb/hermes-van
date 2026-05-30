/**
 * Jobs page — read-only browser of cron jobs configured on the gateway.
 *
 * Phase 4.E. CRUD lives in the Hermes CLI / config; this page is a
 * window into "what's scheduled" so you don't have to ssh into the box
 * to see why notifications keep arriving.
 */
import { useEffect, useMemo, useState } from "react";
import { useLocation } from "wouter";
import { gateway, type JobRecord } from "../lib/api";

interface State {
  status: "loading" | "ready" | "error";
  jobs: JobRecord[];
  error: string | null;
}

function fmtTime(s: string | null | undefined): string {
  if (!s) return "—";
  try {
    return new Date(s).toLocaleString();
  } catch {
    return s;
  }
}

export function JobsPage() {
  const [, setLocation] = useLocation();
  const [filter, setFilter] = useState("");
  const [state, setState] = useState<State>({ status: "loading", jobs: [], error: null });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await gateway.jobs();
        if (cancelled) return;
        setState({ status: "ready", jobs: res.jobs ?? [], error: null });
      } catch (err) {
        if (cancelled) return;
        setState({
          status: "error",
          jobs: [],
          error: err instanceof Error ? err.message : String(err),
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return state.jobs;
    return state.jobs.filter(
      (j) =>
        j.id.toLowerCase().includes(q) ||
        (j.name ?? "").toLowerCase().includes(q) ||
        (j.prompt_preview ?? "").toLowerCase().includes(q),
    );
  }, [state.jobs, filter]);

  return (
    <main className="container" data-testid="jobs-page">
      <div className="topbar">
        <div className="tag">— jobs</div>
        <div className="topbar-right">
          <button className="btn-text" onClick={() => setLocation("/chat")} type="button">
            back
          </button>
        </div>
      </div>

      <h1>Jobs.</h1>
      <p className="lead">
        Cron jobs scheduled on the gateway. Read-only — manage from the CLI.
      </p>

      <input
        className="cap-filter"
        type="search"
        placeholder="filter by id, name, or prompt…"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        data-testid="jobs-filter"
      />

      {state.status === "loading" && <div className="probe-loading">…loading jobs</div>}
      {state.status === "error" && (
        <div className="error-box" data-testid="jobs-error">
          <div className="tag">— gateway error</div>
          <p>{state.error}</p>
        </div>
      )}
      {state.status === "ready" && (
        <section data-testid="jobs-list">
          {filtered.length === 0 && <p className="empty">No jobs match.</p>}
          <ul className="cap-list">
            {filtered.map((j) => (
              <li key={j.id} className={`cap-item ${j.enabled ? "enabled" : "disabled"}`}>
                <div className="cap-row">
                  <span className="cap-name">{j.name ?? j.id}</span>
                  <span className={`cap-badge ${j.enabled ? "on" : "off"}`}>
                    {j.state ?? (j.enabled ? "enabled" : "disabled")}
                  </span>
                </div>
                {j.prompt_preview && <div className="cap-desc">{j.prompt_preview}…</div>}
                <div className="job-meta">
                  <span>
                    <strong>schedule:</strong> {j.schedule_display ?? "—"}
                  </span>
                  <span>
                    <strong>next:</strong> {fmtTime(j.next_run_at)}
                  </span>
                  <span>
                    <strong>last:</strong> {fmtTime(j.last_run_at)}
                    {j.last_status ? ` (${j.last_status})` : ""}
                  </span>
                  {j.deliver && (
                    <span>
                      <strong>deliver:</strong> {j.deliver}
                    </span>
                  )}
                </div>
                {j.enabled_toolsets && j.enabled_toolsets.length > 0 && (
                  <div className="cap-tools">
                    {j.enabled_toolsets.map((t) => (
                      <code key={t} className="cap-tool">
                        {t}
                      </code>
                    ))}
                  </div>
                )}
                {j.last_error && (
                  <div className="job-error">
                    <strong>last error:</strong> {j.last_error}
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
