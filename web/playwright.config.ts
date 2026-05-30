import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  forbidOnly: !!process.env["CI"],
  retries: process.env["CI"] ? 2 : 0,
  workers: 1,
  reporter: "list",
  use: {
    baseURL: process.env["E2E_BASE_URL"] ?? "http://127.0.0.1:3015",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: process.env["E2E_BASE_URL"]
    ? undefined
    : {
        command: "pnpm dev",
        url: "http://127.0.0.1:3015",
        reuseExistingServer: true,
        timeout: 60_000,
      },
});
