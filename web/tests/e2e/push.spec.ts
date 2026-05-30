/**
 * Phase 5.D — Web Push routes + Settings UI.
 *
 * Headless Chromium does NOT have a real Push service, so we can't
 * exercise the full PushManager.subscribe() round-trip. What we *can*
 * verify end-to-end:
 *   1. Anon access to push routes is rejected (401).
 *   2. The public key endpoint returns the configured VAPID key.
 *   3. The subscribe endpoint accepts a synthetic subscription, persists
 *      it (visible via /api/push/test → sent count after sender mock).
 *   4. The Settings page renders the push section with status text and
 *      either an enable/disable button. We don't actually click subscribe
 *      because real Push service connectivity is out of scope.
 *   5. Sending a synthetic subscription with bogus endpoint and then
 *      hitting /api/push/test exercises the dispatch path (returns 200
 *      with sent/failed/removed counts; bogus endpoint usually fails
 *      immediately, count goes to failed or removed).
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

test("push: anon endpoints 401", async ({ request }) => {
  expect((await request.get(`${BASE_URL}/api/push/public-key`)).status()).toBe(401);
  expect(
    (
      await request.post(`${BASE_URL}/api/push/subscribe`, {
        data: {
          endpoint: "https://x.example/abc",
          keys: { p256dh: "p", auth: "a" },
        },
      })
    ).status(),
  ).toBe(401);
  expect((await request.post(`${BASE_URL}/api/push/test`)).status()).toBe(401);
});

test("push: public-key returns VAPID key when configured", async ({ page, context }) => {
  test.setTimeout(60_000);
  const cdp = await context.newCDPSession(page);
  await registerAndLogin(page, cdp, "pushkey");

  const data = await page.evaluate(async () => {
    const r = await fetch("/api/push/public-key", { credentials: "same-origin" });
    return { status: r.status, body: await r.json() };
  });
  expect(data.status).toBe(200);
  expect(typeof data.body.publicKey).toBe("string");
  expect(data.body.publicKey.length).toBeGreaterThan(40);
});

test("push: subscribe persists and dispatch reports counts", async ({ page, context }) => {
  test.setTimeout(60_000);
  const cdp = await context.newCDPSession(page);
  await registerAndLogin(page, cdp, "pushdisp");

  const subscribeResult = await page.evaluate(async () => {
    const csrf = document.cookie.match(/(?:^|;\s*)hv_csrf=([^;]+)/)?.[1] ?? "";
    const r = await fetch("/api/push/subscribe", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf },
      body: JSON.stringify({
        endpoint: "https://invalid.push.example.com/synthetic-test",
        keys: { p256dh: "BNc7" + "a".repeat(80), auth: "b".repeat(20) },
      }),
    });
    return { status: r.status, body: await r.json() };
  });
  expect(subscribeResult.status).toBe(200);
  expect(subscribeResult.body.ok).toBe(true);
  expect(subscribeResult.body.subscription.endpoint).toContain("invalid.push.example.com");

  // Trigger dispatch — bogus endpoint will fail to send. Either failed
  // or removed counter must move; sent must stay at 0.
  const dispatch = await page.evaluate(async () => {
    const csrf = document.cookie.match(/(?:^|;\s*)hv_csrf=([^;]+)/)?.[1] ?? "";
    const r = await fetch("/api/push/test", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf },
    });
    return { status: r.status, body: await r.json() };
  });
  expect(dispatch.status).toBe(200);
  expect(dispatch.body.ok).toBe(true);
  expect(dispatch.body.sent).toBe(0);
  // Either bumps fail counter or removes the subscription depending on
  // what the underlying network error class is. Just ensure something
  // happened.
  expect(dispatch.body.failed + dispatch.body.removed).toBeGreaterThanOrEqual(1);

  // Unsubscribe should clean up.
  const unsub = await page.evaluate(async () => {
    const csrf = document.cookie.match(/(?:^|;\s*)hv_csrf=([^;]+)/)?.[1] ?? "";
    const r = await fetch("/api/push/unsubscribe", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf },
      body: JSON.stringify({
        endpoint: "https://invalid.push.example.com/synthetic-test",
      }),
    });
    return r.status;
  });
  expect(unsub).toBe(200);
});

test("push: settings page renders push section", async ({ page, context }) => {
  test.setTimeout(60_000);
  const cdp = await context.newCDPSession(page);
  await registerAndLogin(page, cdp, "pushui");

  await page.goto(`${BASE_URL}/settings`);
  await expect(page.getByTestId("push-section")).toBeVisible();
  await expect(page.getByTestId("push-status")).toBeVisible();

  // Status will be one of: off (Chromium supports the API), unsupported,
  // disabled. Headless Chromium does have ServiceWorker + PushManager,
  // so we expect "off" with VAPID configured.
  const statusText = (await page.getByTestId("push-status").textContent())?.trim();
  expect(statusText).toMatch(/^(off|on|unsupported|disabled|denied|loading)$/);
  // With VAPID configured server-side, we should NOT land on "disabled".
  expect(statusText).not.toBe("disabled");
});
