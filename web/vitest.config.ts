import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: false,
    environment: "node",
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
    exclude: ["node_modules", "dist", "tests/e2e/**"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      reportsDirectory: "./coverage",
      include: ["src/server/**/*.{ts,tsx}"],
      exclude: [
        "src/**/*.test.{ts,tsx}",
        "src/**/*.spec.{ts,tsx}",
        "src/server/db/migrations/**",
      ],
    },
  },
  resolve: {
    alias: {
      "~": "/src",
      // drizzle's better-sqlite3 driver imports the package by name.
      // we use the multiple-ciphers fork (SQLCipher), so redirect.
      "better-sqlite3": "better-sqlite3-multiple-ciphers",
    },
  },
});
