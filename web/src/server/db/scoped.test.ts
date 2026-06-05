/**
 * Scoped DB tests. The wrapper is the security boundary preventing
 * cross-user reads/writes; these tests must always pass.
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3-multiple-ciphers";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { eq } from "drizzle-orm";
import { unlinkSync } from "node:fs";
import * as schema from "./schema";
import { ScopedDb, forUser } from "./scoped";
import { ulid } from "../lib/id";

let raw: Database.Database;
let db: BetterSQLite3Database<typeof schema>;
let dbPath: string;

beforeEach(() => {
  dbPath = `/tmp/hermes-van-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
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
    // ignore — files may not exist
  }
});

function createUser(id: string, username: string) {
  db.insert(schema.users)
    .values({ id, username, displayName: username })
    .run();
}

describe("ScopedDb construction", () => {
  it("rejects empty userId", () => {
    expect(() => new ScopedDb(db, "")).toThrow(/non-empty/);
  });
});

describe("ScopedDb webauthn isolation", () => {
  it("only lists credentials for the scoped user", () => {
    const u1 = ulid();
    const u2 = ulid();
    createUser(u1, "alice");
    createUser(u2, "bob");

    const aliceDb = forUser(db, u1);
    const bobDb = forUser(db, u2);

    aliceDb.webauthnCredentials.insert({
      id: ulid(),
      credentialId: "cred-alice-1",
      publicKey: "pk-alice",
      counter: 0,
      transports: "[]",
      backedUp: false,
      deviceType: "platform",
      nickname: null,
      lastUsedAt: null,
    });
    bobDb.webauthnCredentials.insert({
      id: ulid(),
      credentialId: "cred-bob-1",
      publicKey: "pk-bob",
      counter: 0,
      transports: "[]",
      backedUp: false,
      deviceType: "platform",
      nickname: null,
      lastUsedAt: null,
    });

    expect(aliceDb.webauthnCredentials.list()).toHaveLength(1);
    expect(bobDb.webauthnCredentials.list()).toHaveLength(1);
    expect(aliceDb.webauthnCredentials.list()[0]?.credentialId).toBe("cred-alice-1");
    expect(bobDb.webauthnCredentials.list()[0]?.credentialId).toBe("cred-bob-1");
  });

  it("byId returns undefined for cross-user lookup", () => {
    const u1 = ulid();
    const u2 = ulid();
    createUser(u1, "alice");
    createUser(u2, "bob");
    const aliceDb = forUser(db, u1);
    const bobDb = forUser(db, u2);

    const credId = ulid();
    bobDb.webauthnCredentials.insert({
      id: credId,
      credentialId: "cred-bob-1",
      publicKey: "pk-bob",
      counter: 0,
      transports: "[]",
      backedUp: false,
      deviceType: "platform",
      nickname: null,
      lastUsedAt: null,
    });

    expect(bobDb.webauthnCredentials.byId(credId)).toBeDefined();
    expect(aliceDb.webauthnCredentials.byId(credId)).toBeUndefined();
  });

  it("delete is no-op when scoped user does not own the row", () => {
    const u1 = ulid();
    const u2 = ulid();
    createUser(u1, "alice");
    createUser(u2, "bob");

    const credId = ulid();
    forUser(db, u2).webauthnCredentials.insert({
      id: credId,
      credentialId: "cred-bob-1",
      publicKey: "pk-bob",
      counter: 0,
      transports: "[]",
      backedUp: false,
      deviceType: "platform",
      nickname: null,
      lastUsedAt: null,
    });

    // Alice tries to delete Bob's credential — must be a no-op (no owner found).
    forUser(db, u1).webauthnCredentials.delete(credId);

    // Bob's credential is still present.
    expect(forUser(db, u2).webauthnCredentials.byId(credId)).toBeDefined();
  });
});

describe("ScopedDb sessions isolation", () => {
  it("revokeAll affects only the scoped user", () => {
    const u1 = ulid();
    const u2 = ulid();
    createUser(u1, "alice");
    createUser(u2, "bob");

    const future = Date.now() + 86400_000;
    forUser(db, u1).webSessions.insert({
      id: ulid(),
      expiresAt: future,
      ip: null,
      userAgent: null,
      csrfTokenHash: "hash-1",
    });
    forUser(db, u2).webSessions.insert({
      id: ulid(),
      expiresAt: future,
      ip: null,
      userAgent: null,
      csrfTokenHash: "hash-2",
    });

    const revoked = forUser(db, u1).webSessions.revokeAll();
    expect(revoked).toBe(1);

    const aliceSess = forUser(db, u1).webSessions.list();
    const bobSess = forUser(db, u2).webSessions.list();
    expect(aliceSess[0]?.revokedAt).not.toBeNull();
    expect(bobSess[0]?.revokedAt).toBeNull();
  });
});

describe("ScopedDb recovery codes isolation", () => {
  it("listUnused only returns scoped user's unused codes", () => {
    const u1 = ulid();
    const u2 = ulid();
    createUser(u1, "alice");
    createUser(u2, "bob");

    forUser(db, u1).recoveryCodes.insertMany([
      { id: ulid(), codeHash: "hash-a-1" },
      { id: ulid(), codeHash: "hash-a-2" },
    ]);
    forUser(db, u2).recoveryCodes.insertMany([{ id: ulid(), codeHash: "hash-b-1" }]);

    expect(forUser(db, u1).recoveryCodes.listUnused()).toHaveLength(2);
    expect(forUser(db, u2).recoveryCodes.listUnused()).toHaveLength(1);
  });
});

describe("ScopedDb FK cascade on user delete", () => {
  it("deleting a user wipes their credentials, sessions, recovery codes", () => {
    const u1 = ulid();
    createUser(u1, "alice");
    const aliceDb = forUser(db, u1);

    aliceDb.webauthnCredentials.insert({
      id: ulid(),
      credentialId: "cred-alice-1",
      publicKey: "pk",
      counter: 0,
      transports: "[]",
      backedUp: false,
      deviceType: "platform",
      nickname: null,
      lastUsedAt: null,
    });
    aliceDb.webSessions.insert({
      id: ulid(),
      expiresAt: Date.now() + 1000,
      ip: null,
      userAgent: null,
      csrfTokenHash: "hash",
    });
    aliceDb.recoveryCodes.insertMany([{ id: ulid(), codeHash: "h" }]);

    expect(aliceDb.webauthnCredentials.list()).toHaveLength(1);

    // Delete the user — cascade to scoped tables.
    db.delete(schema.users).where(eq(schema.users.id, u1)).run();

    expect(aliceDb.webauthnCredentials.list()).toHaveLength(0);
    expect(aliceDb.webSessions.list()).toHaveLength(0);
    expect(aliceDb.recoveryCodes.listUnused()).toHaveLength(0);
  });
});

describe("ScopedDb chats isolation", () => {
  it("only lists chats for the scoped user", () => {
    const u1 = ulid();
    const u2 = ulid();
    createUser(u1, "alice");
    createUser(u2, "bob");

    forUser(db, u1).chats.insert({
      id: ulid(),
      title: "Alice chat",
      gatewaySessionId: "gw-alice-1",
    });
    forUser(db, u2).chats.insert({
      id: ulid(),
      title: "Bob chat",
      gatewaySessionId: "gw-bob-1",
    });

    expect(forUser(db, u1).chats.list()).toHaveLength(1);
    expect(forUser(db, u2).chats.list()).toHaveLength(1);
    expect(forUser(db, u1).chats.list()[0]?.title).toBe("Alice chat");
  });

  it("excludes archived chats by default", () => {
    const u1 = ulid();
    createUser(u1, "alice");
    const id = ulid();
    forUser(db, u1).chats.insert({ id, title: "x", gatewaySessionId: "gw-x" });
    forUser(db, u1).chats.archive(id);

    expect(forUser(db, u1).chats.list()).toHaveLength(0);
    expect(forUser(db, u1).chats.list({ includeArchived: true })).toHaveLength(1);
  });

  it("rename does not leak across users", () => {
    const u1 = ulid();
    const u2 = ulid();
    createUser(u1, "alice");
    createUser(u2, "bob");
    const id = ulid();
    forUser(db, u2).chats.insert({ id, title: "Bob chat", gatewaySessionId: "gw-b" });

    // Alice tries to rename Bob's chat — must be a no-op.
    forUser(db, u1).chats.rename(id, "hijacked");
    expect(forUser(db, u2).chats.byId(id)?.title).toBe("Bob chat");
  });

  it("orders by lastMessageAt DESC", () => {
    const u1 = ulid();
    createUser(u1, "alice");
    const a = ulid();
    const b = ulid();
    forUser(db, u1).chats.insert({ id: a, title: "A", gatewaySessionId: "gw-a" });
    forUser(db, u1).chats.insert({ id: b, title: "B", gatewaySessionId: "gw-b" });
    forUser(db, u1).chats.touchLastMessage(b, Date.now() + 1000);

    const list = forUser(db, u1).chats.list();
    expect(list[0]?.id).toBe(b);
    expect(list[1]?.id).toBe(a);
  });

  it("setModel updates the per-chat model and clears with null", () => {
    const u1 = ulid();
    createUser(u1, "alice");
    const id = ulid();
    forUser(db, u1).chats.insert({
      id,
      title: "M",
      gatewaySessionId: "gw-m",
      model: "claude-sonnet-4",
    });
    expect(forUser(db, u1).chats.byId(id)?.model).toBe("claude-sonnet-4");

    forUser(db, u1).chats.setModel(id, "gpt-5");
    expect(forUser(db, u1).chats.byId(id)?.model).toBe("gpt-5");

    forUser(db, u1).chats.setModel(id, null);
    expect(forUser(db, u1).chats.byId(id)?.model).toBeNull();
  });

  it("setModel does not leak across users", () => {
    const u1 = ulid();
    const u2 = ulid();
    createUser(u1, "alice");
    createUser(u2, "bob");
    const id = ulid();
    forUser(db, u2).chats.insert({
      id,
      title: "Bob chat",
      gatewaySessionId: "gw-b",
      model: "bob-model",
    });
    // Alice tries to overwrite Bob's model — must be a no-op.
    forUser(db, u1).chats.setModel(id, "hijacked");
    expect(forUser(db, u2).chats.byId(id)?.model).toBe("bob-model");
  });
});

describe("ScopedDb messages isolation + delta accumulation", () => {
  it("listForChat returns only messages for that chat", () => {
    const u1 = ulid();
    createUser(u1, "alice");
    const c1 = ulid();
    const c2 = ulid();
    forUser(db, u1).chats.insert({ id: c1, title: "C1", gatewaySessionId: "gw-c1" });
    forUser(db, u1).chats.insert({ id: c2, title: "C2", gatewaySessionId: "gw-c2" });

    forUser(db, u1).messages.insert({
      id: ulid(),
      chatId: c1,
      role: "user",
      content: "hello",
      status: "completed",
    });
    forUser(db, u1).messages.insert({
      id: ulid(),
      chatId: c2,
      role: "user",
      content: "hi",
      status: "completed",
    });

    expect(forUser(db, u1).messages.listForChat(c1)).toHaveLength(1);
    expect(forUser(db, u1).messages.listForChat(c2)).toHaveLength(1);
  });

  it("appendDelta accumulates streaming content", () => {
    const u1 = ulid();
    createUser(u1, "alice");
    const c1 = ulid();
    forUser(db, u1).chats.insert({ id: c1, title: "C", gatewaySessionId: "gw-c" });
    const m = ulid();
    forUser(db, u1).messages.insert({
      id: m,
      chatId: c1,
      role: "assistant",
      content: "",
      status: "streaming",
    });

    forUser(db, u1).messages.appendDelta(m, "Hello");
    forUser(db, u1).messages.appendDelta(m, " world");
    forUser(db, u1).messages.finalize(m, { status: "completed" });

    const finalized = forUser(db, u1).messages.byId(m);
    expect(finalized?.content).toBe("Hello world");
    expect(finalized?.status).toBe("completed");
  });

  it("messages cascade-delete when chat is deleted", () => {
    const u1 = ulid();
    createUser(u1, "alice");
    const c1 = ulid();
    forUser(db, u1).chats.insert({ id: c1, title: "C", gatewaySessionId: "gw-cdel" });
    forUser(db, u1).messages.insert({
      id: ulid(),
      chatId: c1,
      role: "user",
      content: "x",
      status: "completed",
    });

    expect(forUser(db, u1).messages.listForChat(c1)).toHaveLength(1);
    forUser(db, u1).chats.delete(c1);
    expect(forUser(db, u1).messages.listForChat(c1)).toHaveLength(0);
  });
});

describe("ScopedDb activeRuns isolation", () => {
  it("byUpstreamId only matches the scoped user", () => {
    const u1 = ulid();
    const u2 = ulid();
    createUser(u1, "alice");
    createUser(u2, "bob");
    const c1 = ulid();
    forUser(db, u1).chats.insert({ id: c1, title: "C", gatewaySessionId: "gw-r1" });
    const m = ulid();
    forUser(db, u1).messages.insert({
      id: m,
      chatId: c1,
      role: "assistant",
      content: "",
      status: "pending",
    });
    forUser(db, u1).activeRuns.insert({
      id: ulid(),
      chatId: c1,
      messageId: m,
      upstreamRunId: "run_shared_id",
    });

    expect(forUser(db, u1).activeRuns.byUpstreamId("run_shared_id")).toBeDefined();
    expect(forUser(db, u2).activeRuns.byUpstreamId("run_shared_id")).toBeUndefined();
  });

  it("setStatus is no-op cross-user", () => {
    const u1 = ulid();
    const u2 = ulid();
    createUser(u1, "alice");
    createUser(u2, "bob");
    const c1 = ulid();
    forUser(db, u1).chats.insert({ id: c1, title: "C", gatewaySessionId: "gw-r2" });
    const m = ulid();
    forUser(db, u1).messages.insert({
      id: m,
      chatId: c1,
      role: "assistant",
      content: "",
      status: "pending",
    });
    const runId = ulid();
    forUser(db, u1).activeRuns.insert({
      id: runId,
      chatId: c1,
      messageId: m,
      upstreamRunId: "run_alice",
    });

    forUser(db, u2).activeRuns.setStatus(runId, "completed");
    expect(forUser(db, u1).activeRuns.byId(runId)?.status).toBe("queued");
  });
});
