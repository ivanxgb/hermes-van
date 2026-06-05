/**
 * Phase 5.D — push helper dispatch tests.
 *
 * Mocks the web-push library and verifies our wrapper:
 *   - returns zero counts when VAPID env is missing (no-op)
 *   - sends to every subscription, returns sent count
 *   - removes subscription on 404/410 (browser threw it away)
 *   - bumps failedCount on other errors
 */
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3-multiple-ciphers";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { unlinkSync } from "node:fs";
import * as schema from "../../src/server/db/schema";
import { forUser } from "../../src/server/db/scoped";
import { ulid } from "../../src/server/lib/id";

// Mock web-push BEFORE importing the helper so the helper picks up
// the mocked implementation. Must use vi.hoisted so the mock fns are
// available at module-mock time (vi.mock is hoisted above imports).
const sendMock = vi.hoisted(() => vi.fn());
const setVapidMock = vi.hoisted(() => vi.fn());

vi.mock("web-push", () => ({
  default: {
    sendNotification: sendMock,
    setVapidDetails: setVapidMock,
    generateVAPIDKeys: () => ({ publicKey: "pub", privateKey: "priv" }),
  },
}));

// Mock the env helper so we can flip VAPID keys per-test.
const envMock = vi.hoisted(() =>
  vi.fn(() => ({
    NODE_ENV: "test",
    HERMES_VAN_LOG_LEVEL: "fatal",
    HERMES_VAN_VAPID_PUBLIC: "pub-key",
    HERMES_VAN_VAPID_PRIVATE: "priv-key",
    HERMES_VAN_VAPID_SUBJECT: "mailto:test@example.com",
  })),
);
vi.mock("../../src/server/lib/env", () => ({
  loadEnv: envMock,
}));

// Mock getDb to return our test database.
const dbHolder: { db: ReturnType<typeof drizzle> | null } = { db: null };
vi.mock("../../src/server/db", () => ({
  getDb: () => dbHolder.db,
}));

// Now import the helper — its imports get the mocks above.
const { pushToUser, vapidPublicKey, _resetVapidCache } = await import(
  "../../src/server/lib/push"
);

let raw: Database.Database;
let dbPath: string;

beforeEach(() => {
  dbPath = `/tmp/hv-push-helper-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
  raw = new Database(dbPath);
  raw.pragma("key='test-key-not-secret'");
  raw.pragma("cipher_compatibility=4");
  raw.pragma("journal_mode=WAL");
  raw.pragma("foreign_keys=ON");
  const db = drizzle(raw, { schema });
  migrate(db, { migrationsFolder: "./src/server/db/migrations" });
  dbHolder.db = db;
  sendMock.mockReset();
  _resetVapidCache();
  envMock.mockReturnValue({
    NODE_ENV: "test",
    HERMES_VAN_LOG_LEVEL: "fatal",
    HERMES_VAN_VAPID_PUBLIC: "pub-key",
    HERMES_VAN_VAPID_PRIVATE: "priv-key",
    HERMES_VAN_VAPID_SUBJECT: "mailto:test@example.com",
  });
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

function createUserWithSubs(userId: string, endpoints: string[]) {
  raw.prepare(
    "INSERT INTO users (id, username, display_name) VALUES (?, ?, ?)",
  ).run(userId, `u-${userId.slice(-6)}`, `u-${userId.slice(-6)}`);
  const scoped = forUser(dbHolder.db!, userId);
  for (const ep of endpoints) {
    scoped.pushSubscriptions.upsert({
      id: ulid(),
      endpoint: ep,
      p256dh: "pk",
      auth: "auth",
      userAgent: null,
    });
  }
}

describe("pushToUser", () => {
  it("returns zero counts when VAPID is not configured", async () => {
    envMock.mockReturnValue({
      NODE_ENV: "test",
      HERMES_VAN_LOG_LEVEL: "fatal",
      HERMES_VAN_VAPID_PUBLIC: undefined,
      HERMES_VAN_VAPID_PRIVATE: undefined,
      HERMES_VAN_VAPID_SUBJECT: "mailto:test@example.com",
    });
    _resetVapidCache();

    const u1 = ulid();
    createUserWithSubs(u1, ["https://example.com/a"]);

    const r = await pushToUser(u1, { title: "x", body: "y" });
    expect(r).toEqual({ sent: 0, failed: 0, removed: 0 });
    expect(sendMock).not.toHaveBeenCalled();
    expect(vapidPublicKey()).toBeNull();
  });

  it("returns the public key when configured", () => {
    expect(vapidPublicKey()).toBe("pub-key");
  });

  it("sends to every subscription and returns sent count", async () => {
    const u1 = ulid();
    createUserWithSubs(u1, [
      "https://example.com/a",
      "https://example.com/b",
      "https://example.com/c",
    ]);
    sendMock.mockResolvedValue(undefined);

    const r = await pushToUser(u1, { title: "ping", body: "pong" });
    expect(r).toEqual({ sent: 3, failed: 0, removed: 0 });
    expect(sendMock).toHaveBeenCalledTimes(3);

    // Verify payload shape on at least one call.
    const firstCall = sendMock.mock.calls[0]!;
    expect(firstCall[0]).toMatchObject({
      endpoint: expect.stringContaining("https://example.com/"),
      keys: { p256dh: "pk", auth: "auth" },
    });
    const payload = JSON.parse(firstCall[1] as string);
    expect(payload).toEqual({ title: "ping", body: "pong" });
  });

  it("removes subscription on 410 Gone (browser dropped it)", async () => {
    const u1 = ulid();
    createUserWithSubs(u1, ["https://example.com/gone"]);

    const err = Object.assign(new Error("Gone"), { statusCode: 410 });
    sendMock.mockRejectedValueOnce(err);

    const r = await pushToUser(u1, { title: "x", body: "y" });
    expect(r).toEqual({ sent: 0, failed: 0, removed: 1 });
    const remaining = forUser(dbHolder.db!, u1).pushSubscriptions.list();
    expect(remaining).toHaveLength(0);
  });

  it("bumps failedCount on transient errors (e.g. 502/503)", async () => {
    const u1 = ulid();
    createUserWithSubs(u1, ["https://example.com/flaky"]);

    const err = Object.assign(new Error("Bad Gateway"), { statusCode: 502 });
    sendMock.mockRejectedValueOnce(err);

    const r = await pushToUser(u1, { title: "x", body: "y" });
    expect(r).toEqual({ sent: 0, failed: 1, removed: 0 });
    const remaining = forUser(dbHolder.db!, u1).pushSubscriptions.list();
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.failedCount).toBe(1);
  });

  it("returns zero counts when user has no subscriptions", async () => {
    const u1 = ulid();
    raw.prepare(
      "INSERT INTO users (id, username, display_name) VALUES (?, ?, ?)",
    ).run(u1, "lonely", "lonely");

    const r = await pushToUser(u1, { title: "x", body: "y" });
    expect(r).toEqual({ sent: 0, failed: 0, removed: 0 });
    expect(sendMock).not.toHaveBeenCalled();
  });
});
