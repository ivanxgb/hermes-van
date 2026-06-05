/**
 * Global e2e setup — wipes and re-migrates the DB before the whole suite
 * runs. This gives us a clean slate per CI run so:
 *   - rate limiters (setup 10/h, login 5/15m, etc.) reset
 *   - prior usernames don't collide
 *   - WebAuthn credentials from previous runs are gone
 *
 * Runs once per `playwright test` invocation, not once per test.
 */
import { execSync } from "node:child_process";
import { existsSync, unlinkSync } from "node:fs";

export default async function globalSetup(): Promise<void> {
  const dbPath = process.env["HERMES_VAN_DB_PATH"] ?? "./data/hermes-van.db";
  for (const p of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
    if (existsSync(p)) {
      unlinkSync(p);
      // eslint-disable-next-line no-console
      console.log(`[e2e setup] removed ${p}`);
    }
  }
  // Apply migrations against the fresh DB. Pipes stdout so failures show.
  execSync("pnpm --silent db:migrate", {
    cwd: process.cwd(),
    stdio: "inherit",
    env: { ...process.env, NODE_ENV: "development" },
  });
  // eslint-disable-next-line no-console
  console.log("[e2e setup] migrations applied to fresh DB");
}
