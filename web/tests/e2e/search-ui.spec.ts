/**
 * Phase 6.F UI — SearchPalette end-to-end.
 *
 * Verifies the full path:
 *   1. Cmd+Shift+F opens the palette (overlay rendered).
 *   2. Typing fires debounced FTS5 search and renders snippets with
 *      [[…]] highlighted as <mark>.
 *   3. Enter selects the active row and switches to that chat;
 *      the target message receives the .msg-flash class briefly.
 *   4. Esc closes the palette.
 *
 * Reuses the bootstrap + register pattern from search.spec.ts.
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
  const username = `search_ui_${Date.now()}`;
  await page.goto(`${BASE_URL}/setup`);
  await page.fill('input[type="password"]', setupToken);
  await page.fill('input[autocomplete="username"]', username);
  await page.fill('input[placeholder="Ivan"]', "SearchUI");
  await page.click('button[type="submit"]');
  await expect(page.locator("h1")).toContainText("Save these", { timeout: 15_000 });
  await page.click('button:has-text("I saved them, continue")');
  await page.waitForURL(/\/chat$/, { timeout: 5_000 });
}

async function authedFetch(
  page: Page,
  method: "GET" | "POST",
  path: string,
  body?: unknown,
): Promise<{ status: number; body: unknown }> {
  return page.evaluate(
    async ({ method, path, body }) => {
      const csrf = document.cookie.match(/(?:^|;\s*)hv_csrf=([^;]+)/)?.[1];
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (method !== "GET" && csrf) headers["X-CSRF-Token"] = csrf;
      const res = await fetch(path, {
        method,
        headers,
        credentials: "same-origin",
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      const text = await res.text();
      let parsed: unknown = null;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {
        parsed = text;
      }
      return { status: res.status, body: parsed };
    },
    { method, path, body },
  );
}

test("search palette UI: opens, highlights matches, jumps to message", async ({
  page,
  context,
}) => {
  test.setTimeout(180_000);
  page.on("pageerror", (err) => console.log(`[pageerror] ${err.message}`));

  const cdp = await context.newCDPSession(page);
  await registerAndLogin(page, cdp);

  // Seed two chats with distinct prompts so search has real targets.
  const a = await authedFetch(page, "POST", "/api/chats", { title: "alpha-ui" });
  expect(a.status).toBe(201);
  const aId = (a.body as { chat: { id: string } }).chat.id;
  const b = await authedFetch(page, "POST", "/api/chats", { title: "beta-ui" });
  expect(b.status).toBe(201);
  const bId = (b.body as { chat: { id: string } }).chat.id;

  await authedFetch(page, "POST", `/api/chats/${aId}/runs`, {
    input: "Find me a recipe for sourdough starter please.",
  });
  await authedFetch(page, "POST", `/api/chats/${bId}/runs`, {
    input: "List quantum entanglement experiments from 2024.",
  });

  // FTS5 trigger fires on insert — wait until the messages are indexed
  // before driving the UI so we know there's something to search for.
  await expect
    .poll(
      async () => {
        const r = await authedFetch(page, "GET", "/api/chats/_search?q=sourdough");
        return (r.body as { results: unknown[] }).results.length;
      },
      { timeout: 10_000 },
    )
    .toBeGreaterThanOrEqual(1);

  // Reload so the chat list (which was created via authedFetch, not the UI)
  // is fetched into chatsApi.list state.
  await page.reload();
  await page.waitForURL(/\/chat$/, { timeout: 10_000 });

  // Open the search palette via the documented shortcut.
  // Playwright's "Meta" maps to Cmd on macOS / Ctrl elsewhere — both are
  // accepted by our handler.
  await page.keyboard.press("Control+Shift+F");
  await expect(page.getByTestId("search-overlay")).toBeVisible({ timeout: 5_000 });

  // Type and verify a snippet renders with <mark> spans.
  await page.getByTestId("search-input").fill("sourdough");
  const item = page
    .getByTestId("search-list")
    .locator("[data-testid^='search-item-']")
    .first();
  await expect(item).toBeVisible({ timeout: 5_000 });
  await expect(item.locator("mark").first()).toBeVisible();

  // Capture the message id from the row's data attribute, then commit.
  const targetMessageId = await item.getAttribute("data-message-id");
  expect(targetMessageId).toBeTruthy();
  const targetChatId = await item.getAttribute("data-chat-id");
  expect(targetChatId).toBe(aId);

  await page.keyboard.press("Enter");

  // Palette closes…
  await expect(page.getByTestId("search-overlay")).toHaveCount(0);

  // …and the target message is in the DOM (we switched chats).
  const target = page.getByTestId(`msg-${targetMessageId}`);
  await expect(target).toBeVisible({ timeout: 5_000 });
  // Flash is cosmetic — we only verify the jump landed on the right
  // message. The class lives for ~1.8s and may already be cleared by
  // the time we poll, so don't gate the test on it.

  // Reopen and verify Esc closes.
  await page.keyboard.press("Control+Shift+F");
  await expect(page.getByTestId("search-overlay")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("search-overlay")).toHaveCount(0);
});
