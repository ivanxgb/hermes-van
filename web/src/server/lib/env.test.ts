import { describe, expect, it, beforeEach } from "vitest";
import { _resetEnvCache, loadEnv } from "./env";

const validBase = {
  HERMES_API_KEY: "x".repeat(40),
  HERMES_WEB_DB_KEY: "a".repeat(64),
  HERMES_WEB_SESSION_SECRET: "b".repeat(64),
};

describe("env validation", () => {
  beforeEach(() => {
    _resetEnvCache();
  });

  it("accepts a complete valid env in development", () => {
    const env = loadEnv({ ...validBase, NODE_ENV: "development" });
    expect(env.HERMES_API_URL).toBe("http://127.0.0.1:8765");
    expect(env.HERMES_WEB_PORT).toBe(3015);
    expect(env.NODE_ENV).toBe("development");
  });

  it("rejects short HERMES_API_KEY", () => {
    expect(() => loadEnv({ ...validBase, HERMES_API_KEY: "short" })).toThrow(
      /HERMES_API_KEY/,
    );
  });

  it("rejects non-hex HERMES_WEB_DB_KEY", () => {
    expect(() =>
      loadEnv({ ...validBase, HERMES_WEB_DB_KEY: "not-hex-string-" + "g".repeat(48) }),
    ).toThrow(/HERMES_WEB_DB_KEY/);
  });

  it("rejects short HERMES_WEB_DB_KEY", () => {
    expect(() => loadEnv({ ...validBase, HERMES_WEB_DB_KEY: "abcdef" })).toThrow(
      /HERMES_WEB_DB_KEY/,
    );
  });

  it("rejects placeholder DB key in production", () => {
    expect(() =>
      loadEnv({
        ...validBase,
        NODE_ENV: "production",
        HERMES_WEB_DB_KEY: "0".repeat(64),
        HERMES_WEB_RP_ORIGIN: "https://hermes.example.com",
      }),
    ).toThrow(/placeholder DB key/);
  });

  it("rejects http RP_ORIGIN in production", () => {
    expect(() =>
      loadEnv({
        ...validBase,
        NODE_ENV: "production",
        HERMES_WEB_RP_ORIGIN: "http://hermes.example.com",
      }),
    ).toThrow(/HTTPS/);
  });

  it("allows http://localhost in production for testing", () => {
    const env = loadEnv({
      ...validBase,
      NODE_ENV: "production",
      HERMES_WEB_RP_ORIGIN: "http://localhost:3015",
    });
    expect(env.NODE_ENV).toBe("production");
  });

  it("coerces HERMES_WEB_PORT from string", () => {
    const env = loadEnv({ ...validBase, HERMES_WEB_PORT: "8080" });
    expect(env.HERMES_WEB_PORT).toBe(8080);
  });

  it("rejects invalid log level", () => {
    expect(() => loadEnv({ ...validBase, HERMES_WEB_LOG_LEVEL: "verbose" })).toThrow();
  });
});
