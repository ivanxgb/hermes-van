/**
 * Run routes — bridge between hermes-van and the gateway's /v1/runs API.
 *
 * Start mounted under /api on the parent app:
 *   POST /api/chats/:id/runs           start a run for a chat
 *   GET  /api/runs/:runId/events       SSE proxy of run events
 *   POST /api/runs/:runId/stop         cancel a run
 *   POST /api/runs/:runId/approval     resolve a tool approval
 *
 * Capability isolation: the client never sees the upstream gateway run id.
 * It only ever handles the local ULID stored in active_runs.id.
 *
 * Streaming model:
 *   The browser opens an EventSource to /api/runs/:id/events. The server
 *   spawns a fetch against the upstream SSE endpoint, parses each event,
 *   accumulates message.delta payloads into the assistant message row,
 *   then forwards a sanitized event back to the client.
 */
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { authRequired, csrfRequired } from "../middleware";
import { getDb } from "../db";
import { forUser } from "../db/scoped";
import { ulid } from "../lib/id";
import { logger } from "../lib/logger";
import {
  createRun,
  resolveApproval,
  stopRun,
  streamRunEvents,
} from "../gateway/client";

export const chatRunRoutes = new Hono(); // mounted at /api/chats/:id/runs
export const runRoutes = new Hono(); // mounted at /api/runs

chatRunRoutes.use("*", authRequired);
runRoutes.use("*", authRequired);

// ─── Start a run ────────────────────────────────────────────────────────

const startRunSchema = z.object({
  input: z.string().min(1).max(32_000),
  model: z.string().min(1).max(128).optional(),
});

chatRunRoutes.post("/", csrfRequired, async (c) => {
  const user = c.get("user");
  if (!user) return c.json({ error: "Unauthenticated" }, 401);

  const chatId = c.req.param("id") ?? "";
  const body = await c.req.json().catch(() => ({}));
  const parsed = startRunSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Invalid input", issues: parsed.error.issues }, 400);
  }

  const scoped = forUser(getDb(), user.id);
  const chat = scoped.chats.byId(chatId);
  if (!chat) return c.json({ error: "Chat not found" }, 404);

  // Build conversation history from prior messages (skip pending/failed).
  const history = scoped.messages
    .listForChat(chatId)
    .filter(
      (m) =>
        (m.role === "user" || m.role === "assistant") &&
        m.status === "completed" &&
        m.content.length > 0,
    )
    .map((m) => ({ role: m.role, content: m.content }));

  // Persist the user turn first.
  const now = Date.now();
  const userMsg = scoped.messages.insert({
    id: ulid(),
    chatId,
    role: "user",
    content: parsed.data.input,
    status: "completed",
  });

  // Reserve an assistant placeholder; it'll accumulate deltas.
  const assistantMsg = scoped.messages.insert({
    id: ulid(),
    chatId,
    role: "assistant",
    content: "",
    status: "pending",
  });

  // Hit the gateway. If this fails, we mark the assistant message as
  // failed and surface the error — the user message remains in history.
  let upstream: { runId: string; status: string };
  try {
    upstream = await createRun({
      input: parsed.data.input,
      sessionId: chat.gatewaySessionId,
      model: parsed.data.model ?? chat.model ?? null,
      conversationHistory: history,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "gateway error";
    scoped.messages.finalize(assistantMsg.id, { status: "failed", error: msg });
    logger.warn({ err, chatId }, "gateway createRun failed");
    // Map upstream auth/rate failures to 502 so we don't leak gateway
    // identity issues to the browser. Hono's ContentfulStatusCode type
    // doesn't include 502 explicitly so we cast through unknown.
    return c.json({ error: "Gateway error", detail: msg }, 502 as never);
  }

  const localRun = scoped.activeRuns.insert({
    id: ulid(),
    chatId,
    messageId: assistantMsg.id,
    upstreamRunId: upstream.runId,
    status: "queued",
  });

  scoped.messages.finalize(assistantMsg.id, { status: "streaming" });
  scoped.chats.touchLastMessage(chatId, now);

  return c.json({
    run: {
      id: localRun.id,
      chatId,
      status: localRun.status,
      messageId: assistantMsg.id,
    },
    userMessage: { id: userMsg.id, role: userMsg.role, content: userMsg.content },
    assistantMessage: {
      id: assistantMsg.id,
      role: "assistant",
      content: "",
      status: "streaming",
    },
  });
});

// ─── SSE proxy for a run's events ───────────────────────────────────────

const runIdParam = z.string().min(1).max(64);

runRoutes.get("/:runId/events", async (c) => {
  const user = c.get("user");
  if (!user) return c.json({ error: "Unauthenticated" }, 401);

  const idResult = runIdParam.safeParse(c.req.param("runId"));
  if (!idResult.success) return c.json({ error: "Invalid id" }, 400);

  const scoped = forUser(getDb(), user.id);
  const run = scoped.activeRuns.byId(idResult.data);
  if (!run) return c.json({ error: "Run not found" }, 404);

  return streamSSE(c, async (stream) => {
    const upstreamRunId = run.upstreamRunId;
    const messageId = run.messageId;
    const localRunId = run.id;
    const ac = new AbortController();

    // If the client closes its EventSource, abort the upstream fetch.
    stream.onAbort(() => {
      try {
        ac.abort();
      } catch {
        // ignore
      }
    });

    try {
      for await (const event of streamRunEvents(upstreamRunId, ac.signal)) {
        const ev = String(event["event"] ?? "");

        // Persist deltas; surface a sanitized event to the client.
        if (ev === "message.delta") {
          const delta = String(event["delta"] ?? "");
          if (delta) {
            scoped.messages.appendDelta(messageId, delta);
          }
          await stream.writeSSE({
            event: "message.delta",
            data: JSON.stringify({ runId: localRunId, messageId, delta }),
          });
        } else if (ev === "run.completed") {
          const usage = event["usage"];
          scoped.messages.finalize(messageId, {
            status: "completed",
            metadata: usage ? JSON.stringify({ usage }) : undefined,
          });
          scoped.activeRuns.setStatus(localRunId, "completed", { finishedAt: Date.now() });
          await stream.writeSSE({
            event: "run.completed",
            data: JSON.stringify({ runId: localRunId, messageId }),
          });
          break;
        } else if (ev === "run.failed") {
          const errMsg = String(event["error"] ?? "run failed");
          scoped.messages.finalize(messageId, { status: "failed", error: errMsg });
          scoped.activeRuns.setStatus(localRunId, "failed", {
            error: errMsg,
            finishedAt: Date.now(),
          });
          await stream.writeSSE({
            event: "run.failed",
            data: JSON.stringify({ runId: localRunId, messageId, error: errMsg }),
          });
          break;
        } else if (ev === "run.cancelled") {
          scoped.messages.finalize(messageId, { status: "cancelled" });
          scoped.activeRuns.setStatus(localRunId, "cancelled", { finishedAt: Date.now() });
          await stream.writeSSE({
            event: "run.cancelled",
            data: JSON.stringify({ runId: localRunId, messageId }),
          });
          break;
        } else if (ev === "approval.request") {
          scoped.activeRuns.setStatus(localRunId, "waiting_for_approval");
          // Forward only the bits the UI needs (no upstream run id).
          const { event: _e, run_id: _r, ...rest } = event as Record<string, unknown>;
          void _e;
          void _r;
          await stream.writeSSE({
            event: "approval.request",
            data: JSON.stringify({ runId: localRunId, ...rest }),
          });
        } else if (ev === "approval.responded") {
          scoped.activeRuns.setStatus(localRunId, "running");
          await stream.writeSSE({
            event: "approval.responded",
            data: JSON.stringify({ runId: localRunId }),
          });
        } else if (ev === "tool.progress") {
          // Forward tool progress without persisting (UI ephemera only).
          const { event: _e, run_id: _r, ...rest } = event as Record<string, unknown>;
          void _e;
          void _r;
          await stream.writeSSE({
            event: "tool.progress",
            data: JSON.stringify({ runId: localRunId, ...rest }),
          });
        }
        // unknown events are silently dropped; gateway may add new ones
      }
    } catch (err) {
      if (ac.signal.aborted) {
        // client closed — nothing to do
        return;
      }
      const msg = err instanceof Error ? err.message : "stream error";
      logger.warn({ err, localRunId, upstreamRunId }, "SSE proxy error");
      scoped.messages.finalize(messageId, { status: "failed", error: msg });
      scoped.activeRuns.setStatus(localRunId, "failed", {
        error: msg,
        finishedAt: Date.now(),
      });
      try {
        await stream.writeSSE({
          event: "run.failed",
          data: JSON.stringify({ runId: localRunId, messageId, error: msg }),
        });
      } catch {
        // client gone
      }
    }
  });
});

// ─── Stop a run ─────────────────────────────────────────────────────────

runRoutes.post("/:runId/stop", csrfRequired, async (c) => {
  const user = c.get("user");
  if (!user) return c.json({ error: "Unauthenticated" }, 401);

  const idResult = runIdParam.safeParse(c.req.param("runId"));
  if (!idResult.success) return c.json({ error: "Invalid id" }, 400);

  const scoped = forUser(getDb(), user.id);
  const run = scoped.activeRuns.byId(idResult.data);
  if (!run) return c.json({ error: "Run not found" }, 404);

  scoped.activeRuns.setStatus(run.id, "stopping");
  try {
    await stopRun(run.upstreamRunId);
  } catch (err) {
    logger.warn({ err, runId: run.id }, "stop upstream run failed");
  }

  return c.json({ ok: true });
});

// ─── Resolve approval ───────────────────────────────────────────────────

const approvalSchema = z.object({
  choice: z.enum(["once", "session", "always", "deny"]),
});

runRoutes.post("/:runId/approval", csrfRequired, async (c) => {
  const user = c.get("user");
  if (!user) return c.json({ error: "Unauthenticated" }, 401);

  const idResult = runIdParam.safeParse(c.req.param("runId"));
  if (!idResult.success) return c.json({ error: "Invalid id" }, 400);

  const body = await c.req.json().catch(() => ({}));
  const parsed = approvalSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Invalid input", issues: parsed.error.issues }, 400);
  }

  const scoped = forUser(getDb(), user.id);
  const run = scoped.activeRuns.byId(idResult.data);
  if (!run) return c.json({ error: "Run not found" }, 404);

  try {
    await resolveApproval(run.upstreamRunId, parsed.data.choice);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "approval resolve failed";
    return c.json({ error: msg }, 502 as never);
  }

  return c.json({ ok: true });
});
