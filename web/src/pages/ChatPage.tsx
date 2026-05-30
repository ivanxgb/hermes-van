/**
 * Phase 1 chat placeholder. Phase 2 fills this in.
 */
import { useEffect, useState } from "react";
import { useLocation } from "wouter";
import { sys, type HealthResponse } from "../lib/api";
import { useAuth, logout } from "../lib/auth-store";

export function ChatPage() {
  const [, setLocation] = useLocation();
  const auth = useAuth();
  const [health, setHealth] = useState<HealthResponse | null>(null);

  useEffect(() => {
    void sys.health().then(setHealth);
  }, []);

  async function onLogout() {
    await logout();
    setLocation("/login");
  }

  return (
    <main className="container">
      <div className="topbar">
        <div className="tag">— chat</div>
        <div className="topbar-right">
          <span className="username">{auth.user?.username}</span>
          <button className="btn-text" onClick={() => setLocation("/settings")} type="button">
            settings
          </button>
          <button className="btn-text" onClick={onLogout} type="button">
            logout
          </button>
        </div>
      </div>

      <h1>
        Authenticated. <span className="accent">Phase 2 lights up here.</span>
      </h1>
      <p className="lead">
        Single-chat MVP, multi-tab streams, slash commands, gateway proxy
        come next. For now, this page just verifies the auth session
        round-trips and the gateway is reachable.
      </p>

      <section className="probe">
        <div className="probe-label">— gateway probe</div>
        {health ? (
          <pre className={health.gateway.ok ? "probe-ok" : "probe-err"}>
            {JSON.stringify(health, null, 2)}
          </pre>
        ) : (
          <div className="probe-loading">…probing</div>
        )}
      </section>
    </main>
  );
}
