/**
 * Phase 3.A — multi-chat streaming.
 *
 * Verifies that:
 *  1. Two chats can stream concurrently.
 *  2. Switching chats while one is streaming does NOT abort the stream.
 *  3. The sidebar renders a live indicator for the streaming chat.
 *  4. Both messages eventually finalize with the expected content.
 */
import { test, expect, type CDPSession, type Page } from "@playwright/test";
import { execSync } from "node:child_process";

const BASE_URL = "http://localhost:3015";
// A prompt long enough that the model takes more than a single delta to
// finish, so we have time to switch chats while the first run is alive.
const SLOW_PROMPT_A =
  'Slowly count from one to five, in english, one number per line. Just numbers, no other words.';
const SLOW_PROMPT_B = 'Reply with exactly: APPLE BANANA CHERRY (in caps).';

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
  const username = `multi_${Date.now()}`;
  await page.goto(`${BASE_URL}/setup`);
  await page.fill('input[type="password"]', setupToken);
  await page.fill('input[autocomplete="username"]', username);
  await page.fill('input[placeholder="Ivan"]', "Multi");
  await page.click('button[type="submit"]');
  await expect(page.locator("h1")).toContainText("Save these", { timeout: 15_000 });
  await page.click('button:has-text("I saved them, continue")');
  await page.waitForURL(/\/chat$/, { timeout: 5_000 });
}

test("multi-chat: streams survive tab switching", async ({ page, context }) => {
  test.setTimeout(180_000);

  page.on("pageerror", (err) => console.log(`[pageerror] ${err.message}`));

  const cdp = await context.newCDPSession(page);
  await registerAndLogin(page, cdp);

  // Create chat A and send a long-ish prompt
  await page.getByTestId("new-chat-btn").click();
  const rowA = page.locator('[data-testid^="chat-row-"]').first();
  await expect(rowA).toBeVisible();
  const idA = (await rowA.getAttribute("data-testid"))!.replace("chat-row-", "");

  const composer = page.getByTestId("composer-input");
  await composer.fill(SLOW_PROMPT_A);
  await composer.press("Enter");

  // Confirm the assistant placeholder is streaming and the live dot is visible.
  await expect(
    page.locator(`[data-testid^="msg-"][data-role="assistant"][data-status="streaming"]`),
  ).toBeVisible({ timeout: 5_000 });
  await expect(page.getByTestId(`chat-live-${idA}`)).toBeVisible({ timeout: 5_000 });

  // Create chat B
  await page.getByTestId("new-chat-btn").click();
  const rows = page.locator('[data-testid^="chat-row-"]');
  await expect(rows).toHaveCount(2);
  const idB = (await rows.first().getAttribute("data-testid"))!.replace("chat-row-", "");
  expect(idB).not.toBe(idA);

  // Chat A's run should still be live in the sidebar even though we're in B.
  await expect(page.getByTestId(`chat-live-${idA}`)).toBeVisible();

  // Send a fast prompt in chat B — should run alongside A.
  await composer.fill(SLOW_PROMPT_B);
  await composer.press("Enter");
  await expect(page.getByTestId(`chat-live-${idB}`)).toBeVisible({ timeout: 5_000 });

  // Wait for B to complete first (shorter prompt)
  await page
    .getByTestId(`chat-row-${idB}`)
    .locator(".live-dot")
    .waitFor({ state: "hidden", timeout: 90_000 });

  // Switch to chat A and verify it's still streaming OR has finalized
  await page.getByTestId(`chat-row-${idA}`).click();
  await expect(page.getByTestId("active-chat-title")).toBeVisible();

  // Wait for A's run to finalize
  await page
    .getByTestId(`chat-row-${idA}`)
    .locator(".live-dot")
    .waitFor({ state: "hidden", timeout: 90_000 });

  // Both chats should have a completed assistant message.
  const aAssistant = page.locator(
    `[data-role="assistant"][data-status="completed"]`,
  );
  await expect(aAssistant).toBeVisible({ timeout: 10_000 });
  const aText = (await aAssistant.locator(".msg-body").innerText()).toLowerCase();
  console.log(`[A] assistant text:\n${aText}`);
  // Counting prompt — the model output should mention at least 'one' and 'five'
  expect(aText).toMatch(/one|1/);
  expect(aText).toMatch(/five|5/);

  // Switch to B and check
  await page.getByTestId(`chat-row-${idB}`).click();
  const bAssistant = page.locator(
    `[data-role="assistant"][data-status="completed"]`,
  );
  await expect(bAssistant).toBeVisible({ timeout: 10_000 });
  const bText = (await bAssistant.locator(".msg-body").innerText()).toUpperCase();
  console.log(`[B] assistant text: "${bText}"`);
  expect(bText).toContain("APPLE");
  expect(bText).toContain("BANANA");
  expect(bText).toContain("CHERRY");
});
