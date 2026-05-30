/**
 * Apply pending migrations.
 *
 * Run with: pnpm db:migrate
 *
 * Reads HERMES_VAN_DB_PATH and HERMES_VAN_DB_KEY from env. Creates the
 * file if missing. Idempotent — running twice is a no-op.
 */
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { getDb, getRawDb, closeDb } from "../src/server/db";
import { logger } from "../src/server/lib/logger";

function main() {
  try {
    const db = getDb();
    const raw = getRawDb();
    logger.info({ path: raw.name }, "applying migrations");
    migrate(db, { migrationsFolder: "./src/server/db/migrations" });
    logger.info("migrations applied");
  } catch (err) {
    logger.error({ err }, "migration failed");
    process.exitCode = 1;
  } finally {
    closeDb();
  }
}

main();
