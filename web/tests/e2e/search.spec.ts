/**
 * Phase 4.B — FTS5 search over user's message log.
 *
 * Verifies:
 *   1. POST /api/chats + run produces messages indexed in messages_fts
 *      via the AFTER INSERT trigger.
 *   2. GET /api/chats/_search?q=… returns rows ranked by relevance,
 *      each with a `snippet` containing the [[…]] match brackets.
 *   3. ?chatId=… narrows the search to one chat.
 *   4. A user only sees their own results (cross-user isolation via
 *      ScopedDb — implicit, but checked by ensuring search returns
 *      only rows belonging to the authed user).
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
  const username = `search_${Date.now()}`;
  await page.goto(`${BASE_URL}/setup`);
  await page.fill('input[type="password"]', setupToken);
  await page.fill('input[autocomplete="username"]', username);
  await page.fill('input[placeholder="Ivan"]', "Search");
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

test("search FTS5: indexes messages and returns ranked results with snippets", async ({
  page,
  context,
}) => {
  test.setTimeout(180_000);
  page.on("pageerror", (err) => console.log(`[pageerror] ${err.message}`));

  const cdp = await context.newCDPSession(page);
  await registerAndLogin(page, cdp);

  // Create two chats, run a different prompt in each so we can verify
  // both global search and per-chat scoping.
  const a = await authedFetch(page, "POST", "/api/chats", { title: "alpha-search" });
  expect(a.status).toBe(201);
  const aId = (a.body as { chat: { id: string } }).chat.id;

  const b = await authedFetch(page, "POST", "/api/chats", { title: "beta-search" });
  expect(b.status).toBe(201);
  const bId = (b.body as { chat: { id: string } }).chat.id;

  // The user message is what gets indexed first; trigger fires on insert.
  // We don't even need to wait for the agent reply — both user prompts
  // go straight to the FTS index immediately.
  await authedFetch(page, "POST", `/api/chats/${aId}/runs`, {
    input: "Find me a recipe for sourdough starter please.",
  });
  await authedFetch(page, "POST", `/api/chats/${bId}/runs`, {
    input: "List quantum entanglement experiments from 2024.",
  });

  // Global search — should match both
  await expect
    .poll(
      async () => {
        const r = await authedFetch(
          page,
          "GET",
          "/api/chats/_search?q=recipe%20OR%20quantum",
        );
        return (r.body as { results: unknown[] }).results.length;
      },
      { timeout: 10_000 },
    )
    .toBeGreaterThanOrEqual(2);

  // Specific term — only one chat
  const sourdough = await authedFetch(page, "GET", "/api/chats/_search?q=sourdough");
  expect(sourdough.status).toBe(200);
  const srdRows = (sourdough.body as {
    results: Array<{ chatId: string; snippet: string; content: string }>;
  }).results;
  expect(srdRows.length).toBeGreaterThanOrEqual(1);
  // Every result must come from chat A
  for (const row of srdRows) expect(row.chatId).toBe(aId);
  // Snippet should contain the FTS5 match brackets
  expect(srdRows[0]!.snippet).toContain("[[");
  expect(srdRows[0]!.snippet).toContain("]]");

  // Per-chat scoping: searching 'experiments' restricted to chat A → 0
  const aOnly = await authedFetch(
    page,
    "GET",
    `/api/chats/_search?q=experiments&chatId=${aId}`,
  );
  expect((aOnly.body as { results: unknown[] }).results.length).toBe(0);

  // Same term restricted to chat B → at least 1
  const bOnly = await authedFetch(
    page,
    "GET",
    `/api/chats/_search?q=experiments&chatId=${bId}`,
  );
  expect((bOnly.body as { results: unknown[] }).results.length).toBeGreaterThanOrEqual(1);

  // Empty query → 400
  const badEmpty = await authedFetch(page, "GET", "/api/chats/_search?q=");
  expect(badEmpty.status).toBe(400);

  // Malformed FTS5 query (unbalanced quote) → 200 with 0 results
  // (server catches the FTS5 error and returns []).
  const malformed = await authedFetch(
    page,
    "GET",
    "/api/chats/_search?q=" + encodeURIComponent('"unbalanced'),
  );
  expect(malformed.status).toBe(200);
  expect((malformed.body as { results: unknown[] }).results.length).toBe(0);
});
