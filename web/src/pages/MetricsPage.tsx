/**
 * Metrics dashboard — Phase 6.G.
 *
 * Reads /api/metrics/usage and renders three sections:
 *
 *   1. Headline KPIs — total messages, total tokens, estimated USD.
 *   2. Per-model breakdown — sortable table (highest cost first).
 *   3. Per-chat breakdown — top 20 by cost.
 *   4. Daily mini-chart — bar series scaled to the 30-day window so
 *      spikes stand out visually without bringing in a chart library.
 *
 * Empty state: when nothing has been recorded yet, we explain that
 * usage is captured per assistant message and that older chats may
 * not have any (rows pre-Phase 5 lacked the metadata column).
 *
 * Pricing transparency: when `pricelessRows > 0` we surface a hint
 * that some models aren't in the cost catalog so the totals are
 * conservative (lower bound). The user can grep MODEL_PRICES to add
 * their own.
 */
import { useEffect, useState } from "react";
import { useLocation } from "wouter";
import { metrics as metricsApi, type UsageSummaryDto } from "../lib/api";

function fmtUsd(n: number): string {
  if (n === 0) return "$0.00";
  if (n < 0.01) return "<$0.01";
  if (n < 1) return `$${n.toFixed(3)}`;
  if (n < 100) return `$${n.toFixed(2)}`;
  return `$${Math.round(n).toLocaleString()}`;
}

function fmtTokens(n: number): string {
  if (n < 1_000) return n.toString();
  if (n < 1_000_000) return `${(n / 1_000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

export function MetricsPage() {
  const [, setLocation] = useLocation();
  const [data, setData] = useState<UsageSummaryDto | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const r = await metricsApi.usage();
        if (!cancelled) setData(r);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Compute the maximum daily cost so the bar widths scale the right way.
  const maxDayUsd =
    data && data.byDay.length > 0 ? Math.max(...data.byDay.map((d) => d.estUsd), 0.0001) : 0;

  return (
    <main className="container" data-testid="metrics-page">
      <div className="topbar">
        <div className="tag">— metrics</div>
        <div className="topbar-right">
          <button className="btn-text" onClick={() => setLocation("/chat")} type="button">
            back
          </button>
        </div>
      </div>

      <h1>Usage &amp; cost.</h1>
      <p className="lead">
        Token consumption and estimated dollar cost across every assistant
        turn in your local chat log. Estimates use a built-in price catalog;
        models outside the catalog are counted as $0.
      </p>

      {error && (
        <div className="error-box">
          <div className="tag">— error</div>
          <p>{error}</p>
        </div>
      )}

      {!data ? (
        <div className="probe-loading">…loading metrics</div>
      ) : data.totals.messages === 0 ? (
        <section data-testid="metrics-empty">
          <p className="section-sub">
            No metered messages yet. Each assistant turn records its
            <code>usage</code> block on completion; chats started before that
            instrumentation existed contribute nothing here.
          </p>
        </section>
      ) : (
        <>
          <section className="kv-table" data-testid="metrics-totals">
            <div className="kv-row">
              <span className="kv-key">messages</span>
              <span className="kv-val">{data.totals.messages.toLocaleString()}</span>
            </div>
            <div className="kv-row">
              <span className="kv-key">prompt tokens</span>
              <span className="kv-val">{fmtTokens(data.totals.promptTokens)}</span>
            </div>
            <div className="kv-row">
              <span className="kv-key">completion tokens</span>
              <span className="kv-val">{fmtTokens(data.totals.completionTokens)}</span>
            </div>
            <div className="kv-row">
              <span className="kv-key">est. usd</span>
              <span className="kv-val" data-testid="metrics-total-usd">
                {fmtUsd(data.totals.estUsd)}
              </span>
            </div>
          </section>

          {data.totals.pricelessRows > 0 && (
            <p className="section-sub" data-testid="metrics-priceless-warning">
              {data.totals.pricelessRows} message
              {data.totals.pricelessRows === 1 ? "" : "s"} from
              models not in the price catalog — actual cost is higher than the
              estimate above. Add the model to{" "}
              <code>src/server/lib/cost.ts</code> to fix.
            </p>
          )}

          {data.byModel.length > 0 && (
            <section data-testid="metrics-by-model">
              <h2 className="section-h">By model</h2>
              <ul className="cap-list">
                {data.byModel.map((m) => (
                  <li
                    key={m.model}
                    className="cap-row"
                    data-testid={`model-row-${m.model}`}
                  >
                    <div className="cap-main">
                      <div className="cap-title">{m.model}</div>
                      <div className="cap-sub">
                        {m.messages.toLocaleString()} msgs ·{" "}
                        {fmtTokens(m.promptTokens)} in / {fmtTokens(m.completionTokens)} out
                      </div>
                    </div>
                    <div className="cap-right">
                      <span className="cap-badge">{fmtUsd(m.estUsd)}</span>
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {data.byChat.length > 0 && (
            <section data-testid="metrics-by-chat">
              <h2 className="section-h">Top chats</h2>
              <ul className="cap-list">
                {data.byChat.map((c) => (
                  <li
                    key={c.chatId}
                    className="cap-row"
                    data-testid={`chat-row-${c.chatId}`}
                  >
                    <div className="cap-main">
                      <div className="cap-title">{c.title || "(untitled)"}</div>
                      <div className="cap-sub">
                        {c.model ?? "(no model)"} · {c.messages} msgs ·{" "}
                        {fmtTokens(c.promptTokens + c.completionTokens)} tokens
                      </div>
                    </div>
                    <div className="cap-right">
                      <span className="cap-badge">{fmtUsd(c.estUsd)}</span>
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {data.byDay.length > 0 && (
            <section data-testid="metrics-by-day">
              <h2 className="section-h">Last 30 days</h2>
              <div className="metrics-bars" role="list">
                {data.byDay.map((d) => {
                  const pct = Math.max(2, Math.round((d.estUsd / maxDayUsd) * 100));
                  return (
                    <div
                      key={d.date}
                      className="metrics-bar-row"
                      role="listitem"
                      data-testid={`day-row-${d.date}`}
                    >
                      <span className="metrics-bar-date">{d.date.slice(5)}</span>
                      <div className="metrics-bar-track">
                        <div
                          className="metrics-bar-fill"
                          style={{ width: `${pct}%` }}
                        />
                      </div>
                      <span className="metrics-bar-val">{fmtUsd(d.estUsd)}</span>
                    </div>
                  );
                })}
              </div>
            </section>
          )}
        </>
      )}
    </main>
  );
}
