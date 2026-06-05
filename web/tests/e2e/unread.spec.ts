/**
 * Phase 3.D — unread badges for background chats.
 *
 * Verifies:
 *   1. A run completing in a background chat (i.e. user is looking at
 *      a different chat) bumps an unread badge on that row.
 *   2. Switching to that chat clears its badge.
 *   3. Document title reflects the total unread count.
 *   4. Active (focused) chat does NOT accumulate unread on its own runs.
 */
import { test, expect, type CDPSession, type Page } from "@playwright/test";
import { execSync } from "node:child_process";

const BASE_URL = "http://localhost:3015";
const FAST_PROMPT = 'Reply with exactly: ZULU. No punctuation.';

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
  const username = `unread_${Date.now()}`;
  await page.goto(`${BASE_URL}/setup`);
  await page.fill('input[type="password"]', setupToken);
  await page.fill('input[autocomplete="username"]', username);
  await page.fill('input[placeholder="Ivan"]', "Unread");
  await page.click('button[type="submit"]');
  await expect(page.locator("h1")).toContainText("Save these", { timeout: 15_000 });
  await page.click('button:has-text("I saved them, continue")');
  await page.waitForURL(/\/chat$/, { timeout: 5_000 });
}

test("unread badges: background chat completion bumps badge, focus clears it", async ({
  page,
  context,
}) => {
  test.setTimeout(120_000);
  page.on("pageerror", (err) => console.log(`[pageerror] ${err.message}`));

  const cdp = await context.newCDPSession(page);
  await registerAndLogin(page, cdp);

  // Create chat A and start a run there.
  await page.getByTestId("new-chat-btn").click();
  const rowA = page.locator('[data-testid^="chat-row-"]').first();
  await expect(rowA).toBeVisible();
  const idA = (await rowA.getAttribute("data-testid"))!.replace("chat-row-", "");

  const composer = page.getByTestId("composer-input");
  await composer.fill(FAST_PROMPT);
  await composer.press("Enter");
  await expect(page.getByTestId(`chat-live-${idA}`)).toBeVisible({ timeout: 5_000 });

  // Create chat B (steals focus) and start a run there too. While B is
  // focused, A should stream and complete in the background → unread+1.
  await page.getByTestId("new-chat-btn").click();
  await expect(page.locator('[data-testid^="chat-row-"]')).toHaveCount(2);
  // The new chat is at the top, so its id ≠ idA.
  const newRow = page
    .locator('[data-testid^="chat-row-"]')
    .filter({ hasNot: page.locator(`[data-testid="chat-row-${idA}"]`) });
  const idB = (await newRow.first().getAttribute("data-testid"))!.replace(
    "chat-row-",
    "",
  );
  expect(idB).not.toBe(idA);

  // While we're on chat B (focused), wait for A to finish in the background.
  // The live dot on A should hide and an unread badge should appear.
  await page
    .getByTestId(`chat-row-${idA}`)
    .locator(".live-dot")
    .waitFor({ state: "hidden", timeout: 60_000 });

  // Now an unread badge for A should be visible.
  const badgeA = page.getByTestId(`chat-unread-${idA}`);
  await expect(badgeA).toBeVisible({ timeout: 5_000 });
  await expect(badgeA).toHaveText("1");

  // Document title should reflect the unread count
  const title = await page.title();
  console.log(`[unread] document.title="${title}"`);
  expect(title).toMatch(/^\(1\)/);

  // Sanity: focused chat (B) has no badge for itself.
  await expect(page.getByTestId(`chat-unread-${idB}`)).toHaveCount(0);

  // Click chat A → badge should clear immediately.
  await page.getByTestId(`chat-row-${idA}`).click();
  await expect(page.getByTestId(`chat-unread-${idA}`)).toHaveCount(0, {
    timeout: 3_000,
  });

  // The assistant message should have ZULU now.
  const assistant = page.locator(`[data-role="assistant"]`).last();
  await expect(assistant).toHaveAttribute("data-status", "completed");
  const text = (await assistant.locator(".msg-body").innerText()).toUpperCase();
  expect(text).toContain("ZULU");

  // Title should clear
  await expect.poll(() => page.title(), { timeout: 3_000 }).toBe("hermes-van");
});
