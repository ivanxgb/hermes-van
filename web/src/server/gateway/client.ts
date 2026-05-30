/**
 * Thin client for the Hermes gateway's /v1/runs API.
 *
 * The gateway exposes a long-lived agent runtime; this module only owns
 * the wire protocol (auth header, JSON shapes, SSE parsing). Lifecycle
 * (persistence, scoping, message stitching) lives in routes/runs.ts.
 *
 * Endpoints used:
 *   POST /v1/runs                          → { run_id, status }
 *   GET  /v1/runs/{run_id}/events          → SSE stream
 *   POST /v1/runs/{run_id}/stop            → cancel
 *   POST /v1/runs/{run_id}/approval        → resolve approval
 */
import { loadEnv } from "../lib/env";
import { logger } from "../lib/logger";

interface CreateRunInput {
  input: string;
  sessionId: string;
  model?: string | null;
  conversationHistory?: Array<{ role: string; content: string }>;
}

interface CreateRunResponse {
  runId: string;
  status: string;
}

export class GatewayError extends Error {
  constructor(
    public readonly status: number,
    public readonly bodyText: string,
  ) {
    super(`Gateway returned ${status}: ${bodyText.slice(0, 200)}`);
  }
}

function authHeaders(): Record<string, string> {
  const env = loadEnv();
  return {
    Authorization: `Bearer ${env.HERMES_VAN_GATEWAY_KEY}`,
    "Content-Type": "application/json",
  };
}

/** POST /v1/runs — start a new agent run. */
export async function createRun(input: CreateRunInput): Promise<CreateRunResponse> {
  const env = loadEnv();
  const url = `${env.HERMES_VAN_GATEWAY_URL}/v1/runs`;
  const body: Record<string, unknown> = {
    input: input.input,
    session_id: input.sessionId,
  };
  if (input.model) body["model"] = input.model;
  if (input.conversationHistory && input.conversationHistory.length > 0) {
    body["conversation_history"] = input.conversationHistory;
  }

  const res = await fetch(url, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    logger.warn({ status: res.status, body: text.slice(0, 500) }, "gateway createRun failed");
    throw new GatewayError(res.status, text);
  }
  const parsed = JSON.parse(text) as { run_id?: string; status?: string };
  if (!parsed.run_id) throw new GatewayError(res.status, "missing run_id in gateway response");
  return { runId: parsed.run_id, status: parsed.status ?? "started" };
}

/** GET /v1/skills — list all skills available on the gateway. */
export async function listSkills(): Promise<Array<Record<string, unknown>>> {
  const env = loadEnv();
  const res = await fetch(`${env.HERMES_VAN_GATEWAY_URL}/v1/skills`, {
    method: "GET",
    headers: { Authorization: `Bearer ${env.HERMES_VAN_GATEWAY_KEY}` },
  });
  const text = await res.text();
  if (!res.ok) throw new GatewayError(res.status, text);
  const parsed = JSON.parse(text) as { data?: Array<Record<string, unknown>> };
  return parsed.data ?? [];
}

/** GET /v1/toolsets — list toolsets and which are enabled. */
export async function listToolsets(): Promise<Array<Record<string, unknown>>> {
  const env = loadEnv();
  const res = await fetch(`${env.HERMES_VAN_GATEWAY_URL}/v1/toolsets`, {
    method: "GET",
    headers: { Authorization: `Bearer ${env.HERMES_VAN_GATEWAY_KEY}` },
  });
  const text = await res.text();
  if (!res.ok) throw new GatewayError(res.status, text);
  const parsed = JSON.parse(text) as { data?: Array<Record<string, unknown>> };
  return parsed.data ?? [];
}

/** GET /api/jobs — list cron jobs. */
export async function listJobs(): Promise<Array<Record<string, unknown>>> {
  const env = loadEnv();
  const res = await fetch(`${env.HERMES_VAN_GATEWAY_URL}/api/jobs`, {
    method: "GET",
    headers: { Authorization: `Bearer ${env.HERMES_VAN_GATEWAY_KEY}` },
  });
  const text = await res.text();
  if (!res.ok) throw new GatewayError(res.status, text);
  const parsed = JSON.parse(text) as { jobs?: Array<Record<string, unknown>> };
  return parsed.jobs ?? [];
}

/** POST /api/sessions/{id}/fork — branch a session, returns new session info. */
export async function forkSession(
  upstreamSessionId: string,
): Promise<Record<string, unknown>> {
  const env = loadEnv();
  const res = await fetch(
    `${env.HERMES_VAN_GATEWAY_URL}/api/sessions/${upstreamSessionId}/fork`,
    {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({}),
    },
  );
  const text = await res.text();
  if (!res.ok) throw new GatewayError(res.status, text);
  const parsed = JSON.parse(text) as { session?: Record<string, unknown> };
  if (!parsed.session) throw new GatewayError(res.status, "missing session in fork response");
  return parsed.session;
}

/** POST /v1/runs/{run_id}/stop */
export async function stopRun(upstreamRunId: string): Promise<void> {
  const env = loadEnv();
  const res = await fetch(`${env.HERMES_VAN_GATEWAY_URL}/v1/runs/${upstreamRunId}/stop`, {
    method: "POST",
    headers: authHeaders(),
  });
  if (!res.ok && res.status !== 404) {
    const text = await res.text();
    throw new GatewayError(res.status, text);
  }
}

/** POST /v1/runs/{run_id}/approval */
export async function resolveApproval(
  upstreamRunId: string,
  choice: "once" | "session" | "always" | "deny",
): Promise<void> {
  const env = loadEnv();
  const res = await fetch(`${env.HERMES_VAN_GATEWAY_URL}/v1/runs/${upstreamRunId}/approval`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ choice }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new GatewayError(res.status, text);
  }
}

/**
 * Open the upstream SSE stream and yield parsed events.
 *
 * Returns an async iterable. The caller is responsible for handling
 * abort/cancellation via the provided AbortSignal — once the signal
 * fires, the stream closes and iteration ends.
 *
 * Each yielded value is the parsed JSON payload from one `data:` line.
 * Comment lines (`: keepalive`) are filtered out silently.
 */
export async function* streamRunEvents(
  upstreamRunId: string,
  signal: AbortSignal,
): AsyncGenerator<Record<string, unknown>, void, void> {
  const env = loadEnv();
  const url = `${env.HERMES_VAN_GATEWAY_URL}/v1/runs/${upstreamRunId}/events`;
  const res = await fetch(url, {
    method: "GET",
    headers: { Authorization: `Bearer ${env.HERMES_VAN_GATEWAY_KEY}` },
    signal,
  });
  if (!res.ok || !res.body) {
    const text = res.body ? await res.text() : "";
    throw new GatewayError(res.status, text);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";

  try {
    while (!signal.aborted) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      // SSE event boundary: blank line.
      let idx: number;
      while ((idx = buffer.indexOf("\n\n")) !== -1) {
        const rawEvent = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const dataLines = rawEvent
          .split("\n")
          .filter((l) => l.startsWith("data: "))
          .map((l) => l.slice(6));
        if (dataLines.length === 0) continue; // keepalive/comment
        try {
          yield JSON.parse(dataLines.join("\n")) as Record<string, unknown>;
        } catch (err) {
          logger.debug({ err, raw: dataLines.join("\n") }, "skipped malformed SSE event");
        }
      }
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // ignore
    }
  }
}
