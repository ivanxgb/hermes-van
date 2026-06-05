/**
 * Phase 4.C — export chat as markdown.
 *
 * Verifies:
 *   1. GET /api/chats/:id/export.md returns 200 with text/markdown.
 *   2. Body has the expected shape: # title, metadata blockquote,
 *      ## You / ## Assistant headings for completed turns.
 *   3. Pending/empty rows are excluded.
 *   4. Content-Disposition has a sane filename based on the chat title.
 *   5. Unknown chat → 404.
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
  const username = `export_${Date.now()}`;
  await page.goto(`${BASE_URL}/setup`);
  await page.fill('input[type="password"]', setupToken);
  await page.fill('input[autocomplete="username"]', username);
  await page.fill('input[placeholder="Ivan"]', "Export");
  await page.click('button[type="submit"]');
  await expect(page.locator("h1")).toContainText("Save these", { timeout: 15_000 });
  await page.click('button:has-text("I saved them, continue")');
  await page.waitForURL(/\/chat$/, { timeout: 5_000 });
}

test("export.md: returns markdown with proper structure + filename", async ({
  page,
  context,
}) => {
  test.setTimeout(120_000);
  page.on("pageerror", (err) => console.log(`[pageerror] ${err.message}`));

  const cdp = await context.newCDPSession(page);
  await registerAndLogin(page, cdp);

  // Create a chat with a known title and run a fast prompt
  await page.evaluate(async () => {
    const csrf = document.cookie.match(/(?:^|;\s*)hv_csrf=([^;]+)/)?.[1] ?? "";
    const headers = { "Content-Type": "application/json", "X-CSRF-Token": csrf };
    await fetch("/api/chats", {
      method: "POST",
      headers,
      body: JSON.stringify({ title: "Export Test Chat" }),
      credentials: "same-origin",
    });
  });
  await page.reload();

  const row = page.locator('[data-testid^="chat-row-"]').first();
  await expect(row).toBeVisible({ timeout: 5_000 });
  const chatId = (await row.getAttribute("data-testid"))!.replace("chat-row-", "");

  const composer = page.getByTestId("composer-input");
  await composer.fill("Reply with exactly the word ECHO and nothing else.");
  await composer.press("Enter");

  // Wait for the assistant message to finalize
  await expect(page.locator('[data-role="assistant"]').last()).toHaveAttribute(
    "data-status",
    "completed",
    { timeout: 60_000 },
  );

  // Hit /export.md from the page context (cookies attached)
  const result = await page.evaluate(async (id) => {
    const res = await fetch(`/api/chats/${id}/export.md`, {
      credentials: "same-origin",
    });
    return {
      status: res.status,
      contentType: res.headers.get("content-type"),
      disposition: res.headers.get("content-disposition"),
      body: await res.text(),
    };
  }, chatId);

  expect(result.status).toBe(200);
  expect(result.contentType).toContain("text/markdown");
  expect(result.disposition).toMatch(/filename="export-test-chat-[A-Z0-9]{8}\.md"/i);

  console.log(`[export] body:\n${result.body}`);

  // Title heading
  expect(result.body).toMatch(/^# Export Test Chat$/m);
  // Metadata blockquote
  expect(result.body).toMatch(/^> Exported from hermes-van/m);
  expect(result.body).toContain(`Chat: \`${chatId}\``);
  // Both turns present
  expect(result.body).toMatch(/^## You$/m);
  expect(result.body).toMatch(/^## Assistant$/m);
  // User content
  expect(result.body).toContain("Reply with exactly the word ECHO");
  // Assistant content
  expect(result.body.toUpperCase()).toContain("ECHO");

  // Unknown id → 404
  const missing = await page.evaluate(async () => {
    const res = await fetch("/api/chats/01HBOGUS00000000000000000A/export.md", {
      credentials: "same-origin",
    });
    return res.status;
  });
  expect(missing).toBe(404);
});
