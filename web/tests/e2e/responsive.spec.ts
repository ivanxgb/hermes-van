/**
 * Phase 5.A — mobile responsive + shortcuts overlay.
 *
 * Verifies:
 *   1. On a phone-sized viewport, the sidebar is hidden by default and a
 *      hamburger button is visible.
 *   2. Tapping the hamburger slides the sidebar in.
 *   3. Tapping a chat row closes the sidebar (mobile drawer dismiss).
 *   4. Tapping the backdrop closes the sidebar.
 *   5. Esc closes the sidebar before doing anything else.
 *   6. The "?" key opens the shortcuts overlay; Esc closes it.
 *   7. Cmd+/ also toggles the shortcuts overlay.
 *   8. On a desktop viewport the hamburger is hidden and the sidebar is
 *      always visible (no drawer behavior).
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

test("mobile drawer: hamburger toggles sidebar, row tap dismisses", async ({ page, context }) => {
  test.setTimeout(60_000);
  page.on("pageerror", (err) => console.log(`[pageerror] ${err.message}`));

  await page.setViewportSize({ width: 390, height: 844 }); // iPhone 14 size
  const cdp = await context.newCDPSession(page);
  await registerAndLogin(page, cdp, "mobile");

  // Create a chat so we have something to render the chat-head with hamburger
  await page.evaluate(async () => {
    const csrf = document.cookie.match(/(?:^|;\s*)hv_csrf=([^;]+)/)?.[1] ?? "";
    await fetch("/api/chats", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf },
      body: JSON.stringify({ title: "Mobile Test" }),
      credentials: "same-origin",
    });
  });
  await page.reload();

  // Hamburger is visible on mobile
  const hamburger = page.getByTestId("hamburger-btn").first();
  await expect(hamburger).toBeVisible();

  // Sidebar is off-screen initially. Check transform-based hiding by
  // querying the bounding box: a translateX(-100%) sidebar has its right
  // edge at x=0 or less.
  const shellState1 = await page.evaluate(() => {
    return document.querySelector(".chat-shell")?.classList.contains("sidebar-open");
  });
  expect(shellState1).toBe(false);

  // Open
  await hamburger.click();
  const shellState2 = await page.evaluate(() => {
    return document.querySelector(".chat-shell")?.classList.contains("sidebar-open");
  });
  expect(shellState2).toBe(true);

  // Tap chat row → should close drawer + select
  const row = page.locator('[data-testid^="chat-row-"]').first();
  await row.click();
  // Wait one frame for state to flush
  await page.waitForTimeout(100);
  const shellState3 = await page.evaluate(() => {
    return document.querySelector(".chat-shell")?.classList.contains("sidebar-open");
  });
  expect(shellState3).toBe(false);

  // Open again, click backdrop. The sidebar covers ~85vw on the left,
  // so we click on the right edge where the backdrop is exposed.
  await hamburger.click();
  await expect(
    page.locator(".chat-shell.sidebar-open .sidebar-backdrop"),
  ).toBeVisible();
  await page.mouse.click(380, 400);
  await page.waitForTimeout(150);
  const shellState4 = await page.evaluate(() => {
    return document.querySelector(".chat-shell")?.classList.contains("sidebar-open");
  });
  expect(shellState4).toBe(false);

  // Open again, press Esc
  await hamburger.click();
  await page.keyboard.press("Escape");
  await page.waitForTimeout(100);
  const shellState5 = await page.evaluate(() => {
    return document.querySelector(".chat-shell")?.classList.contains("sidebar-open");
  });
  expect(shellState5).toBe(false);
});

test("shortcuts overlay: ? opens, Esc closes, Cmd+/ toggles", async ({ page, context }) => {
  test.setTimeout(60_000);
  page.on("pageerror", (err) => console.log(`[pageerror] ${err.message}`));

  await page.setViewportSize({ width: 1280, height: 900 });
  const cdp = await context.newCDPSession(page);
  await registerAndLogin(page, cdp, "shortcuts");

  // ? opens the overlay (must not be in a field — focus body explicitly)
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press("Shift+/"); // produces "?" on US layouts
  await expect(page.getByTestId("shortcuts-overlay")).toBeVisible();
  await expect(page.locator(".shortcuts-list li")).toHaveCount(7);

  // Esc closes
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("shortcuts-overlay")).not.toBeVisible();

  // Cmd+/ toggles open
  await page.keyboard.press("Meta+/");
  await expect(page.getByTestId("shortcuts-overlay")).toBeVisible();

  // Cmd+/ toggles close
  await page.keyboard.press("Meta+/");
  await expect(page.getByTestId("shortcuts-overlay")).not.toBeVisible();
});

test("desktop layout: hamburger hidden, sidebar always visible", async ({ page, context }) => {
  test.setTimeout(60_000);
  page.on("pageerror", (err) => console.log(`[pageerror] ${err.message}`));

  await page.setViewportSize({ width: 1280, height: 900 });
  const cdp = await context.newCDPSession(page);
  await registerAndLogin(page, cdp, "desktop");

  await expect(page.getByTestId("chat-sidebar")).toBeVisible();

  // The hamburger element exists in the DOM (chat-head still renders one
  // when there's a selected chat) but CSS hides it on >768px viewports.
  // The empty-state hamburger is always in the DOM but hidden by CSS.
  // We check computed display.
  const hamburgerDisplay = await page.evaluate(() => {
    const btn = document.querySelector('[data-testid="hamburger-btn"]');
    if (!btn) return "missing";
    return window.getComputedStyle(btn).display;
  });
  expect(hamburgerDisplay).toBe("none");
});
