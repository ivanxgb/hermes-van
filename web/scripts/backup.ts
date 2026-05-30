#!/usr/bin/env tsx
/**
 * Encrypted backup of the SQLCipher DB with a round-trip integrity check.
 *
 * Strategy:
 *   1. Open the live DB with HERMES_VAN_DB_KEY, checkpoint WAL.
 *   2. Use SQLite's online backup API (db.backup) to copy the encrypted
 *      pages to backups/hermes-van-<ISO>.db. Cipher state is binary-
 *      identical, so the same key opens the backup.
 *   3. Open the backup in a new connection, count rows in sentinel
 *      tables, compare against source. Mismatch → delete backup + exit 1.
 *
 * Usage:
 *   pnpm hermes-van:backup
 *   pnpm hermes-van:backup --output /path/to/file.db
 */
import "dotenv/config";
import Database from "better-sqlite3-multiple-ciphers";
import { mkdirSync, statSync, unlinkSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { loadEnv } from "../src/server/lib/env";

interface BackupResult {
  source: string;
  target: string;
  bytes: number;
  rowCounts: Record<string, number>;
  durationMs: number;
}

const SENTINEL_TABLES = [
  "users",
  "webauthn_credentials",
  "web_sessions",
  "audit_log",
  "chats",
  "messages",
];

function quoteKey(k: string): string {
  return k.replace(/'/g, "''");
}

function openCiphered(path: string, key: string): Database.Database {
  const db = new Database(path);
  db.pragma(`key='${quoteKey(key)}'`);
  db.pragma("cipher_compatibility=4");
  db.pragma("journal_mode=WAL");
  db.prepare("SELECT count(*) FROM sqlite_master").get();
  return db;
}

function tableExists(db: Database.Database, name: string): boolean {
  const row = db
    .prepare<[string], { name: string }>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name = ?",
    )
    .get(name);
  return !!row;
}

function countRows(db: Database.Database, table: string): number {
  const r = db
    .prepare<[], { c: number }>(`SELECT count(*) AS c FROM "${table}"`)
    .get();
  return r?.c ?? 0;
}

async function backup(targetOverride?: string): Promise<BackupResult> {
  const start = Date.now();
  const env = loadEnv();
  const sourcePath = resolve(env.HERMES_VAN_DB_PATH);
  if (!statSync(sourcePath).isFile()) {
    throw new Error(`Source DB does not exist: ${sourcePath}`);
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const target =
    targetOverride ??
    resolve(dirname(sourcePath), "..", "backups", `hermes-van-${stamp}.db`);
  mkdirSync(dirname(target), { recursive: true });

  // Open source, checkpoint WAL, capture sentinel counts before backup.
  const src = openCiphered(sourcePath, env.HERMES_VAN_DB_KEY);
  src.pragma("wal_checkpoint(TRUNCATE)");
  const sourceCounts: Record<string, number> = {};
  for (const t of SENTINEL_TABLES) {
    if (tableExists(src, t)) sourceCounts[t] = countRows(src, t);
  }

  // better-sqlite3-multiple-ciphers doesn't expose sqlcipher_export,
  // and SQLite's online backup() refuses encrypted→encrypted with
  // mismatched cipher state. Cleanest reliable path: checkpoint WAL
  // so the main DB file holds the latest committed pages, close the
  // source, then do a raw file copy. The on-disk format is identical
  // and the same master key opens the copy.
  src.pragma("wal_checkpoint(TRUNCATE)");
  src.close();
  const { copyFileSync } = await import("node:fs");
  copyFileSync(sourcePath, target);

  // Round-trip verify.
  const verify = openCiphered(target, env.HERMES_VAN_DB_KEY);
  const verifyCounts: Record<string, number> = {};
  for (const t of Object.keys(sourceCounts)) {
    verifyCounts[t] = countRows(verify, t);
  }
  // Bonus integrity check: PRAGMA integrity_check returns 'ok' on a
  // healthy DB. Anything else → backup is corrupt; bail.
  const integrity = verify
    .prepare<[], { integrity_check: string }>("PRAGMA integrity_check")
    .all();
  verify.close();

  const integrityResult = integrity[0]?.integrity_check ?? "(empty)";
  if (integrityResult !== "ok") {
    try {
      unlinkSync(target);
    } catch {
      // best effort
    }
    throw new Error(`integrity_check failed: ${integrityResult}`);
  }

  for (const t of Object.keys(sourceCounts)) {
    if (sourceCounts[t] !== verifyCounts[t]) {
      try {
        unlinkSync(target);
      } catch {
        // best effort
      }
      throw new Error(
        `Row count mismatch on ${t}: source=${sourceCounts[t]} backup=${verifyCounts[t]}`,
      );
    }
  }

  const bytes = statSync(target).size;
  return {
    source: sourcePath,
    target,
    bytes,
    rowCounts: verifyCounts,
    durationMs: Date.now() - start,
  };
}

async function main() {
  const args = process.argv.slice(2);
  let output: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--output" && args[i + 1]) {
      output = args[i + 1];
      i++;
    }
  }

  try {
    const r = await backup(output);
    console.log(`✓ backup written: ${r.target}`);
    console.log(`  size: ${(r.bytes / 1024).toFixed(1)} KB`);
    console.log(`  duration: ${r.durationMs} ms`);
    console.log(`  row counts (verified):`);
    for (const [t, n] of Object.entries(r.rowCounts)) {
      console.log(`    ${t.padEnd(24)} ${n}`);
    }
  } catch (err) {
    console.error(`✗ backup failed: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }
}

void main();
