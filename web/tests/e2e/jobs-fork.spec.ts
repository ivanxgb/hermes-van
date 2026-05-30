/**
 * Phase 4.E + 4.F — jobs browser + chat fork.
 *
 * jobs:
 *   1. /api/gateway/jobs requires auth (anonymous → 401).
 *   2. Authed proxy returns { jobs: [...] } with at least one real job
 *      (the user's "Bounty Scout Solver" cron is currently scheduled on
 *      this gateway, so the count must be > 0).
 *   3. Prompt is trimmed to prompt_preview ≤ 200 chars (avoids leaking
 *      full prompt text into the listing).
 *   4. /jobs page renders the job cards with name + schedule.
 *
 * fork:
 *   5. POST /api/gateway/chats/:id/fork creates a new local chat with
 *      gatewaySessionId different from the source.
 *   6. Source chat is unaffected.
 *   7. Anonymous fork → 401.
 *   8. Fork on unknown id → 404.
 */
import { test, expect, type CDPSession, type Page } from "@playwright/test";
import { execSync } from "node:child_process";

const BASE_URL = "http://localhost:3015";

function freshBootstrapToken(): string {
  const out = execSync("pnpm --silent hermes-van:bootstrap", {
    cwd: process.cwd(),
    encoding: "utf8",
    env: { ...process.env, NODE_ENV: "development" },
  });
  const match = out.match(/Token\s*:\s*(\S+)/);
  if (!match) throw new Error(`Could not parse bootstrap token:\n${out}`);
  return match[1]!;
}

async function attachVirtualAuthenticator(client: CDPSession): Promise<void> {
  await client.send("WebAuthn.enable", { enableUI: false });
  await client.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
}

async function registerAndLogin(page: Page, cdp: CDPSession, prefix: string): Promise<void> {
  const setupToken = freshBootstrapToken();
  await attachVirtualAuthenticator(cdp);
  const username = `${prefix}_${Date.now()}`;
  await page.goto(`${BASE_URL}/setup`);
  await page.fill('input[type="password"]', setupToken);
  await page.fill('input[autocomplete="username"]', username);
  await page.fill('input[placeholder="Ivan"]', "Test");
  await page.click('button[type="submit"]');
  await expect(page.locator("h1")).toContainText("Save these", { timeout: 15_000 });
  await page.click('button:has-text("I saved them, continue")');
  await page.waitForURL(/\/chat$/, { timeout: 5_000 });
}

test("jobs: anonymous proxy 401", async ({ request }) => {
  const r = await request.get(`${BASE_URL}/api/gateway/jobs`);
  expect(r.status()).toBe(401);
});

test("jobs: proxy returns real jobs and UI renders them", async ({ page, context }) => {
  test.setTimeout(60_000);
  page.on("pageerror", (err) => console.log(`[pageerror] ${err.message}`));

  const cdp = await context.newCDPSession(page);
  await registerAndLogin(page, cdp, "jobs");

  const proxyResult = await page.evaluate(async () => {
    const res = await fetch("/api/gateway/jobs", { credentials: "same-origin" });
    return { status: res.status, body: await res.json() };
  });
  console.log(`[jobs] count=${proxyResult.body.jobs?.length}`);
  expect(proxyResult.status).toBe(200);
  expect(Array.isArray(proxyResult.body.jobs)).toBe(true);
  expect(proxyResult.body.jobs.length).toBeGreaterThan(0);

  // prompt is either short or trimmed to prompt_preview
  for (const j of proxyResult.body.jobs) {
    if (j.prompt) expect(j.prompt.length).toBeLessThanOrEqual(200);
    if (j.prompt_preview) expect(j.prompt_preview.length).toBeLessThanOrEqual(200);
  }

  // UI navigation
  await page.click('[data-testid="nav-jobs"]');
  await page.waitForURL(/\/jobs$/, { timeout: 5_000 });
  await expect(page.getByTestId("jobs-page")).toBeVisible();
  await expect(page.getByTestId("jobs-list")).toBeVisible();
  const items = await page.locator('[data-testid="jobs-list"] .cap-item').count();
  expect(items).toBeGreaterThan(0);
});

test("fork: anonymous fork 401", async ({ request }) => {
  const r = await request.post(`${BASE_URL}/api/gateway/chats/01HBOGUS00/fork`);
  // 401 unauth or 403 csrf — both indicate auth-blocked
  expect([401, 403]).toContain(r.status());
});

test("fork: authenticated fork creates a new chat with a distinct session id", async ({
  page,
  context,
}) => {
  test.setTimeout(90_000);
  page.on("pageerror", (err) => console.log(`[pageerror] ${err.message}`));

  const cdp = await context.newCDPSession(page);
  await registerAndLogin(page, cdp, "fork");

  // Create a source chat
  const srcId = await page.evaluate(async () => {
    const csrf = document.cookie.match(/(?:^|;\s*)hv_csrf=([^;]+)/)?.[1] ?? "";
    const headers = { "Content-Type": "application/json", "X-CSRF-Token": csrf };
    const res = await fetch("/api/chats", {
      method: "POST",
      headers,
      body: JSON.stringify({ title: "Fork Source" }),
      credentials: "same-origin",
    });
    const j = await res.json();
    return j.chat.id as string;
  });
  expect(srcId).toBeTruthy();

  // The upstream gateway only knows about a session after the first run
  // touches it. Send one message and wait for it to finalize before
  // attempting the fork — otherwise the fork lookup hits a session id
  // that doesn't exist upstream and the gateway returns 404 (which we
  // surface as 502).
  await page.reload();
  const composer = page.getByTestId("composer-input");
  await composer.fill("Reply with PONG and nothing else.");
  await composer.press("Enter");
  await expect(page.locator('[data-role="assistant"]').last()).toHaveAttribute(
    "data-status",
    "completed",
    { timeout: 60_000 },
  );

  // Fork the chat through the API directly
  const forkResult = await page.evaluate(async (id) => {
    const csrf = document.cookie.match(/(?:^|;\s*)hv_csrf=([^;]+)/)?.[1] ?? "";
    const res = await fetch(`/api/gateway/chats/${id}/fork`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf },
      credentials: "same-origin",
    });
    return { status: res.status, body: await res.json() };
  }, srcId);

  console.log(`[fork] response status=${forkResult.status}`);
  console.log(`[fork] body keys=${Object.keys(forkResult.body).join(",")}`);
  expect(forkResult.status).toBe(201);
  expect(forkResult.body.chat).toBeTruthy();
  expect(forkResult.body.chat.id).not.toBe(srcId);
  expect(forkResult.body.chat.title).toMatch(/\(fork\)$/);
  expect(forkResult.body.upstreamSession).toBeTruthy();
  expect(forkResult.body.upstreamSession.id).toBeTruthy();

  // Verify both chats exist in the user's listing
  const list = await page.evaluate(async () => {
    const res = await fetch("/api/chats", { credentials: "same-origin" });
    return await res.json();
  });
  const ids = (list.chats as Array<{ id: string }>).map((c) => c.id);
  expect(ids).toContain(srcId);
  expect(ids).toContain(forkResult.body.chat.id);

  // Fork unknown id → 404
  const notFound = await page.evaluate(async () => {
    const csrf = document.cookie.match(/(?:^|;\s*)hv_csrf=([^;]+)/)?.[1] ?? "";
    const res = await fetch("/api/gateway/chats/01HDOESNOTEXIST00000/fork", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf },
      credentials: "same-origin",
    });
    return res.status;
  });
  expect(notFound).toBe(404);
});
