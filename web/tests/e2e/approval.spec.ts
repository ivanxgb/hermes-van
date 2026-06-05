/**
 * Phase 4.A — inline tool approval flow.
 *
 * Sends a prompt that forces the agent to invoke the `terminal` tool;
 * with HERMES_EXEC_ASK=1 active on the gateway, that triggers an
 * approval.request SSE event. We assert:
 *   1. The approval callout becomes visible with the proposed command.
 *   2. Clicking "deny" resolves the approval upstream → callout
 *      disappears → run finalizes.
 */
import { test, expect, type CDPSession, type Page } from "@playwright/test";
import { execSync } from "node:child_process";

const BASE_URL = "http://localhost:3015";
const PROMPT_THAT_NEEDS_APPROVAL =
  'Use the terminal tool to run exactly this command: `rm -rf /tmp/hermes_van_approval_test_xyz`. ' +
  'It is fine that the path does not exist. I want you to actually invoke the tool with that exact command, not paraphrase or refuse.';

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
  const username = `approval_${Date.now()}`;
  await page.goto(`${BASE_URL}/setup`);
  await page.fill('input[type="password"]', setupToken);
  await page.fill('input[autocomplete="username"]', username);
  await page.fill('input[placeholder="Ivan"]', "Approval");
  await page.click('button[type="submit"]');
  await expect(page.locator("h1")).toContainText("Save these", { timeout: 15_000 });
  await page.click('button:has-text("I saved them, continue")');
  await page.waitForURL(/\/chat$/, { timeout: 5_000 });
}

test("approval: callout shows command, deny resolves it", async ({
  page,
  context,
}) => {
  test.setTimeout(180_000);
  page.on("pageerror", (err) => console.log(`[pageerror] ${err.message}`));

  const cdp = await context.newCDPSession(page);
  await registerAndLogin(page, cdp);

  await page.getByTestId("new-chat-btn").click();
  await expect(page.locator('[data-testid^="chat-row-"]')).toHaveCount(1);

  const composer = page.getByTestId("composer-input");
  await composer.fill(PROMPT_THAT_NEEDS_APPROVAL);
  await composer.press("Enter");

  // Wait for the approval callout (proves the gateway emitted
  // approval.request and the SSE proxy forwarded it).
  const callout = page.getByTestId("approval-callout");
  await expect(callout).toBeVisible({ timeout: 60_000 });

  const cmd = await page.getByTestId("approval-command").innerText();
  console.log(`[approval] proposed command: ${cmd.slice(0, 200)}`);
  expect(cmd.toLowerCase()).toMatch(/ls|terminal|\/tmp/);

  // Deny it. Backend POSTs /api/runs/:id/approval with choice=deny;
  // gateway forwards a 'BLOCKED' result back to the agent, which
  // typically responds and finalizes.
  await page.getByTestId("approve-deny").click();

  // Callout should clear (approval.responded SSE) within a short window.
  await expect(callout).toBeHidden({ timeout: 10_000 });

  // Run should eventually finalize (either completed with the agent
  // saying it was denied, or failed/cancelled). We don't pin the exact
  // status — we only need it to leave the streaming state.
  await page
    .locator('[data-testid^="msg-"][data-role="assistant"]')
    .last()
    .waitFor({ state: "visible" });

  await expect
    .poll(
      async () => {
        const msg = page.locator('[data-role="assistant"]').last();
        return await msg.getAttribute("data-status");
      },
      { timeout: 90_000 },
    )
    .not.toBe("streaming");
});
