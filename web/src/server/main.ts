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
import { serveStatic } from "@hono/node-server/serve-static";
import { existsSync } from "node:fs";
import app from "./index";
import { loadEnv } from "./lib/env";
import { logger } from "./lib/logger";
import { pushToAll } from "./lib/push";

const env = loadEnv();

// In dev, Vite serves /public/* and the SPA. In production, we have to
// do that ourselves. Mount /public assets first (notably /sw.js, which
// MUST be served from the root scope for the push service worker to
// claim the whole origin), then the Hono routes (registered via
// app.route() in src/server/index.ts), then a SPA fallback that serves
// dist/index.html for any unmatched non-API route.
//
// sw.js is special: in production we want the post-build hash-injected
// copy from dist/, not the raw template in public/. Fall back to public
// for dev.
app.use(
  "/sw.js",
  serveStatic({
    path: existsSync("./dist/sw.js") ? "./dist/sw.js" : "./public/sw.js",
  }),
);
app.use("/favicon.ico", serveStatic({ path: "./public/favicon.ico" }));
app.use(
  "/manifest.webmanifest",
  serveStatic({ path: "./public/manifest.webmanifest" }),
);
app.use("/icon.svg", serveStatic({ path: "./public/icon.svg" }));

// Vite build output (run `pnpm build` first). If dist/ doesn't exist,
// the prod server still works for the API but the SPA shell will 404 —
// that's acceptable for API-only deployments.
if (existsSync("./dist")) {
  app.use("/assets/*", serveStatic({ root: "./dist" }));
  // SPA fallback: anything that's not /api/*, /auth/*, or /assets/*
  // falls back to index.html so client-side routing works on hard
  // reload. /assets/* is explicitly excluded so missing assets 404
  // cleanly instead of serving the SPA shell with a wrong content-type.
  app.use("*", async (c, next) => {
    const path = new URL(c.req.url).pathname;
    if (
      path.startsWith("/api/") ||
      path.startsWith("/auth/") ||
      path.startsWith("/assets/")
    ) {
      return next();
    }
    return serveStatic({ path: "./dist/index.html" })(c, next);
  });
}

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

  // Best-effort web-push fanout so subscribers know to reload. Capped
  // at 4s so we don't block systemd's stop timeout.
  const restartNotice = pushToAll(
    {
      title: "hermes-van restarting",
      body: "Server is restarting. Reload the app when you're back.",
      tag: "hv-restart",
      url: "/chat",
    },
    { limitMs: 4000 },
  )
    .then((r) =>
      logger.info({ ...r, signal }, "shutdown push fanout"),
    )
    .catch((err) =>
      logger.warn({ err: String(err), signal }, "shutdown push fanout failed"),
    );

  Promise.race([
    restartNotice,
    new Promise((resolve) => setTimeout(resolve, 4500)),
  ])
    .then(() => {
      server.close(() => {
        logger.info({ signal }, "shutdown complete");
        process.exit(0);
      });
    })
    .catch(() => {
      server.close(() => process.exit(1));
    });

  // Hard cap: regardless of fanout result, force exit after grace.
  setTimeout(() => {
    logger.warn({ signal }, "shutdown timeout, forcing exit");
    process.exit(1);
  }, 10_000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
