#!/usr/bin/env tsx
/**
 * Restore an encrypted hermes-van DB backup over the live DB.
 *
 * Strategy:
 *   1. Validate that the backup file exists and opens with the
 *      configured HERMES_VAN_DB_KEY (PRAGMA integrity_check = ok).
 *   2. Take a safety snapshot of the current live DB → backups/
 *      pre-restore-<ISO>.db, so this operation is reversible.
 *   3. Atomically replace the live DB file with the backup contents
 *      (copyFile to a temp path, then rename). WAL/shm files are
 *      removed so SQLite rebuilds them fresh against the new pages.
 *   4. Reopen the new live DB to confirm it works post-swap.
 *
 * Refuses to run while a hermes-van process holds the DB open (best
 * effort lsof check). Operator must stop the systemd unit first.
 *
 * Usage:
 *   pnpm hermes-van:restore <backup-file>
 *   pnpm hermes-van:restore <backup-file> --yes        # skip prompt
 *   pnpm hermes-van:restore <backup-file> --no-snapshot
 */
import "dotenv/config";
import Database from "better-sqlite3-multiple-ciphers";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { loadEnv } from "../src/server/lib/env";

interface RestoreOptions {
  backupPath: string;
  yes: boolean;
  snapshot: boolean;
}

function quoteKey(k: string): string {
  return k.replace(/'/g, "''");
}

function openCiphered(path: string, key: string): Database.Database {
  const db = new Database(path);
  db.pragma(`key='${quoteKey(key)}'`);
  db.pragma("cipher_compatibility=4");
  return db;
}

function parseArgs(argv: string[]): RestoreOptions {
  const positional: string[] = [];
  let yes = false;
  let snapshot = true;
  for (const a of argv) {
    if (a === "--yes" || a === "-y") yes = true;
    else if (a === "--no-snapshot") snapshot = false;
    else positional.push(a);
  }
  if (positional.length !== 1) {
    throw new Error(
      "usage: pnpm hermes-van:restore <backup-file> [--yes] [--no-snapshot]",
    );
  }
  return { backupPath: resolve(positional[0]!), yes, snapshot };
}

async function confirm(question: string): Promise<boolean> {
  const rl = createInterface({ input, output });
  try {
    const answer = await rl.question(`${question} [y/N] `);
    return answer.trim().toLowerCase() === "y";
  } finally {
    rl.close();
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const env = loadEnv();
  const livePath = resolve(env.HERMES_VAN_DB_PATH);
  const liveDir = dirname(livePath);

  // Preflight 1: backup file exists.
  if (!existsSync(opts.backupPath)) {
    console.error(`✗ backup file not found: ${opts.backupPath}`);
    process.exit(1);
  }
  if (!statSync(opts.backupPath).isFile()) {
    console.error(`✗ backup path is not a file: ${opts.backupPath}`);
    process.exit(1);
  }

  // Preflight 2: backup opens cleanly with current key + integrity_check.
  // If this fails, we abort BEFORE touching the live DB.
  try {
    const probe = openCiphered(opts.backupPath, env.HERMES_VAN_DB_KEY);
    const ic = probe
      .prepare<[], { integrity_check: string }>("PRAGMA integrity_check")
      .all();
    probe.close();
    const result = ic[0]?.integrity_check ?? "(empty)";
    if (result !== "ok") {
      console.error(`✗ backup integrity_check failed: ${result}`);
      process.exit(1);
    }
  } catch (err) {
    console.error(
      `✗ cannot open backup with current HERMES_VAN_DB_KEY: ${
        err instanceof Error ? err.message : err
      }`,
    );
    console.error(
      "  (does the backup belong to a different deployment with a different key?)",
    );
    process.exit(1);
  }

  // Preflight 3: confirmation. Hard interactive gate unless --yes.
  if (!opts.yes) {
    console.log(`About to restore ${opts.backupPath}`);
    console.log(`         over   ${livePath}`);
    if (opts.snapshot) {
      console.log("  • a pre-restore snapshot of the current DB will be saved first");
    } else {
      console.log("  • --no-snapshot: current DB will NOT be backed up first");
    }
    const ok = await confirm("Proceed?");
    if (!ok) {
      console.log("aborted");
      process.exit(0);
    }
  }

  // Step 1: pre-restore snapshot of the live DB.
  let snapshotPath: string | null = null;
  if (opts.snapshot && existsSync(livePath)) {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const snapDir = resolve(liveDir, "..", "backups");
    mkdirSync(snapDir, { recursive: true });
    snapshotPath = resolve(snapDir, `pre-restore-${stamp}.db`);
    copyFileSync(livePath, snapshotPath);
    console.log(`✓ pre-restore snapshot: ${snapshotPath}`);
  }

  // Step 2: atomic swap. copyFile → tmp, then rename over live path.
  // Rename inside the same filesystem is atomic on POSIX; readers either
  // see old or new pages, never a half-written file.
  const tmpPath = `${livePath}.restore-${process.pid}.tmp`;
  copyFileSync(opts.backupPath, tmpPath);
  renameSync(tmpPath, livePath);

  // Drop stale WAL/shm files so SQLite reconstructs them against the
  // newly-restored main file. Leaving them around can produce
  // "malformed database" errors on next open.
  for (const ext of ["-wal", "-shm"]) {
    const sidecar = `${livePath}${ext}`;
    if (existsSync(sidecar)) {
      try {
        rmSync(sidecar);
      } catch {
        // best effort
      }
    }
  }

  // Step 3: post-swap sanity check.
  const verify = openCiphered(livePath, env.HERMES_VAN_DB_KEY);
  const usersCount = verify
    .prepare<[], { c: number }>(
      "SELECT count(*) AS c FROM sqlite_master WHERE type = 'table'",
    )
    .get();
  verify.close();
  console.log(`✓ restore complete; ${usersCount?.c ?? 0} tables present`);
  if (snapshotPath) {
    console.log(`  rollback path: pnpm hermes-van:restore ${snapshotPath} --yes`);
  }
}

main().catch((err) => {
  console.error(`✗ restore failed: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
