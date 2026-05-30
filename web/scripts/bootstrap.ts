/**
 * Bootstrap CLI — create a one-time setup token to bring up the first user.
 *
 * Usage:
 *   pnpm hermes-van:bootstrap          → emits token, valid 1 hour
 *   pnpm hermes-van:bootstrap --hours 24 → custom validity
 *
 * The token is hashed before storing in DB; we only ever print the
 * raw form once. Lose it and you have to run the script again.
 */
import { randomBytes, createHash } from "node:crypto";
import { getDb, getRawDb, closeDb } from "../src/server/db";
import { ulid } from "../src/server/lib/id";
import * as schema from "../src/server/db/schema";

function parseArgs() {
  const args = process.argv.slice(2);
  const hoursIdx = args.indexOf("--hours");
  const hours =
    hoursIdx >= 0 && args[hoursIdx + 1] ? Number(args[hoursIdx + 1]) : 1;
  if (!Number.isFinite(hours) || hours <= 0 || hours > 24 * 30) {
    throw new Error("--hours must be between 0 and 720 (30 days)");
  }
  return { hours };
}

function main() {
  const { hours } = parseArgs();
  // 32 raw bytes -> ~43 chars base64url
  const token = randomBytes(32).toString("base64url");
  const tokenHash = createHash("sha256").update(token).digest("hex");
  const expiresAt = Date.now() + hours * 60 * 60 * 1000;

  try {
    getDb(); // initialize
    const raw = getRawDb();
    raw
      .prepare(
        "INSERT INTO setup_tokens (id, token_hash, expires_at) VALUES (?, ?, ?)",
      )
      .run(ulid(), tokenHash, expiresAt);

    process.stdout.write("\n");
    process.stdout.write("━".repeat(60) + "\n");
    process.stdout.write("  hermes-van bootstrap token issued\n");
    process.stdout.write("━".repeat(60) + "\n");
    process.stdout.write(`  Valid until : ${new Date(expiresAt).toISOString()}\n`);
    process.stdout.write(`  Token       : ${token}\n`);
    process.stdout.write("━".repeat(60) + "\n");
    process.stdout.write("  Use this token at /setup to register the first user.\n");
    process.stdout.write("  This is the only time it will be displayed.\n");
    process.stdout.write("\n");
  } catch (err) {
    process.stderr.write(`bootstrap failed: ${(err as Error).message}\n`);
    process.exitCode = 1;
  } finally {
    closeDb();
  }
}

void schema; // tree-shake guard for migrations
main();
