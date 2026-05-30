/**
 * Phase 5.H — production server smoke test.
 *
 * Exercises `pnpm hermes-van:start` end-to-end. The rest of the e2e suite
 * runs against `vite + @hono/vite-dev-server`, which mounts the Hono app
 * directly via the plugin and never reaches src/server/main.ts. A bug
 * that only manifests in production (e.g. /sw.js was 404ing because main.ts
 * didn't mount serveStatic) sailed past every other test.
 *
 * This test:
 *   1. Spawns main.ts on a random port with the live .env.
 *   2. Waits for the "listening" log line.
 *   3. Probes /api/health, /sw.js, /favicon.ico, and an unknown path.
 *   4. Asserts shape + content-type for each.
 *   5. Cleanly SIGTERMs the child.
 *
 * Marked `test.runIf` so it skips in environments without a usable .env.
 */
import { test, expect } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";

const HAS_ENV = existsSync("./.env");

async function waitForReady(port: number, timeoutMs = 20_000): Promise<void> {
  // Poll /api/health until it returns 200 or we time out. More reliable
  // than scraping log output (the logger may be JSON-formatted, level-
  // gated, or write to a different stream depending on env).
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/health`, {
        signal: AbortSignal.timeout(1_000),
      });
      if (r.status === 200) return;
    } catch {
      // server not up yet
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`timeout waiting for prod server on :${port} within ${timeoutMs}ms`);
}

async function killAndWait(proc: ChildProcess): Promise<void> {
  if (proc.killed || proc.exitCode !== null) return;
  proc.kill("SIGTERM");
  await new Promise<void>((resolve) => {
    const t = setTimeout(() => {
      proc.kill("SIGKILL");
      resolve();
    }, 5_000).unref();
    proc.once("exit", () => {
      clearTimeout(t);
      resolve();
    });
  });
}

test.runIf(HAS_ENV)(
  "prod server: pnpm hermes-van:start serves /api/health, /sw.js, and 404s unknown paths",
  async () => {
    const port = 3500 + Math.floor(Math.random() * 500);
    const proc = spawn(
      "node",
      ["--env-file=.env", "--import", "tsx", "src/server/main.ts"],
      {
        env: {
          ...process.env,
          HERMES_VAN_PORT: String(port),
          // Quiet the logger so test output stays clean.
          HERMES_VAN_LOG_LEVEL: "warn",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    try {
      await waitForReady(port);

      // 1. /api/health — JSON shape, status 200.
      const health = await fetch(`http://127.0.0.1:${port}/api/health`);
      expect(health.status).toBe(200);
      const healthJson = (await health.json()) as { service: string; status: string };
      expect(healthJson.service).toBe("hermes-van");
      expect(["ok", "degraded"]).toContain(healthJson.status);

      // 2. /sw.js — must be served at root scope, content-type js,
      //    must contain push handler bits.
      const sw = await fetch(`http://127.0.0.1:${port}/sw.js`);
      expect(sw.status, "/sw.js must be reachable in production").toBe(200);
      expect(sw.headers.get("content-type") ?? "").toMatch(/javascript|text\/js/);
      const swBody = await sw.text();
      expect(swBody).toContain("addEventListener");
      expect(swBody).toContain("push");

      // 3. Security headers still applied to /api/health (regression).
      expect(health.headers.get("x-content-type-options")).toBe("nosniff");
      expect(health.headers.get("x-frame-options")).toBe("DENY");

      // 4. Unknown /api/* — 404, NOT served as SPA fallback.
      const unknownApi = await fetch(`http://127.0.0.1:${port}/api/does-not-exist`);
      expect(unknownApi.status).toBe(404);
    } finally {
      await killAndWait(proc);
    }
  },
  30_000,
);
