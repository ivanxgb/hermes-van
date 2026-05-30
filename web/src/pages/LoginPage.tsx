/**
 * Login page. Two flows: passkey (default) or recovery code (fallback).
 */
import { useState } from "react";
import { useLocation } from "wouter";
import { startAuthentication, type WebAuthnAuthenticationOptions } from "../lib/webauthn-types";
import { auth } from "../lib/api";
import { refresh } from "../lib/auth-store";

type Mode = "passkey" | "recovery";

export function LoginPage() {
  const [, setLocation] = useLocation();
  const [mode, setMode] = useState<Mode>("passkey");
  const [username, setUsername] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onPasskey(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const opts = await auth.loginOptions({ username: username.trim() });
      const response = await startAuthentication({
        optionsJSON: opts.options as WebAuthnAuthenticationOptions,
      });
      await auth.loginVerify({ username: username.trim(), response });
      await refresh();
      setLocation("/chat");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Login failed");
    } finally {
      setBusy(false);
    }
  }

  async function onRecovery(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await auth.recovery({ username: username.trim(), code: code.trim() });
      await refresh();
      setLocation("/chat");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Recovery failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="container">
      <div className="tag">— login</div>
      <h1>
        Welcome back. <span className="accent">Tap your passkey.</span>
      </h1>

      <div className="tabs">
        <button
          className={`tab ${mode === "passkey" ? "active" : ""}`}
          onClick={() => setMode("passkey")}
          type="button"
        >
          Passkey
        </button>
        <button
          className={`tab ${mode === "recovery" ? "active" : ""}`}
          onClick={() => setMode("recovery")}
          type="button"
        >
          Recovery code
        </button>
      </div>

      {mode === "passkey" ? (
        <form className="form" onSubmit={onPasskey}>
          <label className="field">
            <span className="field-label">Username</span>
            <input
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              required
              autoComplete="username webauthn"
            />
          </label>
          {error ? <div className="error">{error}</div> : null}
          <button className="btn-primary" type="submit" disabled={busy}>
            {busy ? "Authenticating…" : "Sign in with passkey"}
          </button>
        </form>
      ) : (
        <form className="form" onSubmit={onRecovery}>
          <label className="field">
            <span className="field-label">Username</span>
            <input
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              required
              autoComplete="username"
            />
          </label>
          <label className="field">
            <span className="field-label">Recovery code</span>
            <input
              type="text"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              required
              autoComplete="off"
              placeholder="ABCDE-FGHIJ-KLMNP-QRSTU-VWXYZ"
            />
          </label>
          {error ? <div className="error">{error}</div> : null}
          <button className="btn-primary" type="submit" disabled={busy}>
            {busy ? "Verifying…" : "Sign in with recovery code"}
          </button>
        </form>
      )}
    </main>
  );
}
