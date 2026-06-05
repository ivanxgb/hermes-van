/**
 * Phase 3.B — command palette + keyboard shortcuts + markdown rendering.
 *
 * Verifies:
 *   - Cmd+K opens the palette; Esc closes it.
 *   - Typing filters chat rows.
 *   - Cmd+N creates a new chat without opening the palette.
 *   - / triggers slash command mode and shows /help, /new, etc.
 *   - Selecting a chat row from the palette switches the active chat.
 *   - Assistant markdown renders as HTML (not raw text).
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
  const username = `palette_${Date.now()}`;
  await page.goto(`${BASE_URL}/setup`);
  await page.fill('input[type="password"]', setupToken);
  await page.fill('input[autocomplete="username"]', username);
  await page.fill('input[placeholder="Ivan"]', "Palette");
  await page.click('button[type="submit"]');
  await expect(page.locator("h1")).toContainText("Save these", { timeout: 15_000 });
  await page.click('button:has-text("I saved them, continue")');
  await page.waitForURL(/\/chat$/, { timeout: 5_000 });
}

test("palette: Cmd+K opens, filters, Esc closes; Cmd+N creates chat", async ({
  page,
  context,
}) => {
  test.setTimeout(60_000);

  page.on("pageerror", (err) => console.log(`[pageerror] ${err.message}`));

  const cdp = await context.newCDPSession(page);
  await registerAndLogin(page, cdp);

  // Cmd+N (Meta or Ctrl) creates a new chat
  const isMac = process.platform === "darwin";
  const meta = isMac ? "Meta" : "Control";
  await page.keyboard.press(`${meta}+n`);
  await expect(page.locator('[data-testid^="chat-row-"]')).toHaveCount(1, {
    timeout: 5_000,
  });

  // Make a second chat too so the palette has things to filter
  await page.keyboard.press(`${meta}+n`);
  await expect(page.locator('[data-testid^="chat-row-"]')).toHaveCount(2, {
    timeout: 5_000,
  });

  // Open the palette with Cmd+K
  await page.keyboard.press(`${meta}+k`);
  await expect(page.getByTestId("palette-overlay")).toBeVisible({ timeout: 3_000 });

  // It should show our two chats + the action commands
  const list = page.getByTestId("palette-list");
  await expect(list.locator("li[role='option']")).toHaveCount(2 + 3); // 2 chats + 3 actions

  // Type "/" to switch to slash mode
  const input = page.getByTestId("palette-input");
  await input.fill("/");
  await expect(page.getByTestId("palette-item-slash:/help")).toBeVisible();
  await expect(page.getByTestId("palette-item-slash:/new")).toBeVisible();

  // Esc closes
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("palette-overlay")).not.toBeVisible();
});

test("palette: pressing a chat row switches the active chat", async ({
  page,
  context,
}) => {
  test.setTimeout(60_000);
  page.on("pageerror", (err) => console.log(`[pageerror] ${err.message}`));

  const cdp = await context.newCDPSession(page);
  await registerAndLogin(page, cdp);

  // Make two chats and rename one via the API so titles differ
  await page.evaluate(async () => {
    const csrf = document.cookie.match(/(?:^|;\s*)hv_csrf=([^;]+)/)?.[1] ?? "";
    const headers = { "Content-Type": "application/json", "X-CSRF-Token": csrf };
    const a = await (
      await fetch("/api/chats", {
        method: "POST",
        headers,
        body: JSON.stringify({ title: "alpha-quebec" }),
        credentials: "same-origin",
      })
    ).json();
    await fetch("/api/chats", {
      method: "POST",
      headers,
      body: JSON.stringify({ title: "bravo-victor" }),
      credentials: "same-origin",
    });
    return a;
  });
  await page.reload();

  await expect(page.locator('[data-testid^="chat-row-"]')).toHaveCount(2, {
    timeout: 5_000,
  });

  const isMac = process.platform === "darwin";
  const meta = isMac ? "Meta" : "Control";
  await page.keyboard.press(`${meta}+k`);
  await expect(page.getByTestId("palette-overlay")).toBeVisible();

  // Filter to alpha
  await page.getByTestId("palette-input").fill("alpha");
  // Hit Enter — first match should commit
  await page.keyboard.press("Enter");

  await expect(page.getByTestId("active-chat-title")).toHaveText("alpha-quebec", {
    timeout: 5_000,
  });
});

test("markdown: assistant message renders code + bold + lists as HTML", async ({
  page,
  context,
}) => {
  test.setTimeout(120_000);
  page.on("pageerror", (err) => console.log(`[pageerror] ${err.message}`));

  const cdp = await context.newCDPSession(page);
  await registerAndLogin(page, cdp);

  await page.getByTestId("new-chat-btn").click();
  await expect(page.locator('[data-testid^="chat-row-"]')).toHaveCount(1);

  const composer = page.getByTestId("composer-input");
  await composer.fill(
    'Reply with EXACTLY this markdown, nothing else:\n\n# Hi\n\n- **bold** item\n- `code` item\n',
  );
  await composer.press("Enter");

  const assistant = page.locator('[data-role="assistant"]').last();
  await expect(assistant).toHaveAttribute("data-status", "completed", {
    timeout: 90_000,
  });

  // The msg-body should contain real DOM: <h1>, <strong>, <code>, <ul>
  const body = assistant.locator(".msg-body .md");
  await expect(body).toBeVisible();
  await expect(body.locator("h1")).toContainText("Hi");
  await expect(body.locator("strong").first()).toContainText("bold");
  await expect(body.locator("code").first()).toContainText("code");
  await expect(body.locator("li")).toHaveCount(2);
});
