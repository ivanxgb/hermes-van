/**
 * Phase 5.D — push_subscriptions scoping tests.
 *
 * The wrapper is the security boundary. These verify:
 *   - list/byEndpoint only see the scoped user's rows
 *   - upsert is idempotent (same endpoint = update, not duplicate)
 *   - deleteByEndpoint and incrementFail can't reach across users
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3-multiple-ciphers";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { eq } from "drizzle-orm";
import { unlinkSync } from "node:fs";
import * as schema from "../../src/server/db/schema";
import { forUser } from "../../src/server/db/scoped";
import { ulid } from "../../src/server/lib/id";

let raw: Database.Database;
let db: BetterSQLite3Database<typeof schema>;
let dbPath: string;

beforeEach(() => {
  dbPath = `/tmp/hermes-van-push-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
  raw = new Database(dbPath);
  raw.pragma("key='test-key-not-secret'");
  raw.pragma("cipher_compatibility=4");
  raw.pragma("journal_mode=WAL");
  raw.pragma("foreign_keys=ON");
  db = drizzle(raw, { schema });
  migrate(db, { migrationsFolder: "./src/server/db/migrations" });
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

function createUser(id: string, username: string) {
  db.insert(schema.users).values({ id, username, displayName: username }).run();
}

describe("ScopedDb pushSubscriptions isolation", () => {
  it("list and byEndpoint only see the scoped user's subscriptions", () => {
    const u1 = ulid();
    const u2 = ulid();
    createUser(u1, "alice");
    createUser(u2, "bob");

    const aliceDb = forUser(db, u1);
    const bobDb = forUser(db, u2);

    aliceDb.pushSubscriptions.upsert({
      id: ulid(),
      endpoint: "https://push.example.com/alice",
      p256dh: "pk-alice",
      auth: "auth-alice",
      userAgent: "alice-ua",
    });
    bobDb.pushSubscriptions.upsert({
      id: ulid(),
      endpoint: "https://push.example.com/bob",
      p256dh: "pk-bob",
      auth: "auth-bob",
      userAgent: "bob-ua",
    });

    expect(aliceDb.pushSubscriptions.list()).toHaveLength(1);
    expect(bobDb.pushSubscriptions.list()).toHaveLength(1);
    expect(aliceDb.pushSubscriptions.list()[0]?.endpoint).toBe(
      "https://push.example.com/alice",
    );
    // Bob's endpoint should be invisible to Alice's lookup.
    expect(aliceDb.pushSubscriptions.byEndpoint("https://push.example.com/bob")).toBeUndefined();
  });

  it("upsert is idempotent — same endpoint twice = update, not duplicate", () => {
    const u1 = ulid();
    createUser(u1, "alice");
    const aliceDb = forUser(db, u1);

    const ep = "https://push.example.com/alice";
    aliceDb.pushSubscriptions.upsert({
      id: ulid(),
      endpoint: ep,
      p256dh: "v1",
      auth: "v1",
      userAgent: "ua-v1",
    });
    aliceDb.pushSubscriptions.upsert({
      id: ulid(),
      endpoint: ep,
      p256dh: "v2",
      auth: "v2",
      userAgent: "ua-v2",
    });

    const list = aliceDb.pushSubscriptions.list();
    expect(list).toHaveLength(1);
    expect(list[0]?.p256dh).toBe("v2");
    expect(list[0]?.userAgent).toBe("ua-v2");
  });

  it("deleteByEndpoint is no-op cross-user", () => {
    const u1 = ulid();
    const u2 = ulid();
    createUser(u1, "alice");
    createUser(u2, "bob");

    const ep = "https://push.example.com/bob";
    forUser(db, u2).pushSubscriptions.upsert({
      id: ulid(),
      endpoint: ep,
      p256dh: "pk",
      auth: "auth",
      userAgent: null,
    });

    // Alice tries to delete Bob's endpoint — should not affect Bob.
    forUser(db, u1).pushSubscriptions.deleteByEndpoint(ep);
    expect(forUser(db, u2).pushSubscriptions.byEndpoint(ep)).toBeDefined();

    // Bob can delete his own.
    forUser(db, u2).pushSubscriptions.deleteByEndpoint(ep);
    expect(forUser(db, u2).pushSubscriptions.byEndpoint(ep)).toBeUndefined();
  });

  it("incrementFail is no-op cross-user", () => {
    const u1 = ulid();
    const u2 = ulid();
    createUser(u1, "alice");
    createUser(u2, "bob");

    const id = ulid();
    forUser(db, u2).pushSubscriptions.upsert({
      id,
      endpoint: "https://push.example.com/bob",
      p256dh: "pk",
      auth: "auth",
      userAgent: null,
    });

    forUser(db, u1).pushSubscriptions.incrementFail(id);
    const sub = forUser(db, u2).pushSubscriptions.byEndpoint(
      "https://push.example.com/bob",
    );
    expect(sub?.failedCount).toBe(0);

    forUser(db, u2).pushSubscriptions.incrementFail(id);
    forUser(db, u2).pushSubscriptions.incrementFail(id);
    const after = forUser(db, u2).pushSubscriptions.byEndpoint(
      "https://push.example.com/bob",
    );
    expect(after?.failedCount).toBe(2);
  });

  it("subscriptions cascade-delete when user is deleted", () => {
    const u1 = ulid();
    createUser(u1, "alice");
    const aliceDb = forUser(db, u1);

    aliceDb.pushSubscriptions.upsert({
      id: ulid(),
      endpoint: "https://push.example.com/alice",
      p256dh: "pk",
      auth: "auth",
      userAgent: null,
    });
    expect(aliceDb.pushSubscriptions.list()).toHaveLength(1);

    db.delete(schema.users)
      .where(eq(schema.users.id, u1))
      .run();

    expect(aliceDb.pushSubscriptions.list()).toHaveLength(0);
  });
});
