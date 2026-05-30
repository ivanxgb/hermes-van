/**
 * Phase 6.D — content-addressed upload storage tests.
 *
 * Verifies the storage primitives in src/server/lib/uploads.ts in
 * isolation, against a temp uploads root. Route-level tests live in
 * tests/e2e/uploads.spec.ts (Playwright).
 *
 * Coverage:
 *   1. validateMimeType denies known dangerous types and accepts the
 *      common ones (text/plain, image/png, application/pdf).
 *   2. blobPath fans out by first 2 hex chars and refuses non-hex input.
 *   3. hashBytes returns the expected sha256 for a known fixture.
 *   4. storeBlob writes the bytes to disk and returns deduplicated=false
 *      on the first call, deduplicated=true on the second.
 *   5. storeBlob refuses zero-byte buffers (would result in the
 *      well-known sha256 of empty input being a poison entry).
 *   6. storeBlob refuses oversize buffers without writing them.
 *   7. storeBlob throws when on-disk size mismatches a dedup target
 *      (defends against a corrupt store).
 *   8. deleteBlob is idempotent and a no-op on missing files.
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  existsSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ATTACHMENT_MAX_BYTES,
  blobPath,
  deleteBlob,
  hashBytes,
  storeBlob,
  validateMimeType,
} from "../../src/server/lib/uploads";

let workDir: string;
let root: { path: string };

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "hv-uploads-"));
  root = { path: workDir };
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

describe("validateMimeType", () => {
  test("accepts common safe types", () => {
    for (const m of [
      "text/plain",
      "image/png",
      "image/jpeg",
      "application/pdf",
      "application/json",
      "audio/mpeg",
      "video/mp4",
    ]) {
      expect(validateMimeType(m)).toEqual({ ok: true });
    }
  });

  test("denies dangerous executable types", () => {
    for (const m of [
      "application/x-msdownload",
      "application/x-sh",
      "application/x-shellscript",
      "application/x-php",
      "application/x-elf",
    ]) {
      expect(validateMimeType(m).ok).toBe(false);
    }
  });

  test("denies the ambiguous octet-stream", () => {
    expect(validateMimeType("application/octet-stream").ok).toBe(false);
  });

  test("denies malformed mime", () => {
    expect(validateMimeType("notamime").ok).toBe(false);
    expect(validateMimeType("").ok).toBe(false);
  });

  test("strips parameters before checking", () => {
    expect(validateMimeType("text/plain; charset=utf-8")).toEqual({ ok: true });
    expect(validateMimeType("application/x-sh; foo=bar").ok).toBe(false);
  });
});

describe("blobPath", () => {
  test("fans out by the first two hex chars", () => {
    const sha =
      "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";
    const p = blobPath(root, sha);
    expect(p.endsWith(`/ab/${sha}`)).toBe(true);
  });

  test("refuses non-hex sha256", () => {
    expect(() => blobPath(root, "definitely not a sha")).toThrow();
    expect(() => blobPath(root, "abc")).toThrow();
  });
});

describe("hashBytes", () => {
  test("matches the well-known SHA-256 of 'abc'", () => {
    const expected =
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
    expect(hashBytes(Buffer.from("abc"))).toBe(expected);
  });
});

describe("storeBlob", () => {
  test("first call writes, second call deduplicates", () => {
    const buf = Buffer.from("hello hermes-van\n");
    const a = storeBlob(root, buf);
    expect(a.deduplicated).toBe(false);
    expect(existsSync(a.storagePath)).toBe(true);
    expect(statSync(a.storagePath).size).toBe(buf.length);

    const b = storeBlob(root, Buffer.from("hello hermes-van\n"));
    expect(b.deduplicated).toBe(true);
    expect(b.sha256).toBe(a.sha256);
    expect(b.storagePath).toBe(a.storagePath);
  });

  test("refuses empty buffers", () => {
    expect(() => storeBlob(root, Buffer.alloc(0))).toThrow(/empty/);
  });

  test("refuses oversize buffers", () => {
    const oversize = Buffer.alloc(ATTACHMENT_MAX_BYTES + 1);
    expect(() => storeBlob(root, oversize)).toThrow(/exceeds/);
  });

  test("throws when dedup target on disk has a wrong size (corrupt store)", () => {
    const buf = Buffer.from("first content");
    const stored = storeBlob(root, buf);
    // Tamper: overwrite the on-disk blob with a file of a different
    // length while keeping the same sha256-named path. storeBlob must
    // notice and refuse rather than silently lying about dedup.
    writeFileSync(stored.storagePath, "completely different content here");
    expect(() => storeBlob(root, buf)).toThrow(/dedup mismatch/);
  });

  test("refuses non-Buffer input loudly", () => {
    // Type narrowing escape — the runtime check matters.
    expect(() =>
      storeBlob(root, "not a buffer" as unknown as Buffer),
    ).toThrow();
  });
});

describe("deleteBlob", () => {
  test("removes the file when present", () => {
    const stored = storeBlob(root, Buffer.from("x"));
    expect(existsSync(stored.storagePath)).toBe(true);
    deleteBlob(root, stored.sha256);
    expect(existsSync(stored.storagePath)).toBe(false);
  });

  test("is a no-op on missing files", () => {
    // 64 hex chars but no such blob — must not throw.
    const fake = "0".repeat(64);
    expect(() => deleteBlob(root, fake)).not.toThrow();
  });

  test("ignores non-hex input silently (defense in depth)", () => {
    expect(() => deleteBlob(root, "garbage")).not.toThrow();
  });

  test("refuses to traverse outside the uploads root", () => {
    // This is implicit in blobPath's hex check, but verify end-to-end:
    // a malicious sha256 with path traversal characters must not
    // cause a delete outside the root. Hex-only inputs guarantee this.
    const sneakyDir = join(workDir, "..", "decoy");
    mkdirSync(sneakyDir, { recursive: true });
    const sneakyFile = join(sneakyDir, "important.txt");
    writeFileSync(sneakyFile, "must survive");
    deleteBlob(root, "../decoy/important.txt");
    expect(existsSync(sneakyFile)).toBe(true);
    rmSync(sneakyDir, { recursive: true, force: true });
  });
});
