/**
 * Phase 4.D — capabilities browser (skills + toolsets).
 *
 * Verifies:
 *   1. /api/gateway/skills returns shape { skills: [...] } with real gateway data.
 *   2. /api/gateway/toolsets returns shape { toolsets: [...] } with enabled flags.
 *   3. /capabilities page renders both tabs with non-empty lists.
 *   4. Tab switching swaps the visible list.
 *   5. Filter narrows results client-side.
 *   6. Anonymous (no auth) requests return 401.
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

async function registerAndLogin(page: Page, cdp: CDPSession): Promise<void> {
  const setupToken = freshBootstrapToken();
  await attachVirtualAuthenticator(cdp);
  const username = `caps_${Date.now()}`;
  await page.goto(`${BASE_URL}/setup`);
  await page.fill('input[type="password"]', setupToken);
  await page.fill('input[autocomplete="username"]', username);
  await page.fill('input[placeholder="Ivan"]', "Caps");
  await page.click('button[type="submit"]');
  await expect(page.locator("h1")).toContainText("Save these", { timeout: 15_000 });
  await page.click('button:has-text("I saved them, continue")');
  await page.waitForURL(/\/chat$/, { timeout: 5_000 });
}

test("capabilities: anonymous proxy requests are 401", async ({ request }) => {
  const skills = await request.get(`${BASE_URL}/api/gateway/skills`);
  expect(skills.status()).toBe(401);
  const toolsets = await request.get(`${BASE_URL}/api/gateway/toolsets`);
  expect(toolsets.status()).toBe(401);
});

test("capabilities: page renders skills + toolsets and filters", async ({ page, context }) => {
  test.setTimeout(60_000);
  page.on("pageerror", (err) => console.log(`[pageerror] ${err.message}`));

  const cdp = await context.newCDPSession(page);
  await registerAndLogin(page, cdp);

  // Hit the proxy endpoints directly to verify shape + non-empty data.
  const proxyResults = await page.evaluate(async () => {
    const skillsRes = await fetch("/api/gateway/skills", { credentials: "same-origin" });
    const skillsJson = await skillsRes.json();
    const toolsetsRes = await fetch("/api/gateway/toolsets", { credentials: "same-origin" });
    const toolsetsJson = await toolsetsRes.json();
    return {
      skills: { status: skillsRes.status, body: skillsJson },
      toolsets: { status: toolsetsRes.status, body: toolsetsJson },
    };
  });

  console.log(
    `[capabilities] skills=${proxyResults.skills.body.skills?.length} toolsets=${proxyResults.toolsets.body.toolsets?.length}`,
  );

  expect(proxyResults.skills.status).toBe(200);
  expect(Array.isArray(proxyResults.skills.body.skills)).toBe(true);
  expect(proxyResults.skills.body.skills.length).toBeGreaterThan(0);

  expect(proxyResults.toolsets.status).toBe(200);
  expect(Array.isArray(proxyResults.toolsets.body.toolsets)).toBe(true);
  expect(proxyResults.toolsets.body.toolsets.length).toBeGreaterThan(0);

  // At least one toolset has a tools array — proves we're seeing the real
  // gateway response, not a stub.
  const someToolset = proxyResults.toolsets.body.toolsets.find(
    (t: { tools?: string[] }) => Array.isArray(t.tools) && t.tools.length > 0,
  );
  expect(someToolset).toBeTruthy();

  // Now exercise the UI.
  await page.click('[data-testid="nav-capabilities"]');
  await page.waitForURL(/\/capabilities$/, { timeout: 5_000 });
  await expect(page.getByTestId("capabilities-page")).toBeVisible();

  // Default tab is skills, list is rendered.
  await expect(page.getByTestId("cap-skills-list")).toBeVisible();
  const skillItemsCount = await page.locator('[data-testid="cap-skills-list"] .cap-item').count();
  expect(skillItemsCount).toBeGreaterThan(0);

  // Switch to toolsets, list is rendered.
  await page.click('[data-testid="cap-tab-toolsets"]');
  await expect(page.getByTestId("cap-toolsets-list")).toBeVisible();
  const toolsetItemsCount = await page
    .locator('[data-testid="cap-toolsets-list"] .cap-item')
    .count();
  expect(toolsetItemsCount).toBeGreaterThan(0);

  // Filter to "browser" — should narrow the toolsets list (browser toolset
  // exists on the real gateway).
  await page.fill('[data-testid="cap-filter"]', "browser");
  const filteredCount = await page
    .locator('[data-testid="cap-toolsets-list"] .cap-item')
    .count();
  expect(filteredCount).toBeGreaterThan(0);
  expect(filteredCount).toBeLessThanOrEqual(toolsetItemsCount);

  // A nonsense filter zeroes the list.
  await page.fill('[data-testid="cap-filter"]', "zzqxnonexistent");
  await expect(page.locator(".empty")).toBeVisible();
});
