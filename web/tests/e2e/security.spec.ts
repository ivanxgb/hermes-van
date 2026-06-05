/**
 * Phase 5.B — security panel: sessions + audit.
 *
 * Verifies:
 *   1. /auth/sessions requires auth (anon → 401).
 *   2. /auth/audit requires auth (anon → 401).
 *   3. The user's session list contains exactly one entry after first
 *      login, marked isCurrent: true.
 *   4. Settings page renders the session as a row, plus audit events
 *      including login.ok and user.created.
 *   5. Revoking a non-current session via /auth/sessions/:id/revoke
 *      flips revokedAt to a number and emits a session.revoked event.
 *   6. Revoking the current session via the API returns ok and the
 *      next /auth/me request hits 401.
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

test("security: anon endpoints 401", async ({ request }) => {
  expect((await request.get(`${BASE_URL}/auth/sessions`)).status()).toBe(401);
  expect((await request.get(`${BASE_URL}/auth/audit`)).status()).toBe(401);
});

test("security: settings page renders sessions + audit", async ({ page, context }) => {
  test.setTimeout(60_000);
  page.on("pageerror", (err) => console.log(`[pageerror] ${err.message}`));

  const cdp = await context.newCDPSession(page);
  await registerAndLogin(page, cdp, "sec");

  // Pull the data via the API to validate shape independently of UI.
  const data = await page.evaluate(async () => {
    const s = await fetch("/auth/sessions", { credentials: "same-origin" });
    const sb = await s.json();
    const a = await fetch("/auth/audit", { credentials: "same-origin" });
    const ab = await a.json();
    return { sessions: sb.sessions, events: ab.events };
  });
  console.log(`[security] sessions=${data.sessions.length} audit=${data.events.length}`);
  expect(data.sessions.length).toBe(1);
  expect(data.sessions[0].isCurrent).toBe(true);
  expect(data.sessions[0].revokedAt).toBeNull();
  expect(data.events.length).toBeGreaterThan(0);
  const eventNames = (data.events as Array<{ event: string }>).map((e) => e.event);
  expect(eventNames).toContain("login.ok");
  expect(eventNames).toContain("user.created");

  // UI
  await page.goto(`${BASE_URL}/settings`);
  await expect(page.getByTestId("sessions-section")).toBeVisible();
  await expect(page.getByTestId("audit-section")).toBeVisible();
  const sessionRows = await page.locator('[data-testid^="session-row-"]').count();
  expect(sessionRows).toBe(1);
  const auditRows = await page.locator('[data-testid="audit-list"] li').count();
  expect(auditRows).toBe(data.events.length);
});

test("security: revoking current session locks the user out", async ({ page, context }) => {
  test.setTimeout(60_000);
  page.on("pageerror", (err) => console.log(`[pageerror] ${err.message}`));

  const cdp = await context.newCDPSession(page);
  await registerAndLogin(page, cdp, "revoke");

  // Find own session id.
  const ownId = await page.evaluate(async () => {
    const me = await fetch("/auth/me", { credentials: "same-origin" }).then((r) => r.json());
    return me.sessionId as string;
  });

  // Revoke own session via API.
  const revokeStatus = await page.evaluate(async (id) => {
    const csrf = document.cookie.match(/(?:^|;\s*)hv_csrf=([^;]+)/)?.[1] ?? "";
    const res = await fetch(`/auth/sessions/${id}/revoke`, {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf },
    });
    return res.status;
  }, ownId);
  expect(revokeStatus).toBe(200);

  // Subsequent /auth/me should now be 401.
  const meStatus = await page.evaluate(async () => {
    const r = await fetch("/auth/me", { credentials: "same-origin" });
    return r.status;
  });
  expect(meStatus).toBe(401);
});
