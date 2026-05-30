/**
 * Phase 5.C — encrypted backup script integrity test.
 *
 * Runs the backup script against the live dev DB into a temp file and
 * verifies:
 *   1. Exit code is 0.
 *   2. Output file exists and is a SQLCipher v4 DB (header magic).
 *   3. Opening the backup with the same key reads the same rows as the
 *      source for sentinel tables.
 *   4. Tampering with the master key fails to open it (proves the file
 *      is actually encrypted and not a plaintext copy).
 */
import { test, expect } from "vitest";
import { execSync } from "node:child_process";
import { mkdtempSync, readFileSync, statSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3-multiple-ciphers";

const ENV_PATH = "./.env";

function readEnvKey(name: string): string {
  const env = readFileSync(ENV_PATH, "utf8");
  const m = env.match(new RegExp(`^${name}=(.+)$`, "m"));
  if (!m) throw new Error(`${name} not found in .env`);
  return m[1]!.trim();
}

function openCiphered(path: string, key: string) {
  const db = new Database(path);
  db.pragma(`key='${key.replace(/'/g, "''")}'`);
  db.pragma("cipher_compatibility=4");
  return db;
}

test("backup script writes a valid encrypted copy that opens with the same key", () => {
  const tmp = mkdtempSync(join(tmpdir(), "hv-backup-"));
  const target = join(tmp, "test-backup.db");

  try {
    const out = execSync(`pnpm hermes-van:backup --output ${target}`, {
      encoding: "utf8",
      cwd: process.cwd(),
    });
    expect(out).toContain("backup written");
    expect(statSync(target).size).toBeGreaterThan(0);

    // SQLCipher v4 files don't start with the unencrypted SQLite magic
    // string "SQLite format 3\0". Confirm the header bytes are not that
    // — if they were, the file would be plaintext.
    const head = readFileSync(target).slice(0, 16);
    const headStr = head.toString("latin1");
    expect(headStr.startsWith("SQLite format 3")).toBe(false);

    // Open with the right key, count rows in a sentinel table.
    const dbKey = readEnvKey("HERMES_VAN_DB_KEY");
    const dbPath = readEnvKey("HERMES_VAN_DB_PATH");

    const verify = openCiphered(target, dbKey);
    const verifyUsers = verify
      .prepare<[], { c: number }>("SELECT count(*) AS c FROM users")
      .get();
    verify.close();

    const src = openCiphered(dbPath, dbKey);
    const srcUsers = src
      .prepare<[], { c: number }>("SELECT count(*) AS c FROM users")
      .get();
    src.close();

    expect(verifyUsers?.c).toBe(srcUsers?.c);

    // Wrong key must fail. better-sqlite3-multiple-ciphers throws on the
    // first read after a bad key.
    expect(() => {
      const wrong = openCiphered(target, "00".repeat(32));
      wrong.prepare("SELECT count(*) FROM users").get();
    }).toThrow();
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}, 30_000);
