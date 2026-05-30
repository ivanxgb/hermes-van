/**
 * End-to-end auth flow with a Chromium virtual authenticator (CDP-driven).
 *
 * Real flow exercised against a live server:
 *   1. Issue a fresh bootstrap token via `pnpm hermes-van:bootstrap`.
 *   2. Visit /setup, fill form, register a passkey through a CDP
 *      virtual authenticator (UV=true, residentKey=true).
 *   3. Read recovery codes shown after registration.
 *   4. Verify /auth/me returns the new user.
 *   5. Log out → /login.
 *   6. Log in again with the same virtual authenticator.
 *   7. Verify /auth/me again, then exercise /api/health.
 *
 * No unit-test substitutes: this test drives the real Hono server, real
 * SQLCipher DB, real WebAuthn ceremony, real cookies.
 */
import { test, expect, type CDPSession } from "@playwright/test";
import { execSync } from "node:child_process";

const BASE_URL = "http://localhost:3015";

function freshBootstrapToken(): string {
  const out = execSync("pnpm --silent hermes-van:bootstrap", {
    cwd: process.cwd(),
    encoding: "utf8",
    env: { ...process.env, NODE_ENV: "development" },
  });
  // Match: "Token       : <token>" line
  const match = out.match(/Token\s*:\s*(\S+)/);
  if (!match) throw new Error(`Could not parse bootstrap token from CLI output:\n${out}`);
  return match[1]!;
}

async function attachVirtualAuthenticator(client: CDPSession): Promise<string> {
  await client.send("WebAuthn.enable", { enableUI: false });
  const { authenticatorId } = await client.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
  return authenticatorId;
}

const TEST_USERNAME = `e2e_user_${Date.now()}`;
const TEST_DISPLAY_NAME = "E2E Tester";

test("full auth flow: bootstrap → setup → logout → login (real WebAuthn)", async ({
  page,
  context,
  request,
}) => {
  test.setTimeout(60_000);

  // Surface client-side errors so we can debug failed flows
  page.on("console", (msg) => {
    if (msg.type() === "error" || msg.type() === "warning") {
      console.log(`[browser ${msg.type()}] ${msg.text()}`);
    }
  });
  page.on("pageerror", (err) => console.log(`[pageerror] ${err.message}`));
  page.on("requestfailed", (req) =>
    console.log(`[reqfail] ${req.method()} ${req.url()} — ${req.failure()?.errorText}`),
  );

  // 1. Provision bootstrap token from the live CLI
  const setupToken = freshBootstrapToken();
  expect(setupToken.length).toBeGreaterThanOrEqual(20);

  // 2. Attach a virtual authenticator with UV satisfied
  const cdp = await context.newCDPSession(page);
  const authenticatorId = await attachVirtualAuthenticator(cdp);
  expect(authenticatorId).toBeTruthy();

  // 3. Setup page — register first user (use localhost so origin matches RP_ID)
  await page.goto(`${BASE_URL}/setup`);
  await expect(page.locator("h1")).toContainText("first passkey");

  await page.fill('input[type="password"]', setupToken);
  await page.fill('input[autocomplete="username"]', TEST_USERNAME);
  await page.fill('input[placeholder="Ivan"]', TEST_DISPLAY_NAME);

  await page.click('button[type="submit"]');

  // If an error surfaces in the form, dump it before the next assertion times out.
  const errorLocator = page.locator("div.error");
  try {
    await errorLocator.waitFor({ state: "visible", timeout: 3_000 });
    const errMsg = await errorLocator.innerText();
    throw new Error(`Setup form errored: ${errMsg}`);
  } catch (waitErr) {
    if (waitErr instanceof Error && waitErr.message.startsWith("Setup form errored")) {
      throw waitErr;
    }
    // No visible error — happy path, continue
  }

  // 4. Wait for recovery codes screen — proves registration succeeded
  await expect(page.locator("h1")).toContainText("Save these", { timeout: 15_000 });
  const codesText = await page.locator("pre.codes").innerText();
  const codes = codesText.split(/\s+/).filter(Boolean);
  expect(codes.length).toBeGreaterThanOrEqual(8);
  expect(codes.length).toBeLessThanOrEqual(12);

  // 5. Continue → /chat (auto-logged in)
  await page.click('button:has-text("I saved them, continue")');
  await page.waitForURL(/\/chat$/, { timeout: 5_000 });

  // 6. /auth/me must report the new user (cookies attached automatically)
  const meAfterSetup = await page.evaluate(async () => {
    const res = await fetch("/auth/me", { credentials: "same-origin" });
    return { status: res.status, body: await res.json() };
  });
  expect(meAfterSetup.status).toBe(200);
  expect(meAfterSetup.body.username).toBe(TEST_USERNAME);

  // 7. Sanity — gateway probe still works while authed
  const health = await request.get("/api/health");
  expect(health.status()).toBe(200);
  const healthBody = await health.json();
  expect(healthBody.gateway.ok).toBe(true);

  // 8. Log out via the API (CSRF-protected) — read cookie, attach header
  const logoutStatus = await page.evaluate(async () => {
    const csrf = document.cookie.match(/(?:^|;\s*)hv_csrf=([^;]+)/)?.[1];
    const res = await fetch("/auth/logout", {
      method: "POST",
      headers: csrf ? { "X-CSRF-Token": csrf } : {},
      credentials: "same-origin",
    });
    return res.status;
  });
  expect(logoutStatus).toBe(200);

  // 9. Now /auth/me should be 401
  const meAfterLogout = await page.evaluate(async () => {
    const res = await fetch("/auth/me", { credentials: "same-origin" });
    return res.status;
  });
  expect(meAfterLogout).toBe(401);

  // 10. Re-login through the UI with the same virtual authenticator
  await page.goto(`${BASE_URL}/login`);
  await expect(page.locator("h1")).toContainText("Welcome back");
  await page.fill('input[autocomplete="username webauthn"]', TEST_USERNAME);
  await page.click('button:has-text("Sign in with passkey")');

  // We should land on /chat
  await page.waitForURL(/\/chat$/, { timeout: 15_000 });

  const meAfterLogin = await page.evaluate(async () => {
    const res = await fetch("/auth/me", { credentials: "same-origin" });
    return { status: res.status, body: await res.json() };
  });
  expect(meAfterLogin.status).toBe(200);
  expect(meAfterLogin.body.username).toBe(TEST_USERNAME);
});
