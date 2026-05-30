/**
 * Phase 5.G — alert webhook tests.
 *
 * Verifies:
 *   - When HERMES_VAN_ALERT_WEBHOOK is unset, fireAlert is a no-op
 *     (no fetch call).
 *   - When set, fireAlert posts JSON with the right shape.
 *   - Bearer token is forwarded as Authorization when configured.
 *   - Non-2xx receiver responses are tolerated (don't throw).
 *   - Network errors are swallowed (fire-and-forget).
 *   - Audit emitAudit triggers fireAlert for high-severity events.
 *   - Audit emitAudit does NOT trigger fireAlert for low-severity events.
 */
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3-multiple-ciphers";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { unlinkSync } from "node:fs";
import * as schema from "../../src/server/db/schema";

// Mocks must be hoisted above imports.
const fetchMock = vi.hoisted(() => vi.fn());
const envMock = vi.hoisted(() =>
  vi.fn(() => ({
    NODE_ENV: "test",
    HERMES_VAN_LOG_LEVEL: "fatal" as const,
    HERMES_VAN_ALERT_WEBHOOK: "https://alerts.example.com/hook",
    HERMES_VAN_ALERT_BEARER: undefined as string | undefined,
  })),
);

vi.mock("../../src/server/lib/env", () => ({
  loadEnv: envMock,
}));

// Stub global fetch.
beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(new Response("ok", { status: 200 }));
});

const { fireAlert, _resetAlertCache } = await import("../../src/server/lib/alerts");
const { emitAudit } = await import("../../src/server/auth/audit");

function flushMicrotasks(): Promise<void> {
  // fireAlert dispatches via void Promise.then — flush so the mock has
  // been called by the time we assert.
  return new Promise((resolve) => setImmediate(resolve));
}

describe("fireAlert", () => {
  beforeEach(() => {
    _resetAlertCache();
  });

  it("is a no-op when HERMES_VAN_ALERT_WEBHOOK is unset", async () => {
    envMock.mockReturnValueOnce({
      NODE_ENV: "test",
      HERMES_VAN_LOG_LEVEL: "fatal",
      HERMES_VAN_ALERT_WEBHOOK: undefined,
      HERMES_VAN_ALERT_BEARER: undefined,
    });
    fireAlert({ event: "x", severity: "info", title: "x" });
    await flushMicrotasks();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("POSTs JSON with the right shape when configured", async () => {
    fireAlert({
      event: "login.fail",
      severity: "warning",
      title: "Failed login",
      metadata: { username: "alice" },
    });
    await flushMicrotasks();

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://alerts.example.com/hook");
    expect(init.method).toBe("POST");
    expect(init.headers["Content-Type"]).toBe("application/json");
    expect(init.headers["User-Agent"]).toMatch(/hermes-van/);
    expect(init.headers["Authorization"]).toBeUndefined();

    const body = JSON.parse(init.body as string);
    expect(body.service).toBe("hermes-van");
    expect(body.event).toBe("login.fail");
    expect(body.severity).toBe("warning");
    expect(body.title).toBe("Failed login");
    expect(body.metadata.username).toBe("alice");
    expect(typeof body.ts).toBe("string");
  });

  it("forwards Bearer auth header when configured", async () => {
    envMock.mockReturnValueOnce({
      NODE_ENV: "test",
      HERMES_VAN_LOG_LEVEL: "fatal",
      HERMES_VAN_ALERT_WEBHOOK: "https://alerts.example.com/hook",
      HERMES_VAN_ALERT_BEARER: "secret-token-xyz",
    });
    fireAlert({ event: "session.revoke_all", severity: "critical", title: "x" });
    await flushMicrotasks();
    expect(fetchMock).toHaveBeenCalledOnce();
    const [, init] = fetchMock.mock.calls[0]!;
    expect(init.headers["Authorization"]).toBe("Bearer secret-token-xyz");
  });

  it("tolerates non-2xx receiver responses without throwing", async () => {
    fetchMock.mockResolvedValueOnce(new Response("nope", { status: 503 }));
    expect(() =>
      fireAlert({ event: "x", severity: "info", title: "x" }),
    ).not.toThrow();
    await flushMicrotasks();
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("swallows network errors (fire-and-forget)", async () => {
    fetchMock.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    expect(() =>
      fireAlert({ event: "x", severity: "info", title: "x" }),
    ).not.toThrow();
    await flushMicrotasks();
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});

describe("emitAudit alert routing", () => {
  let raw: Database.Database;
  let db: ReturnType<typeof drizzle>;
  let dbPath: string;

  beforeEach(() => {
    dbPath = `/tmp/hv-alerts-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
    raw = new Database(dbPath);
    raw.pragma("key='test-key-not-secret'");
    raw.pragma("cipher_compatibility=4");
    raw.pragma("foreign_keys=ON");
    db = drizzle(raw, { schema });
    migrate(db, { migrationsFolder: "./src/server/db/migrations" });
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(new Response("ok", { status: 200 }));
    _resetAlertCache();
  });

  afterEach(() => {
    raw.close();
    try {
      unlinkSync(dbPath);
      unlinkSync(`${dbPath}-wal`);
      unlinkSync(`${dbPath}-shm`);
    } catch {
      // ignore
    }
  });

  it("fires an alert for high-severity events", async () => {
    emitAudit(db as never, {
      event: "session.revoke_all",
      userId: "u1",
      ip: "1.2.3.4",
      metadata: { count: 3 },
    });
    await flushMicrotasks();
    expect(fetchMock).toHaveBeenCalledOnce();
    const [, init] = fetchMock.mock.calls[0]!;
    const body = JSON.parse(init.body as string);
    expect(body.event).toBe("session.revoke_all");
    expect(body.severity).toBe("critical");
    expect(body.metadata.userId).toBe("u1");
    expect(body.metadata.ip).toBe("1.2.3.4");
    expect(body.metadata.count).toBe(3);
  });

  it("does NOT fire for low-severity events (login.ok, user.created)", async () => {
    emitAudit(db as never, { event: "login.ok", userId: "u1" });
    emitAudit(db as never, { event: "user.created", userId: "u1" });
    emitAudit(db as never, { event: "logout.ok", userId: "u1" });
    await flushMicrotasks();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fires for login.fail (warning) and recovery.fail (critical)", async () => {
    emitAudit(db as never, { event: "login.fail", userId: "u1" });
    emitAudit(db as never, { event: "recovery.fail", userId: "u1" });
    await flushMicrotasks();
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const calls = fetchMock.mock.calls.map((c) => JSON.parse(c[1].body as string));
    const sevs = calls.map((c) => c.severity).sort();
    expect(sevs).toEqual(["critical", "warning"]);
  });

  it("truncates user-agent to 200 chars in alert metadata", async () => {
    const longUA = "x".repeat(500);
    emitAudit(db as never, {
      event: "login.fail",
      userId: "u1",
      userAgent: longUA,
    });
    await flushMicrotasks();
    expect(fetchMock).toHaveBeenCalledOnce();
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body as string);
    expect((body.metadata.userAgent as string).length).toBe(200);
  });
});
