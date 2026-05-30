import { useEffect, useState } from "react";

interface Health {
  status: string;
  service: string;
  version: string;
  time: string;
}

export function App() {
  const [health, setHealth] = useState<Health | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/health")
      .then((r) => r.json() as Promise<Health>)
      .then(setHealth)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  return (
    <main className="container">
      <div className="tag">— hermes-van</div>
      <h1>
        Cliente web para Hermes Agent.
        <br />
        <span className="accent">Phase 1 — server skeleton montado.</span>
      </h1>
      <p className="lead">
        Backend Hono respondiendo en <code>/api/health</code>. Auth, DB, chat y
        multi-sesión llegan en milestones siguientes.
      </p>

      <section className="probe">
        <div className="probe-label">— health probe</div>
        {error ? (
          <pre className="probe-err">error: {error}</pre>
        ) : health ? (
          <pre className="probe-ok">{JSON.stringify(health, null, 2)}</pre>
        ) : (
          <div className="probe-loading">…probing</div>
        )}
      </section>
    </main>
  );
}
