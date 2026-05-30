/**
 * Settings page. Phase 1: show user info, allow logout-all.
 * Phase 3 expands to credential management, audit viewer.
 */
import { useLocation } from "wouter";
import { auth as api } from "../lib/api";
import { logout, useAuth } from "../lib/auth-store";

export function SettingsPage() {
  const [, setLocation] = useLocation();
  const auth = useAuth();

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
      <p className="lead">Identity and session controls.</p>

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
