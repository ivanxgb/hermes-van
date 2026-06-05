/**
 * Phase 2.D — full UI flow e2e.
 *
 * Drives the chat UI end-to-end with a real virtual authenticator and
 * a real gateway round-trip:
 *
 *   1. Register first user via /setup
 *   2. Land on /chat — sidebar shows zero chats
 *   3. Click "+ new" — chat row appears, becomes selected
 *   4. Type a prompt that asks for "PONG" — submit via Enter
 *   5. See user message render immediately
 *   6. See assistant message progress streaming → completed
 *   7. Assistant text contains "PONG"
 *   8. Sidebar reflects ordering after activity
 *
 * Then a delete pass:
 *   9. Click delete (×) on the chat row, accept dialog → list empties
 *  10. UI shows the empty state
 */
import { test, expect, type CDPSession, type Page } from "@playwright/test";
import { execSync } from "node:child_process";

const BASE_URL = "http://localhost:3015";
const TEST_PROMPT = 'Reply with exactly one word: "PONG". No punctuation.';

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
  const username = `ui_e2e_${Date.now()}`;
  await page.goto(`${BASE_URL}/setup`);
  await page.fill('input[type="password"]', setupToken);
  await page.fill('input[autocomplete="username"]', username);
  await page.fill('input[placeholder="Ivan"]', "UI E2E");
  await page.click('button[type="submit"]');
  await expect(page.locator("h1")).toContainText("Save these", { timeout: 15_000 });
  await page.click('button:has-text("I saved them, continue")');
  await page.waitForURL(/\/chat$/, { timeout: 5_000 });
}

test("UI: create chat → send prompt → streamed assistant → delete", async ({
  page,
  context,
}) => {
  test.setTimeout(120_000);

  page.on("pageerror", (err) => console.log(`[pageerror] ${err.message}`));
  page.on("console", (msg) => {
    if (msg.type() === "error") console.log(`[browser error] ${msg.text()}`);
  });

  const cdp = await context.newCDPSession(page);
  await registerAndLogin(page, cdp);

  // 1. Sidebar present, no chats yet
  await expect(page.getByTestId("chat-sidebar")).toBeVisible();
  await expect(page.locator(".chat-list .empty")).toContainText("no chats yet");

  // 2. Create a chat
  await page.getByTestId("new-chat-btn").click();

  // A chat row appears with the default "New chat" title
  const firstRow = page.locator('[data-testid^="chat-row-"]').first();
  await expect(firstRow).toBeVisible({ timeout: 5_000 });
  await expect(firstRow.locator(".chat-title")).toHaveText("New chat");
  await expect(page.getByTestId("active-chat-title")).toHaveText("New chat");

  // 3. Empty messages state
  await expect(page.getByTestId("messages")).toContainText("no messages yet");

  // 4. Send a prompt
  const composer = page.getByTestId("composer-input");
  await composer.fill(TEST_PROMPT);
  await composer.press("Enter");

  // 5. The user message appears immediately
  const userMsg = page.locator('[data-role="user"]').last();
  await expect(userMsg).toBeVisible({ timeout: 5_000 });
  await expect(userMsg.locator(".msg-body")).toContainText(TEST_PROMPT, {
    timeout: 5_000,
  });

  // 6. Assistant message goes streaming → completed
  const assistantMsg = page.locator('[data-role="assistant"]').last();
  await expect(assistantMsg).toBeVisible({ timeout: 5_000 });
  await expect(assistantMsg).toHaveAttribute("data-status", "completed", {
    timeout: 90_000,
  });

  // 7. Assistant body contains PONG (case-insensitive)
  const assistantText = (await assistantMsg.locator(".msg-body").innerText()).toUpperCase();
  console.log(`[ui] assistant text: "${assistantText.slice(0, 100)}"`);
  expect(assistantText).toContain("PONG");

  // 8. Composer is enabled again post-stream
  await expect(composer).toBeEnabled();

  // 9. Delete the chat — confirm dialog
  page.once("dialog", (d) => d.accept());
  await firstRow.locator('button[aria-label="Delete chat"]').click();

  // 10. Empty state returns
  await expect(page.locator(".chat-list .empty")).toContainText("no chats yet", {
    timeout: 5_000,
  });
  await expect(page.locator(".empty-state h1")).toContainText("No chat selected");
});
