/**
 * Attachment upload routes — Phase 6.D.
 *
 *   POST   /api/uploads             multipart upload of a single file
 *                                   → 201 { id, sha256, sizeBytes, ... }
 *   GET    /api/uploads             list this user's attachments (limit 100)
 *   GET    /api/uploads/:id         metadata for a single attachment
 *   GET    /api/uploads/:id/raw     stream the bytes back (auth required,
 *                                   Content-Disposition: attachment so the
 *                                   browser never auto-renders inline)
 *   DELETE /api/uploads/:id         remove metadata + blob if no other refs
 *
 * All routes require auth. Mutation routes additionally require CSRF
 * (matches /api/push/* and /api/chats/* contracts).
 *
 * The MEDIA: protocol used elsewhere in Hermes is just a stable URL
 * shape: when the chat layer wants to reference an attachment, it
 * stores `MEDIA:/api/uploads/<id>/raw` in the message body. The web
 * shell renders that as a link (or an inline preview for image/* types
 * once 6.D UI lands).
 */
import { Hono } from "hono";
import { z } from "zod";
import { createReadStream, statSync } from "node:fs";
import { ulid } from "../lib/id";
import { authRequired, csrfRequired } from "../middleware";
import { getDb } from "../db";
import { forUser } from "../db/scoped";
import { logger } from "../lib/logger";
import {
  ATTACHMENT_MAX_BYTES,
  blobPath,
  deleteBlob,
  getUploadRoot,
  storeBlob,
  validateMimeType,
} from "../lib/uploads";

export const uploadRoutes = new Hono();

uploadRoutes.use("*", authRequired);

const listSchema = z.object({
  chatId: z.string().min(1).max(64).optional(),
});

uploadRoutes.get("/", (c) => {
  const user = c.get("user");
  if (!user) return c.json({ error: "Unauthenticated" }, 401);
  const parsed = listSchema.safeParse({
    chatId: c.req.query("chatId") ?? undefined,
  });
  if (!parsed.success) return c.json({ error: "Invalid query" }, 400);
  const scoped = forUser(getDb(), user.id);
  const items = parsed.data.chatId
    ? scoped.attachments.listForChat(parsed.data.chatId)
    : scoped.attachments.listAll(100);
  return c.json({
    items: items.map((a) => ({
      id: a.id,
      filename: a.filename,
      mimeType: a.mimeType,
      sizeBytes: a.sizeBytes,
      sha256: a.sha256,
      chatId: a.chatId,
      createdAt: a.createdAt,
    })),
  });
});

uploadRoutes.get("/:id", (c) => {
  const user = c.get("user");
  if (!user) return c.json({ error: "Unauthenticated" }, 401);
  const id = c.req.param("id");
  const scoped = forUser(getDb(), user.id);
  const a = scoped.attachments.byId(id);
  if (!a) return c.json({ error: "Not found" }, 404);
  return c.json({
    id: a.id,
    filename: a.filename,
    mimeType: a.mimeType,
    sizeBytes: a.sizeBytes,
    sha256: a.sha256,
    chatId: a.chatId,
    createdAt: a.createdAt,
  });
});

uploadRoutes.get("/:id/raw", (c) => {
  const user = c.get("user");
  if (!user) return c.json({ error: "Unauthenticated" }, 401);
  const id = c.req.param("id");
  const scoped = forUser(getDb(), user.id);
  const a = scoped.attachments.byId(id);
  if (!a) return c.json({ error: "Not found" }, 404);

  const root = getUploadRoot();
  const path = blobPath(root, a.sha256);
  let size: number;
  try {
    size = statSync(path).size;
  } catch {
    // Metadata exists but the blob is gone. Surface a 410 Gone so the
    // client knows the file is irrecoverable, not just temporarily
    // unavailable.
    logger.error({ attachmentId: id, sha256: a.sha256 }, "blob missing on disk");
    return c.json({ error: "Attachment storage missing" }, 410);
  }

  const stream = createReadStream(path);
  // Force "attachment" disposition so the browser never tries to
  // execute or render unknown content inline. The chat UI calls this
  // endpoint for downloads; image previews use a separate `inline`
  // path scoped to image/* types only (added in the UI patch).
  const safeName = a.filename.replace(/[^\w.\- ]+/g, "_");
  const headers = new Headers({
    "content-type": a.mimeType,
    "content-length": String(size),
    "content-disposition": `attachment; filename="${safeName}"`,
    "cache-control": "private, max-age=31536000, immutable",
    // Defense in depth — even if the mime type is wrong, the browser
    // won't sniff into something dangerous.
    "x-content-type-options": "nosniff",
  });
  // hono/node-server can stream a Node Readable directly via the Web
  // ReadableStream wrapper. We construct one that pulls from the file
  // stream and pushes chunks into the controller.
  const body = new ReadableStream({
    start(controller) {
      stream.on("data", (chunk) => controller.enqueue(chunk));
      stream.on("end", () => controller.close());
      stream.on("error", (err) => controller.error(err));
    },
    cancel() {
      stream.destroy();
    },
  });
  return new Response(body, { status: 200, headers });
});

uploadRoutes.post("/", csrfRequired, async (c) => {
  const user = c.get("user");
  if (!user) return c.json({ error: "Unauthenticated" }, 401);

  const ct = c.req.header("content-type") ?? "";
  if (!ct.toLowerCase().startsWith("multipart/form-data")) {
    return c.json({ error: "expected multipart/form-data" }, 400);
  }

  let form: FormData;
  try {
    form = await c.req.formData();
  } catch (err) {
    logger.warn({ err }, "upload formData parse failed");
    return c.json({ error: "Invalid multipart body" }, 400);
  }

  const file = form.get("file");
  if (!(file instanceof File)) {
    return c.json({ error: "expected 'file' field with binary content" }, 400);
  }
  if (file.size <= 0) {
    return c.json({ error: "empty file" }, 400);
  }
  if (file.size > ATTACHMENT_MAX_BYTES) {
    return c.json(
      { error: `file exceeds limit (${ATTACHMENT_MAX_BYTES} bytes)` },
      413,
    );
  }
  const mime = file.type || "application/octet-stream";
  const mimeCheck = validateMimeType(mime);
  if (!mimeCheck.ok) {
    return c.json({ error: mimeCheck.reason }, 415);
  }
  const filenameRaw = (file.name || "upload").trim();
  // Strip path components and characters that don't belong in a
  // filename. Keep the original-ish name for display only — on disk
  // we use the sha256.
  const filename = filenameRaw
    .replace(/^.*[\\/]/, "")
    .slice(0, 255)
    .replace(/[\u0000-\u001f]/g, "_");

  const chatIdRaw = form.get("chatId");
  const chatId =
    typeof chatIdRaw === "string" && chatIdRaw.length > 0 && chatIdRaw.length <= 64
      ? chatIdRaw
      : null;

  const buf = Buffer.from(await file.arrayBuffer());
  const root = getUploadRoot();
  let stored;
  try {
    stored = storeBlob(root, buf);
  } catch (err) {
    logger.error({ err }, "storeBlob failed");
    return c.json({ error: "storage failed" }, 500);
  }

  const scoped = forUser(getDb(), user.id);
  const row = scoped.attachments.insert({
    id: ulid(),
    chatId,
    filename,
    mimeType: mime.toLowerCase().split(";", 1)[0]!.trim(),
    sizeBytes: stored.bytes,
    sha256: stored.sha256,
    storagePath: stored.storagePath,
  });

  return c.json(
    {
      id: row.id,
      filename: row.filename,
      mimeType: row.mimeType,
      sizeBytes: row.sizeBytes,
      sha256: row.sha256,
      chatId: row.chatId,
      createdAt: row.createdAt,
      mediaUrl: `MEDIA:/api/uploads/${row.id}/raw`,
      deduplicated: stored.deduplicated,
    },
    201,
  );
});

uploadRoutes.delete("/:id", csrfRequired, (c) => {
  const user = c.get("user");
  if (!user) return c.json({ error: "Unauthenticated" }, 401);
  const id = c.req.param("id");
  const scoped = forUser(getDb(), user.id);
  const a = scoped.attachments.byId(id);
  if (!a) return c.json({ error: "Not found" }, 404);
  const sha = a.sha256;
  scoped.attachments.delete(id);

  // GC the blob if this was the last reference (across all users —
  // refcount is a property of the storage layer, not of the user).
  const refs = scoped.attachments.refcountGlobal(sha);
  if (refs === 0) {
    try {
      deleteBlob(getUploadRoot(), sha);
    } catch (err) {
      logger.warn({ err, sha }, "blob gc failed");
    }
  }
  return c.json({ ok: true, gcRemovedBlob: refs === 0 });
});
