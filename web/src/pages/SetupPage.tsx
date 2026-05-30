/**
 * Setup page. Consumes a one-time bootstrap token to register the first
 * user (or any subsequent user, depending on how setup tokens are issued).
 *
 * Flow:
 *   1. user pastes setup token + chooses username + display name
 *   2. POST /auth/setup/options → server returns WebAuthn options + pendingUserId
 *   3. browser invokes navigator.credentials.create(options) (handled by simplewebauthn)
 *   4. POST /auth/setup/verify with the registration response
 *   5. server creates user, persists credential, issues 10 recovery codes,
 *      auto-logs in. We display recovery codes — only chance to copy them.
 */
import { useState } from "react";
import { useLocation } from "wouter";
import { startRegistration, type WebAuthnRegistrationOptions } from "../lib/webauthn-types";
import { auth } from "../lib/api";
import { refresh } from "../lib/auth-store";

type Stage = "form" | "waiting-passkey" | "showing-codes";

export function SetupPage() {
  const [, setLocation] = useLocation();
  const [stage, setStage] = useState<Stage>("form");
  const [error, setError] = useState<string | null>(null);
  const [setupToken, setSetupToken] = useState("");
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [recoveryCodes, setRecoveryCodes] = useState<string[]>([]);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setStage("waiting-passkey");
    try {
      const opts = await auth.setupOptions({
        setupToken: setupToken.trim(),
        username: username.trim(),
        displayName: displayName.trim(),
      });
      // simplewebauthn handles base64url encoding and the credential dance
      const response = await startRegistration({
        optionsJSON: opts.options as WebAuthnRegistrationOptions,
      });
      const result = await auth.setupVerify({
        setupToken: setupToken.trim(),
        username: username.trim(),
        displayName: displayName.trim(),
        response,
      });
      setRecoveryCodes(result.recoveryCodes);
      setStage("showing-codes");
      void refresh();
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Setup failed";
      setError(msg);
      setStage("form");
    }
  }

  function onContinue() {
    setLocation("/chat");
  }

  if (stage === "showing-codes") {
    return (
      <main className="container">
        <div className="tag">— setup · recovery codes</div>
        <h1>
          Save these. <span className="accent">Now.</span>
        </h1>
        <p className="lead">
          These codes let you log back in if you lose every passkey. Each one works
          exactly once. We will never show them again. Store them in a password
          manager.
        </p>
        <pre className="codes">{recoveryCodes.join("\n")}</pre>
        <div className="actions">
          <button
            className="btn-secondary"
            onClick={() => navigator.clipboard.writeText(recoveryCodes.join("\n"))}
            type="button"
          >
            Copy
          </button>
          <button className="btn-primary" onClick={onContinue} type="button">
            I saved them, continue
          </button>
        </div>
      </main>
    );
  }

  return (
    <main className="container">
      <div className="tag">— setup</div>
      <h1>Register your first passkey.</h1>
      <p className="lead">
        Paste the setup token printed by <code>pnpm hermes-van:bootstrap</code>,
        pick a username, and confirm with your device. No password.
      </p>

      <form className="form" onSubmit={onSubmit}>
        <label className="field">
          <span className="field-label">Setup token</span>
          <input
            type="password"
            value={setupToken}
            onChange={(e) => setSetupToken(e.target.value)}
            required
            autoComplete="off"
            placeholder="(printed by bootstrap CLI)"
          />
        </label>
        <label className="field">
          <span className="field-label">Username</span>
          <input
            type="text"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            required
            pattern="[a-zA-Z0-9_-]+"
            minLength={2}
            maxLength={64}
            placeholder="ivan"
            autoComplete="username"
          />
        </label>
        <label className="field">
          <span className="field-label">Display name</span>
          <input
            type="text"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            required
            minLength={1}
            maxLength={128}
            placeholder="Ivan"
          />
        </label>

        {error ? <div className="error">{error}</div> : null}

        <button
          className="btn-primary"
          type="submit"
          disabled={stage === "waiting-passkey"}
        >
          {stage === "waiting-passkey" ? "Waiting for passkey…" : "Register passkey"}
        </button>
      </form>
    </main>
  );
}
