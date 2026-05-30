/**
 * E2E REST flow for chat CRUD endpoints. Builds on the same WebAuthn
 * bootstrap pattern as auth-flow.spec.ts, then exercises:
 *
 *   POST   /api/chats                 create
 *   GET    /api/chats                 list
 *   PATCH  /api/chats/:id             rename + archive
 *   GET    /api/chats/:id/messages    empty list
 *   DELETE /api/chats/:id             delete
 *
 * Plus negative cases:
 *   - mutation without CSRF header → 403
 *   - GET without auth cookie → 401
 *   - GET unknown id → 404
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

async function attachVirtualAuthenticator(client: CDPSession): Promise<string> {
  await client.send("WebAuthn.enable", { enableUI: false });
  const { authenticatorId } = await client.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
  return authenticatorId;
}

async function registerAndLogin(page: Page, cdp: CDPSession): Promise<{ username: string }> {
  const setupToken = freshBootstrapToken();
  await attachVirtualAuthenticator(cdp);

  const username = `chat_e2e_${Date.now()}`;
  await page.goto(`${BASE_URL}/setup`);
  await page.fill('input[type="password"]', setupToken);
  await page.fill('input[autocomplete="username"]', username);
  await page.fill('input[placeholder="Ivan"]', "Chat E2E");
  await page.click('button[type="submit"]');

  await expect(page.locator("h1")).toContainText("Save these", { timeout: 15_000 });
  await page.click('button:has-text("I saved them, continue")');
  await page.waitForURL(/\/chat$/, { timeout: 5_000 });

  return { username };
}

/**
 * Issue an authenticated request from inside the page context so cookies
 * + CSRF header are handled automatically.
 */
async function authedFetch(
  page: Page,
  method: "GET" | "POST" | "PATCH" | "DELETE",
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

test("chat REST CRUD: create → list → patch → messages → delete", async ({
  page,
  context,
}) => {
  test.setTimeout(60_000);

  page.on("pageerror", (err) => console.log(`[pageerror] ${err.message}`));
  page.on("requestfailed", (req) =>
    console.log(`[reqfail] ${req.method()} ${req.url()} — ${req.failure()?.errorText}`),
  );

  const cdp = await context.newCDPSession(page);
  await registerAndLogin(page, cdp);

  // 1. List starts empty for the fresh user.
  const initial = await authedFetch(page, "GET", "/api/chats");
  expect(initial.status).toBe(200);
  expect((initial.body as { chats: unknown[] }).chats).toEqual([]);

  // 2. Create a chat.
  const created = await authedFetch(page, "POST", "/api/chats", { title: "First chat" });
  expect(created.status).toBe(201);
  const createdBody = created.body as { chat: { id: string; title: string; gatewaySessionId: string } };
  expect(createdBody.chat.title).toBe("First chat");
  expect(createdBody.chat.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/); // ULID
  expect(createdBody.chat.gatewaySessionId).toMatch(/^hv_/);

  const chatId = createdBody.chat.id;

  // 3. List now returns it.
  const listAfterCreate = await authedFetch(page, "GET", "/api/chats");
  expect(listAfterCreate.status).toBe(200);
  expect((listAfterCreate.body as { chats: unknown[] }).chats).toHaveLength(1);

  // 4. GET one by id.
  const one = await authedFetch(page, "GET", `/api/chats/${chatId}`);
  expect(one.status).toBe(200);
  expect((one.body as { chat: { id: string } }).chat.id).toBe(chatId);

  // 5. Rename.
  const renamed = await authedFetch(page, "PATCH", `/api/chats/${chatId}`, { title: "Renamed" });
  expect(renamed.status).toBe(200);
  expect((renamed.body as { chat: { title: string } }).chat.title).toBe("Renamed");

  // 6. Archive.
  const archived = await authedFetch(page, "PATCH", `/api/chats/${chatId}`, { archived: true });
  expect(archived.status).toBe(200);
  expect((archived.body as { chat: { archivedAt: number | null } }).chat.archivedAt).not.toBeNull();

  const listAfterArchive = await authedFetch(page, "GET", "/api/chats");
  expect((listAfterArchive.body as { chats: unknown[] }).chats).toHaveLength(0);

  const listIncludingArchived = await authedFetch(
    page,
    "GET",
    "/api/chats?includeArchived=true",
  );
  expect((listIncludingArchived.body as { chats: unknown[] }).chats).toHaveLength(1);

  // 7. Unarchive.
  const unarchived = await authedFetch(page, "PATCH", `/api/chats/${chatId}`, {
    archived: false,
  });
  expect(unarchived.status).toBe(200);
  expect((unarchived.body as { chat: { archivedAt: number | null } }).chat.archivedAt).toBeNull();

  // 8. Messages list is empty.
  const messages = await authedFetch(page, "GET", `/api/chats/${chatId}/messages`);
  expect(messages.status).toBe(200);
  expect((messages.body as { messages: unknown[] }).messages).toEqual([]);

  // 9. Delete.
  const deleted = await authedFetch(page, "DELETE", `/api/chats/${chatId}`);
  expect(deleted.status).toBe(200);

  const listAfterDelete = await authedFetch(page, "GET", "/api/chats");
  expect((listAfterDelete.body as { chats: unknown[] }).chats).toEqual([]);

  // 10. GET unknown id → 404.
  const notFound = await authedFetch(page, "GET", "/api/chats/01HBOGUS00000000000000000A");
  expect(notFound.status).toBe(404);
});

test("chat REST: mutation without CSRF → 403; unauthed → 401", async ({ page, request }) => {
  test.setTimeout(30_000);

  // Unauthed request from a clean Playwright APIRequestContext (no cookies).
  const unauthed = await request.post(`${BASE_URL}/api/chats`, {
    data: { title: "x" },
  });
  expect(unauthed.status()).toBe(401);

  // Auth, then try to mutate without the CSRF header.
  const cdp = await page.context().newCDPSession(page);
  await registerAndLogin(page, cdp);

  const noCsrf = await page.evaluate(async () => {
    const res = await fetch("/api/chats", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // intentionally no X-CSRF-Token header
      credentials: "same-origin",
      body: JSON.stringify({ title: "x" }),
    });
    return { status: res.status, text: await res.text() };
  });
  expect(noCsrf.status).toBe(403);
});
