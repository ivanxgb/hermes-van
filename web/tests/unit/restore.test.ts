/**
 * Phase 5.I — backup retention + restore.
 *
 * Verifies:
 *   1. Retention prunes old backups in the canonical backups/ dir to N
 *      most-recent (default 14, configurable via env).
 *   2. --output overrides skip retention (one-off path; user asked for it).
 *   3. Files NOT matching the hermes-van-*.db convention are never
 *      pruned (defensive: don't touch unrelated files).
 *   4. Restore round-trips: backup → restore → all sentinel rows
 *      preserved, integrity_check ok.
 *   5. Restore creates a pre-restore snapshot so the operation is reversible.
 *   6. Restore refuses if the backup can't be opened with the current key.
 */
import { afterEach, beforeEach, expect, test } from "vitest";
import { execSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
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

/**
 * Spin up an isolated workspace with its own .env pointing at a fresh
 * encrypted DB. Lets us drive backup/restore without disturbing the
 * dev DB the rest of the suite relies on.
 */
function makeIsolatedWorkspace(): {
  workDir: string;
  envPath: string;
  liveDb: string;
  backupsDir: string;
  cleanup: () => void;
} {
  const workDir = mkdtempSync(join(tmpdir(), "hv-restore-"));
  const dataDir = join(workDir, "data");
  const backupsDir = join(workDir, "backups");
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(backupsDir, { recursive: true });

  // Copy current dev DB encrypted-as-is. Same key, same pages.
  const sourceDb = readEnvKey("HERMES_VAN_DB_PATH");
  const liveDb = join(dataDir, "hermes-van.db");
  cpSync(sourceDb, liveDb);

  // Write isolated .env. Only the keys backup.ts/restore.ts care about
  // need to match real values; everything else can stay defaulted.
  const envPath = join(workDir, ".env");
  const dbKey = readEnvKey("HERMES_VAN_DB_KEY");
  const sessionSecret = readEnvKey("HERMES_VAN_SESSION_SECRET");
  const gatewayKey = readEnvKey("HERMES_VAN_GATEWAY_KEY");
  writeFileSync(
    envPath,
    [
      `HERMES_VAN_GATEWAY_KEY=${gatewayKey}`,
      `HERMES_VAN_DB_PATH=${liveDb}`,
      `HERMES_VAN_DB_KEY=${dbKey}`,
      `HERMES_VAN_SESSION_SECRET=${sessionSecret}`,
      `HERMES_VAN_BACKUP_RETENTION=3`,
      "",
    ].join("\n"),
  );

  return {
    workDir,
    envPath,
    liveDb,
    backupsDir,
    cleanup: () => rmSync(workDir, { recursive: true, force: true }),
  };
}

let ws: ReturnType<typeof makeIsolatedWorkspace>;

beforeEach(() => {
  ws = makeIsolatedWorkspace();
});

afterEach(() => {
  ws.cleanup();
});

function runBackupCanonical(): string {
  // Run from the project root so pnpm scripts resolve, but with the
  // isolated env file. backup.ts derives its target dir from
  // HERMES_VAN_DB_PATH, so the backup lands in <workDir>/backups/.
  const out = execSync(
    `node --env-file=${ws.envPath} --import tsx scripts/backup.ts`,
    { encoding: "utf8", cwd: process.cwd() },
  );
  const m = out.match(/backup written: (.+)$/m);
  if (!m) throw new Error(`backup output missing target path:\n${out}`);
  return m[1]!.trim();
}

test("retention prunes old backups, keeping the N most recent", () => {
  // Stuff the backups dir with five older fakes, then take a real one.
  // The real one should land, and the prune should leave the 3 newest
  // (real + 2 most-recent fakes) per HERMES_VAN_BACKUP_RETENTION=3.
  const now = Date.now();
  for (let i = 0; i < 5; i++) {
    const f = join(ws.backupsDir, `hermes-van-fake-${i}.db`);
    writeFileSync(f, Buffer.alloc(64));
    // Stagger mtimes 1 hour apart, oldest first.
    const t = (now - (10 - i) * 3600_000) / 1000;
    utimesSync(f, t, t);
  }

  const realPath = runBackupCanonical();
  expect(existsSync(realPath)).toBe(true);

  const remaining = readdirSync(ws.backupsDir)
    .filter((n) => /^hermes-van-.+\.db$/.test(n))
    .map((n) => ({ n, m: statSync(join(ws.backupsDir, n)).mtimeMs }))
    .sort((a, b) => b.m - a.m);

  expect(remaining.length).toBe(3);
  // The real backup is the newest; the next two are fake-4 and fake-3
  // (the most recent of the fakes).
  expect(remaining[0]!.n).toContain("hermes-van-");
  const names = remaining.map((r) => r.n);
  expect(names).toContain("hermes-van-fake-4.db");
  expect(names).toContain("hermes-van-fake-3.db");
  // The oldest fakes are gone.
  expect(names).not.toContain("hermes-van-fake-0.db");
  expect(names).not.toContain("hermes-van-fake-1.db");
}, 30_000);

test("retention does not touch files outside the hermes-van-*.db naming", () => {
  // Drop files that should be preserved no matter what.
  const sentinels = [
    "pre-restore-2026-01-01.db", // restore snapshots
    "manual-export.sqlite",
    "README.md",
    "untitled.db", // .db but doesn't start with hermes-van-
  ];
  for (const name of sentinels) {
    writeFileSync(join(ws.backupsDir, name), "x");
  }

  // Take a real backup. retention=3 + only 1 hermes-van-*.db file →
  // nothing should get pruned.
  runBackupCanonical();

  for (const name of sentinels) {
    expect(existsSync(join(ws.backupsDir, name))).toBe(true);
  }
}, 30_000);

test("--output skips retention (one-off override)", () => {
  // Even with the same retention=3, a custom output dir should NOT
  // trigger pruning of files that happen to be there.
  const customDir = join(ws.workDir, "custom-out");
  mkdirSync(customDir, { recursive: true });
  for (let i = 0; i < 5; i++) {
    writeFileSync(join(customDir, `hermes-van-leave-me-${i}.db`), "x");
  }
  const target = join(customDir, "manual-target.db");

  execSync(
    `node --env-file=${ws.envPath} --import tsx scripts/backup.ts --output ${target}`,
    { encoding: "utf8", cwd: process.cwd() },
  );

  // All five fakes plus the new target should still be present.
  const left = readdirSync(customDir).filter((n) => n.endsWith(".db"));
  expect(left.length).toBe(6);
}, 30_000);

test("restore round-trips a backup over the live DB", () => {
  const backupPath = runBackupCanonical();

  const dbKey = readEnvKey("HERMES_VAN_DB_KEY");
  const before = openCiphered(ws.liveDb, dbKey);
  const beforeUsers = before
    .prepare<[], { c: number }>("SELECT count(*) AS c FROM users")
    .get();
  before.close();

  // Mutate the live DB (delete all users) so restore must actually
  // bring rows back from the backup.
  const mutate = openCiphered(ws.liveDb, dbKey);
  mutate.exec("DELETE FROM users");
  mutate.close();

  const out = execSync(
    `node --env-file=${ws.envPath} --import tsx scripts/restore.ts ${backupPath} --yes`,
    { encoding: "utf8", cwd: process.cwd() },
  );
  expect(out).toContain("restore complete");

  const after = openCiphered(ws.liveDb, dbKey);
  const afterUsers = after
    .prepare<[], { c: number }>("SELECT count(*) AS c FROM users")
    .get();
  const integrity = after
    .prepare<[], { integrity_check: string }>("PRAGMA integrity_check")
    .all();
  after.close();

  expect(integrity[0]?.integrity_check).toBe("ok");
  expect(afterUsers?.c).toBe(beforeUsers?.c);
}, 60_000);

test("restore creates a pre-restore snapshot when one isn't suppressed", () => {
  const backupPath = runBackupCanonical();
  execSync(
    `node --env-file=${ws.envPath} --import tsx scripts/restore.ts ${backupPath} --yes`,
    { encoding: "utf8", cwd: process.cwd() },
  );

  const snaps = readdirSync(ws.backupsDir).filter((n) =>
    n.startsWith("pre-restore-"),
  );
  expect(snaps.length).toBeGreaterThanOrEqual(1);
}, 60_000);

test("restore refuses to run with a backup that can't be opened with the current key", () => {
  // Drop a junk file that won't open with the current cipher key.
  const junk = join(ws.backupsDir, "hermes-van-junk.db");
  writeFileSync(junk, Buffer.from("not a real sqlcipher db at all 0123456789"));

  let failed = false;
  let stderr = "";
  try {
    execSync(
      `node --env-file=${ws.envPath} --import tsx scripts/restore.ts ${junk} --yes`,
      { encoding: "utf8", cwd: process.cwd(), stdio: ["pipe", "pipe", "pipe"] },
    );
  } catch (err) {
    failed = true;
    const e = err as { stderr?: Buffer | string; stdout?: Buffer | string };
    stderr = String(e.stderr ?? "") + String(e.stdout ?? "");
  }
  expect(failed).toBe(true);
  expect(stderr.toLowerCase()).toMatch(/cannot open backup|integrity_check failed/);
}, 30_000);
