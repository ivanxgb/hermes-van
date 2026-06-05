import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./src/server/db/schema.ts",
  out: "./src/server/db/migrations",
  dialect: "sqlite",
  dbCredentials: {
    url: process.env["HERMES_VAN_DB_PATH"] ?? "./data/hermes-van.db",
  },
  verbose: true,
  strict: true,
});
