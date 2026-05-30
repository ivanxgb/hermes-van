import { describe, expect, it } from "vitest";
import { _serializeForTest } from "./logger";

describe("logger redaction", () => {
  it("redacts authorization header", () => {
    const out = _serializeForTest("info", {
      req: { headers: { authorization: "Bearer secret-token-here" } },
    }, "request");
    expect(out).not.toContain("secret-token-here");
    expect(out).toContain("[REDACTED]");
  });

  it("redacts cookies", () => {
    const out = _serializeForTest("info", {
      req: { headers: { cookie: "session=abc123" } },
    }, "request");
    expect(out).not.toContain("abc123");
  });

  it("redacts api_key fields anywhere in object", () => {
    const out = _serializeForTest("info", { config: { api_key: "sk-secret" } }, "boot");
    expect(out).not.toContain("sk-secret");
  });

  it("redacts run_id (capability token)", () => {
    const out = _serializeForTest("info", { run: { run_id: "run_xyz_capabilty" } }, "started");
    expect(out).not.toContain("run_xyz_capabilty");
  });

  it("redacts upstream_run_id", () => {
    const out = _serializeForTest("info", { state: { upstream_run_id: "upstream_xyz" } }, "ok");
    expect(out).not.toContain("upstream_xyz");
  });

  it("redacts password", () => {
    const out = _serializeForTest("info", { user: { password: "hunter2" } }, "ok");
    expect(out).not.toContain("hunter2");
  });

  it("does not redact safe fields", () => {
    const out = _serializeForTest("info", { user: { username: "ivan" } }, "ok");
    expect(out).toContain("ivan");
  });
});
