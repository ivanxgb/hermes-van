/**
 * Phase 6.D — file upload routes (end-to-end).
 *
 * Modeled after push.spec.ts: bootstrap a user via the virtual WebAuthn
 * authenticator, then drive the /api/uploads endpoints from inside the
 * page so cookies (auth + CSRF) flow naturally.
 *
 * Coverage:
 *   1. Anon access to all upload routes is rejected (401).
 *   2. CSRF is required for POST/DELETE.
 *   3. Multipart upload of a real-ish payload returns 201 with metadata.
 *   4. GET list returns the just-uploaded file scoped to this user.
 *   5. GET /raw streams the bytes back with the original mime type and
 *      content-disposition: attachment + nosniff.
 *   6. Re-uploading the same bytes deduplicates (deduplicated=true).
 *   7. DELETE removes the row and (since refcount drops to 0) GCs the
 *      blob. A subsequent GET /raw 404s.
 *   8. Empty + oversize uploads return 400 / 413.
 *   9. Disallowed mime types return 415.
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

async function registerAndLogin(page: Page, cdp: CDPSession, prefix: string): Promise<void> {
  const setupToken = freshBootstrapToken();
  await attachVirtualAuthenticator(cdp);
  const username = `${prefix}_${Date.now()}`;
  await page.goto(`${BASE_URL}/setup`);
  await page.fill('input[type="password"]', setupToken);
  await page.fill('input[autocomplete="username"]', username);
  await page.fill('input[placeholder="Ivan"]', "Test");
  await page.click('button[type="submit"]');
  await expect(page.locator("h1")).toContainText("Save these", { timeout: 15_000 });
  await page.click('button:has-text("I saved them, continue")');
  await page.waitForURL(/\/chat$/, { timeout: 5_000 });
}

test("uploads: anon endpoints 401", async ({ request }) => {
  expect((await request.get(`${BASE_URL}/api/uploads`)).status()).toBe(401);
  expect((await request.get(`${BASE_URL}/api/uploads/abc`)).status()).toBe(401);
  expect((await request.get(`${BASE_URL}/api/uploads/abc/raw`)).status()).toBe(401);
  expect(
    (
      await request.post(`${BASE_URL}/api/uploads`, {
        multipart: { file: { name: "x.txt", mimeType: "text/plain", buffer: Buffer.from("x") } },
      })
    ).status(),
  ).toBe(401);
});

test("uploads: round-trip a small text file", async ({ page, context }) => {
  const cdp = await context.newCDPSession(page);
  await registerAndLogin(page, cdp, "upl");

  // Upload a known payload from inside the page so cookies + CSRF flow.
  const result = await page.evaluate(async () => {
    const csrf = document.cookie.match(/(?:^|;\s*)hv_csrf=([^;]+)/)?.[1] ?? "";
    const fd = new FormData();
    fd.append(
      "file",
      new Blob(["hello hermes-van\n"], { type: "text/plain" }),
      "hello.txt",
    );
    const r = await fetch("/api/uploads", {
      method: "POST",
      headers: { "X-CSRF-Token": csrf },
      body: fd,
      credentials: "same-origin",
    });
    return { status: r.status, body: await r.json() };
  });
  expect(result.status).toBe(201);
  expect(result.body).toMatchObject({
    filename: "hello.txt",
    mimeType: "text/plain",
    sizeBytes: 17,
    deduplicated: false,
  });
  expect(result.body.id).toMatch(/^[0-9A-HJ-KM-NP-TV-Z]{26}$/i);
  expect(result.body.mediaUrl).toBe(`MEDIA:/api/uploads/${result.body.id}/raw`);
  const sha = result.body.sha256 as string;
  expect(sha).toMatch(/^[0-9a-f]{64}$/);

  // List should include it.
  const list = await page.evaluate(async () => {
    const r = await fetch("/api/uploads", { credentials: "same-origin" });
    return r.json();
  });
  expect((list.items as Array<{ id: string }>).some((i) => i.id === result.body.id)).toBe(
    true,
  );

  // /raw streams the bytes with attachment disposition + nosniff.
  const raw = await page.request.get(
    `${BASE_URL}/api/uploads/${result.body.id}/raw`,
  );
  expect(raw.status()).toBe(200);
  expect(raw.headers()["content-type"] ?? "").toContain("text/plain");
  expect(raw.headers()["content-disposition"] ?? "").toContain("attachment");
  expect(raw.headers()["x-content-type-options"]).toBe("nosniff");
  const body = await raw.text();
  expect(body).toBe("hello hermes-van\n");
});

test("uploads: re-uploading the same bytes deduplicates", async ({ page, context }) => {
  const cdp = await context.newCDPSession(page);
  await registerAndLogin(page, cdp, "dedup");

  const dedup = await page.evaluate(async () => {
    const csrf = document.cookie.match(/(?:^|;\s*)hv_csrf=([^;]+)/)?.[1] ?? "";
    async function up() {
      const fd = new FormData();
      fd.append("file", new Blob(["same content"], { type: "text/plain" }), "a.txt");
      const r = await fetch("/api/uploads", {
        method: "POST",
        headers: { "X-CSRF-Token": csrf },
        body: fd,
        credentials: "same-origin",
      });
      return r.json();
    }
    const a = await up();
    const b = await up();
    return { a, b };
  });
  expect(dedup.a.deduplicated).toBe(false);
  expect(dedup.b.deduplicated).toBe(true);
  expect(dedup.b.sha256).toBe(dedup.a.sha256);
  // Two separate metadata rows still: ids differ.
  expect(dedup.a.id).not.toBe(dedup.b.id);
});

test("uploads: DELETE removes metadata and last reference GCs the blob", async ({
  page,
  context,
}) => {
  const cdp = await context.newCDPSession(page);
  await registerAndLogin(page, cdp, "del");

  const r = await page.evaluate(async () => {
    const csrf = document.cookie.match(/(?:^|;\s*)hv_csrf=([^;]+)/)?.[1] ?? "";
    const fd = new FormData();
    fd.append("file", new Blob(["delete-me"], { type: "text/plain" }), "del.txt");
    const up = await fetch("/api/uploads", {
      method: "POST",
      headers: { "X-CSRF-Token": csrf },
      body: fd,
      credentials: "same-origin",
    });
    const json = await up.json();
    const del = await fetch(`/api/uploads/${json.id}`, {
      method: "DELETE",
      headers: { "X-CSRF-Token": csrf },
      credentials: "same-origin",
    });
    const delJson = await del.json();
    const after = await fetch(`/api/uploads/${json.id}/raw`, {
      credentials: "same-origin",
    });
    return { id: json.id, del: del.status, delBody: delJson, after: after.status };
  });
  expect(r.del).toBe(200);
  expect(r.delBody.gcRemovedBlob).toBe(true);
  expect(r.after).toBe(404);
});

test("uploads: empty payload → 400, oversize → 413, dangerous mime → 415", async ({
  page,
  context,
}) => {
  const cdp = await context.newCDPSession(page);
  await registerAndLogin(page, cdp, "guard");

  const out = await page.evaluate(async () => {
    const csrf = document.cookie.match(/(?:^|;\s*)hv_csrf=([^;]+)/)?.[1] ?? "";
    async function postFile(b: Blob, name: string) {
      const fd = new FormData();
      fd.append("file", b, name);
      const r = await fetch("/api/uploads", {
        method: "POST",
        headers: { "X-CSRF-Token": csrf },
        body: fd,
        credentials: "same-origin",
      });
      return r.status;
    }
    const empty = await postFile(new Blob([""], { type: "text/plain" }), "e.txt");
    // 26 MB > 25 MB cap.
    const big = new Uint8Array(26 * 1024 * 1024);
    const oversize = await postFile(new Blob([big], { type: "text/plain" }), "big.bin");
    const danger = await postFile(
      new Blob(["#!/bin/sh\necho pwn"], { type: "application/x-sh" }),
      "x.sh",
    );
    return { empty, oversize, danger };
  });
  expect(out.empty).toBe(400);
  expect(out.oversize).toBe(413);
  expect(out.danger).toBe(415);
});

test("uploads: POST without CSRF token is refused", async ({ page, context }) => {
  const cdp = await context.newCDPSession(page);
  await registerAndLogin(page, cdp, "csrf");

  const status = await page.evaluate(async () => {
    const fd = new FormData();
    fd.append("file", new Blob(["x"], { type: "text/plain" }), "x.txt");
    const r = await fetch("/api/uploads", {
      method: "POST",
      // intentionally no X-CSRF-Token
      body: fd,
      credentials: "same-origin",
    });
    return r.status;
  });
  expect(status).toBe(403);
});
