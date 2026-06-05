/**
 * Phase 3.C — reconnect to a live run after page reload.
 *
 * Flow:
 *   1. Register and create a chat.
 *   2. Send a SLOW prompt that takes long enough that we can reload
 *      mid-stream (asks the agent to count to 20 with explanations).
 *   3. Reload the browser as soon as we see the streaming placeholder.
 *   4. After reload, the chat should be auto-selected, the assistant
 *      message should resume streaming via /api/chats/:id/active-run +
 *      a fresh EventSource, and finalize with the expected content.
 *
 * The whole point is that the agent lives in the gateway, so even if
 * the EventSource was torn down by the reload, the run keeps running
 * server-side and the new tab rejoins.
 */
import { test, expect, type CDPSession, type Page } from "@playwright/test";
import { execSync } from "node:child_process";

const BASE_URL = "http://localhost:3015";
const SLOW_PROMPT =
  'Count slowly from 1 to 15. Put each number on its own line, nothing else. No code blocks.';

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
  const username = `reconnect_${Date.now()}`;
  await page.goto(`${BASE_URL}/setup`);
  await page.fill('input[type="password"]', setupToken);
  await page.fill('input[autocomplete="username"]', username);
  await page.fill('input[placeholder="Ivan"]', "Reconnect");
  await page.click('button[type="submit"]');
  await expect(page.locator("h1")).toContainText("Save these", { timeout: 15_000 });
  await page.click('button:has-text("I saved them, continue")');
  await page.waitForURL(/\/chat$/, { timeout: 5_000 });
}

test("reconnect: page reload mid-stream rejoins the live run", async ({
  page,
  context,
}) => {
  test.setTimeout(180_000);
  page.on("pageerror", (err) => console.log(`[pageerror] ${err.message}`));

  const cdp = await context.newCDPSession(page);
  await registerAndLogin(page, cdp);

  // Create chat and start a slow prompt
  await page.getByTestId("new-chat-btn").click();
  const row = page.locator('[data-testid^="chat-row-"]').first();
  await expect(row).toBeVisible({ timeout: 5_000 });
  const chatId = (await row.getAttribute("data-testid"))!.replace("chat-row-", "");

  const composer = page.getByTestId("composer-input");
  await composer.fill(SLOW_PROMPT);
  await composer.press("Enter");

  // Confirm we're streaming before reload
  await expect(
    page.locator(`[data-role="assistant"][data-status="streaming"]`),
  ).toBeVisible({ timeout: 5_000 });
  await expect(page.getByTestId(`chat-live-${chatId}`)).toBeVisible();

  // Reload — drops the EventSource client-side, but the run keeps
  // running on the gateway.
  await page.reload();

  // After reload, the same chat should be auto-selected (first in the
  // sidebar) and the assistant message should resume streaming.
  await expect(page.getByTestId(`chat-row-${chatId}`)).toBeVisible({
    timeout: 5_000,
  });

  // The live dot should reappear thanks to reconnectIfLive() probing
  // /api/chats/:id/active-run.
  await expect(page.getByTestId(`chat-live-${chatId}`)).toBeVisible({
    timeout: 8_000,
  });

  // Wait for the run to finalize. We give it generous headroom because
  // the agent has to actually finish the work.
  await page
    .getByTestId(`chat-row-${chatId}`)
    .locator(".live-dot")
    .waitFor({ state: "hidden", timeout: 120_000 });

  // Inspect the finalized assistant message.
  const assistant = page.locator(`[data-role="assistant"]`).last();
  await expect(assistant).toHaveAttribute("data-status", "completed", {
    timeout: 10_000,
  });
  const text = (await assistant.locator(".msg-body").innerText()).toLowerCase();
  console.log(`[reconnect] final assistant text:\n${text}`);

  // Should mention the start and end of the count.
  expect(text).toMatch(/1|one/);
  expect(text).toMatch(/15|fifteen/);
});
