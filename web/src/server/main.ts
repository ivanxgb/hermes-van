/**
 * Production server entry. Imports the Hono app and binds it to a
 * Node TCP socket via @hono/node-server.
 *
 * Dev (vite + @hono/vite-dev-server) does not need this — the dev
 * server mounts the app inline. In production, run via:
 *
 *   pnpm hermes-van:start
 *
 * which executes this file via tsx, picks up HERMES_VAN_PORT/HOST
 * from the env, and never reaches the dev-only Vite plugin.
 */
import "dotenv/config";
import { serve } from "@hono/node-server";
import app from "./index";
import { loadEnv } from "./lib/env";
import { logger } from "./lib/logger";

const env = loadEnv();

const server = serve(
  {
    fetch: app.fetch,
    port: env.HERMES_VAN_PORT,
    hostname: env.HERMES_VAN_HOST,
  },
  (info) => {
    logger.info(
      { port: info.port, host: env.HERMES_VAN_HOST, env: env.NODE_ENV },
      "hermes-van listening",
    );
  },
);

function shutdown(signal: string): void {
  logger.info({ signal }, "received signal, shutting down");
  server.close(() => {
    logger.info({ signal }, "shutdown complete");
    process.exit(0);
  });
  // Give in-flight requests a grace period before forcing exit.
  setTimeout(() => {
    logger.warn({ signal }, "shutdown timeout, forcing exit");
    process.exit(1);
  }, 10_000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
