/**
 * Database connection.
 *
 * Single SQLCipher-backed SQLite file. Connection is created lazily and
 * cached. PRAGMAs:
 *   - key=<HERMES_WEB_DB_KEY>  : SQLCipher master key
 *   - cipher_compatibility=4    : SQLCipher v4 format
 *   - journal_mode=WAL          : concurrent readers
 *   - foreign_keys=ON           : enforce FK cascades
 *   - busy_timeout=5000         : retry locked DB up to 5s
 */
import { mkdirSync, existsSync, chmodSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3-multiple-ciphers";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { loadEnv } from "../lib/env";
import * as schema from "./schema";

let _db: ReturnType<typeof drizzle<typeof schema>> | null = null;
let _raw: Database.Database | null = null;

function open(path: string, key: string): Database.Database {
  const dir = dirname(path);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  const sqlite = new Database(path);
  // Order matters: key MUST be set before any other operation.
  sqlite.pragma(`key='${key.replace(/'/g, "''")}'`);
  sqlite.pragma("cipher_compatibility=4");
  sqlite.pragma("journal_mode=WAL");
  sqlite.pragma("foreign_keys=ON");
  sqlite.pragma("busy_timeout=5000");
  sqlite.pragma("synchronous=NORMAL");

  // Verify decryption succeeded by issuing a cheap read. If the key is
  // wrong, this throws SQLITE_NOTADB.
  try {
    sqlite.prepare("SELECT count(*) FROM sqlite_master").get();
  } catch (err) {
    sqlite.close();
    throw new Error(
      `Failed to open encrypted DB. Likely wrong HERMES_WEB_DB_KEY. ` +
        `(underlying: ${(err as Error).message})`,
    );
  }

  // Tighten file perms (0600). Best-effort: skip on Windows.
  try {
    chmodSync(path, 0o600);
  } catch {
    // ignore
  }

  return sqlite;
}

export function getDb() {
  if (_db) return _db;
  const env = loadEnv();
  _raw = open(env.HERMES_WEB_DB_PATH, env.HERMES_WEB_DB_KEY);
  _db = drizzle(_raw, { schema });
  return _db;
}

export function getRawDb(): Database.Database {
  if (!_raw) getDb();
  if (!_raw) throw new Error("DB not initialized");
  return _raw;
}

export function closeDb(): void {
  if (_raw) {
    _raw.close();
    _raw = null;
    _db = null;
  }
}

/**
 * Test helper. Open an isolated in-file DB at the given path with the
 * given key. Caller must close it manually.
 */
export function _openForTest(path: string, key: string) {
  const sqlite = open(path, key);
  return {
    db: drizzle(sqlite, { schema }),
    raw: sqlite,
    close: () => sqlite.close(),
  };
}
