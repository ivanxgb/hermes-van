/**
 * Settings page — identity, active sessions, audit log, danger zone.
 *
 * Phase 5.B adds:
 *   - Active session list with per-session revoke (no need to nuke everything)
 *   - Recent audit log so the user can see "who logged in / what was revoked"
 *
 * Both are scoped to the authed user via /auth/sessions and /auth/audit.
 * Revoking the current session also clears cookies and bounces to login.
 */
import { useEffect, useState } from "react";
import { useLocation } from "wouter";
import { auth as api, type WebSessionRecord, type AuditRecord } from "../lib/api";
import { logout, useAuth } from "../lib/auth-store";

function fmtRelative(ts: number | null | undefined): string {
  if (!ts) return "—";
  const diff = Date.now() - ts;
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

function fmtAbsolute(ts: number | null | undefined): string {
  if (!ts) return "—";
  return new Date(ts).toLocaleString();
}

function shortenUA(ua: string | null): string {
  if (!ua) return "unknown";
  // Pull out the most useful chunk: the last "Browser/Version" pair
  const m = ua.match(/(Chrome|Firefox|Safari|Edge|HeadlessChrome)\/[\d.]+/);
  return m ? m[0] : ua.slice(0, 60);
}

export function SettingsPage() {
  const [, setLocation] = useLocation();
  const auth = useAuth();
  const [sessions, setSessions] = useState<WebSessionRecord[] | null>(null);
  const [events, setEvents] = useState<AuditRecord[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  async function refresh() {
    try {
      const [sRes, aRes] = await Promise.all([api.sessions(), api.audit(50)]);
      setSessions(sRes.sessions);
      setEvents(aRes.events);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load");
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  async function onLogoutAll() {
    if (!confirm("Revoke ALL active sessions? You'll be signed out everywhere.")) return;
    try {
      await api.logoutAll();
    } catch {
      // ignore — server-side may have already done partial revoke
    }
    await logout();
    setLocation("/login");
  }

  async function onRevokeOne(s: WebSessionRecord) {
    if (s.revokedAt !== null) return;
    const label = s.isCurrent ? "this device (you'll be signed out)" : "this session";
    if (!confirm(`Revoke ${label}?`)) return;
    setBusy(s.id);
    try {
      await api.revokeSession(s.id);
      if (s.isCurrent) {
        await logout();
        setLocation("/login");
        return;
      }
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Revoke failed");
    } finally {
      setBusy(null);
    }
  }

  return (
    <main className="container">
      <div className="topbar">
        <div className="tag">— settings</div>
        <div className="topbar-right">
          <button className="btn-text" onClick={() => setLocation("/chat")} type="button">
            back
          </button>
        </div>
      </div>

      <h1>Settings.</h1>
      <p className="lead">Identity, sessions, and audit log.</p>

      <section className="kv-table">
        <div className="kv-row">
          <span className="kv-key">user id</span>
          <span className="kv-val">{auth.user?.userId ?? "—"}</span>
        </div>
        <div className="kv-row">
          <span className="kv-key">username</span>
          <span className="kv-val">{auth.user?.username ?? "—"}</span>
        </div>
        <div className="kv-row">
          <span className="kv-key">session id</span>
          <span className="kv-val">{auth.user?.sessionId ?? "—"}</span>
        </div>
        <div className="kv-row">
          <span className="kv-key">webauthn rp id</span>
          <span className="kv-val">{auth.user?.rpId ?? "—"}</span>
        </div>
      </section>

      {error && (
        <div className="error-box" data-testid="settings-error">
          <div className="tag">— error</div>
          <p>{error}</p>
        </div>
      )}

      <section data-testid="sessions-section">
        <h2 className="section-h">Active sessions</h2>
        <p className="section-sub">
          Every device that has signed in. Revoke any you don't recognize.
        </p>
        {sessions === null ? (
          <div className="probe-loading">…loading sessions</div>
        ) : sessions.length === 0 ? (
          <p className="empty">no sessions</p>
        ) : (
          <ul className="cap-list" data-testid="sessions-list">
            {sessions.map((s) => {
              const revoked = s.revokedAt !== null;
              return (
                <li
                  key={s.id}
                  className={`cap-item ${revoked ? "disabled" : "enabled"}`}
                  data-testid={`session-row-${s.id}`}
                >
                  <div className="cap-row">
                    <span className="cap-name">
                      {shortenUA(s.userAgent)}
                      {s.isCurrent && (
                        <span className="cap-badge on" style={{ marginLeft: 8 }}>
                          this device
                        </span>
                      )}
                      {revoked && (
                        <span className="cap-badge off" style={{ marginLeft: 8 }}>
                          revoked
                        </span>
                      )}
                    </span>
                    {!revoked && (
                      <button
                        type="button"
                        className="btn-text"
                        onClick={() => void onRevokeOne(s)}
                        disabled={busy === s.id}
                        data-testid={`revoke-${s.id}`}
                      >
                        {busy === s.id ? "…" : "revoke"}
                      </button>
                    )}
                  </div>
                  <div className="job-meta">
                    <span>
                      <strong>ip:</strong> {s.ip ?? "—"}
                    </span>
                    <span>
                      <strong>started:</strong> {fmtAbsolute(s.createdAt)}
                    </span>
                    <span>
                      <strong>last seen:</strong> {fmtRelative(s.lastSeenAt)}
                    </span>
                    <span>
                      <strong>expires:</strong> {fmtAbsolute(s.expiresAt)}
                    </span>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section data-testid="audit-section">
        <h2 className="section-h">Audit log</h2>
        <p className="section-sub">Last 50 events on your account.</p>
        {events === null ? (
          <div className="probe-loading">…loading audit</div>
        ) : events.length === 0 ? (
          <p className="empty">no events</p>
        ) : (
          <ul className="audit-list" data-testid="audit-list">
            {events.map((e) => (
              <li key={e.id} className="audit-row">
                <span className="audit-event">{e.event}</span>
                <span className="audit-when">{fmtRelative(e.ts)}</span>
                <span className="audit-ip">{e.ip ?? "—"}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="danger-zone">
        <div className="danger-label">— danger zone</div>
        <p className="danger-desc">
          Revoking all sessions logs you out of every device with an active
          session. You will need to re-authenticate with a passkey or
          recovery code.
        </p>
        <button className="btn-danger" onClick={onLogoutAll} type="button">
          Revoke all sessions
        </button>
      </section>
    </main>
  );
}
