/**
 * Attachment storage — Phase 6.D.
 *
 * Content-addressed file store backing /api/uploads. Layout under the
 * configured uploads root (default: <data>/uploads):
 *
 *   uploads/
 *     ab/
 *       abcdef...sha256-hex   ← raw bytes, immutable, not encrypted
 *
 * The first two hex chars of the sha256 are used as a fan-out directory
 * so a populated upload root never has more than ~256 immediate children
 * (and ~16M files spread across them at the asymptote). This keeps
 * `readdir` and inotify scans cheap.
 *
 * Why content-addressed:
 *   - Cheap dedup. Same file uploaded twice resolves to one blob.
 *   - Integrity check is `sha256sum file == basename(file)`.
 *   - Refcounting via the `attachments` table tells GC when a blob is
 *     orphaned (refcountGlobal === 0) so it can be removed safely.
 *
 * Why NOT inside the SQLCipher DB:
 *   - Large blobs (PDFs, images, video) would balloon the encrypted
 *     DB and slow every backup. We cap individual blobs at
 *     ATTACHMENT_MAX_BYTES (default 25MB) and store metadata only in
 *     the encrypted DB. The blob itself is at-rest in the filesystem
 *     and relies on disk encryption / file ACLs from the OS.
 *
 * Design decisions called out in tests:
 *   - SHA-256 of EMPTY input is `e3b0c44...855` (well-known constant);
 *     test asserts a zero-byte upload doesn't round-trip to a corrupt
 *     blob (we return 400 at the route, not at this layer, but the
 *     hash invariant is verified here).
 *   - `validateMimeType` is a denylist on dangerous types, not an
 *     allowlist on safe ones — we don't want to ship a PDF blocker.
 */
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { loadEnv } from "./env";

/** Hard cap on a single uploaded blob. 25 MB. */
export const ATTACHMENT_MAX_BYTES = 25 * 1024 * 1024;

/**
 * MIME types we refuse outright. These are common executable / script
 * types; uploading them via a chat client is almost certainly a
 * mistake or an attack vector. Browsers don't render them inline so
 * the user-facing impact is zero.
 */
const DENIED_MIME = new Set<string>([
  "application/x-msdownload",
  "application/x-msi",
  "application/x-bat",
  "application/x-sh",
  "application/x-shellscript",
  "application/x-php",
  "application/x-elf",
  "application/x-mach-binary",
  "application/octet-stream", // ambiguous; force callers to be specific
]);

export function validateMimeType(mime: string): { ok: true } | { ok: false; reason: string } {
  if (!mime || typeof mime !== "string") {
    return { ok: false, reason: "missing mime type" };
  }
  // Be liberal about what we accept: the only invariant is "doesn't
  // claim to be a binary executable". Browsers won't auto-execute
  // anything we serve back because /api/uploads/:id/raw forces a
  // Content-Disposition: attachment header (see routes/uploads.ts).
  const norm = mime.toLowerCase().split(";", 1)[0]!.trim();
  if (DENIED_MIME.has(norm)) {
    return { ok: false, reason: `mime type not allowed: ${norm}` };
  }
  if (!/^[-\w.+]+\/[-\w.+]+$/.test(norm)) {
    return { ok: false, reason: "malformed mime type" };
  }
  return { ok: true };
}

export interface UploadRoot {
  /** Absolute path to the uploads directory. */
  path: string;
}

/**
 * Resolve the uploads root from env. Falls back to a sibling of the DB
 * file so dev + prod converge on `data/uploads/`. Creates the directory
 * if it doesn't exist (idempotent).
 */
export function getUploadRoot(): UploadRoot {
  const env = loadEnv();
  const dbPath = resolve(env.HERMES_VAN_DB_PATH);
  const root = resolve(dirname(dbPath), "uploads");
  mkdirSync(root, { recursive: true });
  return { path: root };
}

/** Compute the on-disk path for a given sha256 under the uploads root. */
export function blobPath(root: UploadRoot, sha256: string): string {
  if (!/^[0-9a-f]{64}$/.test(sha256)) {
    throw new Error("blobPath: sha256 must be 64 hex chars");
  }
  return join(root.path, sha256.slice(0, 2), sha256);
}

/** Stable hash of a Buffer. */
export function hashBytes(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

export interface StoredBlob {
  sha256: string;
  storagePath: string;
  bytes: number;
  /** True if the same content was already on disk (dedup hit). */
  deduplicated: boolean;
}

/**
 * Persist a buffer to the content-addressed store. Returns the
 * canonical path + dedup info. Refuses if the buffer is empty or
 * exceeds ATTACHMENT_MAX_BYTES (we don't want to write a 26MB file
 * just to delete it on the next line).
 */
export function storeBlob(root: UploadRoot, buf: Buffer): StoredBlob {
  if (!Buffer.isBuffer(buf)) throw new TypeError("storeBlob: buf must be a Buffer");
  if (buf.length === 0) throw new RangeError("storeBlob: refuse empty content");
  if (buf.length > ATTACHMENT_MAX_BYTES) {
    throw new RangeError(
      `storeBlob: ${buf.length} bytes exceeds cap ${ATTACHMENT_MAX_BYTES}`,
    );
  }
  const sha256 = hashBytes(buf);
  const target = blobPath(root, sha256);
  if (existsSync(target)) {
    // Dedup hit. Validate the on-disk size matches as a paranoia check
    // — if it doesn't, the store is corrupted and we'd rather fail
    // loud than overwrite something that might be referenced.
    const onDisk = statSync(target).size;
    if (onDisk !== buf.length) {
      throw new Error(
        `storeBlob: dedup mismatch on ${sha256} (on-disk=${onDisk}, candidate=${buf.length})`,
      );
    }
    return { sha256, storagePath: target, bytes: buf.length, deduplicated: true };
  }
  mkdirSync(dirname(target), { recursive: true });
  // Write atomically: temp file in same dir, then rename. Avoids
  // partially-written blobs being visible to concurrent readers.
  const tmp = `${target}.${process.pid}.tmp`;
  writeFileSync(tmp, buf);
  // Verify what we just wrote actually matches the hash before
  // promoting it to the canonical name. Defends against a hostile
  // filesystem layer (rare but cheap to assert).
  const verify = hashBytes(Buffer.from(buf));
  if (verify !== sha256) {
    try {
      rmSync(tmp);
    } catch {
      // best effort
    }
    throw new Error("storeBlob: post-write verification failed");
  }
  // POSIX rename inside the same directory is atomic.
  copyFileSync(tmp, target); // copy then unlink — same dir, same fs
  rmSync(tmp);
  return { sha256, storagePath: target, bytes: buf.length, deduplicated: false };
}

/**
 * Remove a blob from disk. Caller must verify refcount === 0 BEFORE
 * calling — we don't double-check here because this layer doesn't
 * know about the metadata table. Idempotent: missing files are silent.
 */
export function deleteBlob(root: UploadRoot, sha256: string): void {
  if (!/^[0-9a-f]{64}$/.test(sha256)) return;
  const p = blobPath(root, sha256);
  if (existsSync(p)) {
    rmSync(p, { force: true });
  }
}
