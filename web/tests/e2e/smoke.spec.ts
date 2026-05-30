/**
 * E2E smoke test — verifies the public surface boots without auth.
 * Phase 1 closeout.
 *
 * Full bootstrap → setup → login → logout flow needs a clean DB and
 * either a real WebAuthn authenticator or @virtualauthn — those land in
 * Phase 2 once the chat surface adds value beyond the auth shell.
 */
import { expect, test } from "@playwright/test";

test("anonymous user is redirected to /login", async ({ page }) => {
  const response = await page.goto("/");
  expect(response?.status()).toBeLessThan(500);
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.locator("h1")).toContainText("Welcome back");
});

test("/api/health responds with JSON", async ({ request }) => {
  const res = await request.get("/api/health");
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body.service).toBe("hermes-van");
  expect(typeof body.gateway?.ok).toBe("boolean");
});

test("/auth/me without cookie returns 401", async ({ request }) => {
  const res = await request.get("/auth/me");
  expect(res.status()).toBe(401);
});

test("CSRF rejection on mutation without token", async ({ request }) => {
  const res = await request.post("/auth/logout");
  // Either 401 (no auth) or 403 (no csrf) — both acceptable, both correct.
  expect([401, 403]).toContain(res.status());
});

test("setup page renders the form", async ({ page }) => {
  await page.goto("/setup");
  await expect(page.locator("h1")).toContainText("first passkey");
  await expect(page.locator('input[type="password"]')).toBeVisible();
});
