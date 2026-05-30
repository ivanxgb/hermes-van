/**
 * E2E SSE flow: create chat → start run → consume EventSource → see deltas
 * → see run.completed → message persisted.
 *
 * Hits the real gateway (HERMES_VAN_GATEWAY_URL) and the real agent;
 * the test prompt is intentionally trivial ("respond with the word PONG")
 * to keep the run short and deterministic. Default timeout is 90s in case
 * the upstream model is cold.
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

  const username = `sse_e2e_${Date.now()}`;
  await page.goto(`${BASE_URL}/setup`);
  await page.fill('input[type="password"]', setupToken);
  await page.fill('input[autocomplete="username"]', username);
  await page.fill('input[placeholder="Ivan"]', "SSE E2E");
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

test("SSE streaming: start run, accumulate deltas, persist message", async ({
  page,
  context,
}) => {
  test.setTimeout(120_000);

  page.on("pageerror", (err) => console.log(`[pageerror] ${err.message}`));

  const cdp = await context.newCDPSession(page);
  await registerAndLogin(page, cdp);

  // 1. Create chat
  const created = await authedFetch(page, "POST", "/api/chats", { title: "SSE test" });
  expect(created.status).toBe(201);
  const chatId = (created.body as { chat: { id: string } }).chat.id;

  // 2. Start a run
  const startRes = await authedFetch(page, "POST", `/api/chats/${chatId}/runs`, {
    input: TEST_PROMPT,
  });
  expect(startRes.status).toBe(200);
  const startBody = startRes.body as {
    run: { id: string; status: string; messageId: string };
    userMessage: { content: string };
    assistantMessage: { id: string; status: string };
  };
  expect(startBody.run.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  expect(startBody.userMessage.content).toBe(TEST_PROMPT);
  expect(startBody.assistantMessage.status).toBe("streaming");

  const runId = startBody.run.id;
  const messageId = startBody.run.messageId;

  // 3. Consume the SSE stream from inside the page so cookies + same-origin
  //    apply. Resolve once we observe run.completed (or run.failed).
  const sseResult = await page.evaluate(
    async ({ runId, timeoutMs }) => {
      return await new Promise<{
        deltas: number;
        accumulated: string;
        finalEvent: string;
        error?: string;
      }>((resolve) => {
        const es = new EventSource(`/api/runs/${runId}/events`);
        let deltas = 0;
        let accumulated = "";
        const tid = setTimeout(() => {
          es.close();
          resolve({ deltas, accumulated, finalEvent: "timeout" });
        }, timeoutMs);

        es.addEventListener("message.delta", (ev) => {
          try {
            const data = JSON.parse((ev as MessageEvent).data);
            deltas += 1;
            accumulated += String(data.delta ?? "");
          } catch {
            // ignore
          }
        });
        es.addEventListener("run.completed", () => {
          clearTimeout(tid);
          es.close();
          resolve({ deltas, accumulated, finalEvent: "run.completed" });
        });
        es.addEventListener("run.failed", (ev) => {
          clearTimeout(tid);
          es.close();
          let error = "unknown";
          try {
            error = JSON.parse((ev as MessageEvent).data).error ?? "unknown";
          } catch {
            // ignore
          }
          resolve({ deltas, accumulated, finalEvent: "run.failed", error });
        });
        es.onerror = () => {
          // EventSource will retry; fall through to message.* events.
          // No-op here unless we hit timeout.
        };
      });
    },
    { runId, timeoutMs: 90_000 },
  );

  // Diagnostic dump — helpful when the model is cold or returns an error.
  console.log(
    `[sse] deltas=${sseResult.deltas} final=${sseResult.finalEvent} accumulated="${sseResult.accumulated.slice(0, 100)}"`,
  );

  expect(sseResult.finalEvent).toBe("run.completed");
  expect(sseResult.deltas).toBeGreaterThan(0);
  expect(sseResult.accumulated.toUpperCase()).toContain("PONG");

  // 4. The message in the DB should be finalized with the same content.
  const messagesRes = await authedFetch(page, "GET", `/api/chats/${chatId}/messages`);
  expect(messagesRes.status).toBe(200);
  const msgs = (messagesRes.body as { messages: Array<Record<string, unknown>> }).messages;
  expect(msgs.length).toBe(2);
  const assistant = msgs.find((m) => m["id"] === messageId) as Record<string, unknown>;
  expect(assistant).toBeTruthy();
  expect(assistant["status"]).toBe("completed");
  expect(String(assistant["content"]).toUpperCase()).toContain("PONG");
});
