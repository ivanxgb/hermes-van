/**
 * Typed client for hermes-van's own /auth/* and /api/* endpoints.
 *
 * Handles:
 *  - CSRF: read csrf cookie, send X-CSRF-Token header on mutating verbs.
 *  - JSON encoding/decoding.
 *  - Error normalization: ApiError with status + parsed body.
 */

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: unknown,
    message?: string,
  ) {
    super(message ?? `HTTP ${status}`);
  }
}

function getCsrfTokenFromCookie(): string | null {
  if (typeof document === "undefined") return null;
  const match = document.cookie.match(/(?:^|;\s*)hv_csrf=([^;]+)/);
  return match?.[1] ?? null;
}

interface RequestOptions {
  body?: unknown;
  signal?: AbortSignal;
}

async function request<T>(
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
  path: string,
  opts: RequestOptions = {},
): Promise<T> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (method !== "GET") {
    const csrf = getCsrfTokenFromCookie();
    if (csrf) headers["X-CSRF-Token"] = csrf;
  }

  const init: RequestInit = {
    method,
    headers,
    credentials: "same-origin",
  };
  if (opts.signal) init.signal = opts.signal;
  if (opts.body !== undefined) init.body = JSON.stringify(opts.body);

  const res = await fetch(path, init);
  let body: unknown = null;
  const text = await res.text();
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  if (!res.ok) {
    const msg =
      body && typeof body === "object" && "error" in body && typeof body.error === "string"
        ? body.error
        : `HTTP ${res.status}`;
    throw new ApiError(res.status, body, msg);
  }
  return body as T;
}

export const api = {
  get: <T>(path: string, opts?: RequestOptions) => request<T>("GET", path, opts),
  post: <T>(path: string, body?: unknown, opts?: RequestOptions) =>
    request<T>("POST", path, { ...opts, body }),
  delete: <T>(path: string, opts?: RequestOptions) => request<T>("DELETE", path, opts),
};

// ─── Typed shapes ──────────────────────────────────────────────────────

export interface MeResponse {
  userId: string;
  username: string;
  sessionId: string;
  csrfToken: string | null;
  rpId: string;
}

export interface HealthResponse {
  status: "ok" | "degraded";
  service: string;
  version: string;
  time: string;
  gateway: { ok: boolean; latencyMs: number; error?: string };
}

export interface SetupOptionsResponse {
  options: PublicKeyCredentialCreationOptionsJSON;
  pendingUserId: string;
}

export interface SetupVerifyResponse {
  userId: string;
  username: string;
  recoveryCodes: string[];
  csrfToken: string;
}

export interface LoginOptionsResponse {
  options: PublicKeyCredentialRequestOptionsJSON;
}

export interface LoginVerifyResponse {
  userId: string;
  username: string;
  csrfToken: string;
}

// Local mirror of simplewebauthn JSON shapes — intentionally loose.
type PublicKeyCredentialCreationOptionsJSON = {
  challenge: string;
  rp: { id: string; name: string };
  user: { id: string; name: string; displayName: string };
  pubKeyCredParams: Array<{ type: "public-key"; alg: number }>;
  timeout?: number;
  excludeCredentials?: Array<{ id: string; type: "public-key"; transports?: string[] }>;
  authenticatorSelection?: Record<string, unknown>;
  attestation?: string;
};

type PublicKeyCredentialRequestOptionsJSON = {
  challenge: string;
  timeout?: number;
  rpId?: string;
  allowCredentials?: Array<{ id: string; type: "public-key"; transports?: string[] }>;
  userVerification?: string;
};

export const auth = {
  setupOptions: (input: { setupToken: string; username: string; displayName: string }) =>
    api.post<SetupOptionsResponse>("/auth/setup/options", input),
  setupVerify: (input: {
    setupToken: string;
    username: string;
    displayName: string;
    response: unknown;
  }) => api.post<SetupVerifyResponse>("/auth/setup/verify", input),
  loginOptions: (input: { username: string }) =>
    api.post<LoginOptionsResponse>("/auth/login/options", input),
  loginVerify: (input: { username: string; response: unknown }) =>
    api.post<LoginVerifyResponse>("/auth/login/verify", input),
  recovery: (input: { username: string; code: string }) =>
    api.post<LoginVerifyResponse>("/auth/recovery", input),
  logout: () => api.post<{ ok: true }>("/auth/logout"),
  logoutAll: () => api.post<{ ok: true; revoked: number }>("/auth/logout-all"),
  me: () => api.get<MeResponse>("/auth/me"),
  sessions: () => api.get<{ sessions: WebSessionRecord[] }>("/auth/sessions"),
  revokeSession: (id: string) =>
    api.post<{ ok: true; alreadyRevoked?: boolean }>(`/auth/sessions/${id}/revoke`),
  audit: (limit = 100) =>
    api.get<{ events: AuditRecord[] }>(`/auth/audit?limit=${limit}`),
};

export interface WebSessionRecord {
  id: string;
  createdAt: number;
  lastSeenAt: number;
  expiresAt: number;
  revokedAt: number | null;
  ip: string | null;
  userAgent: string | null;
  isCurrent: boolean;
}

export interface AuditRecord {
  id: string;
  ts: number;
  event: string;
  ip: string | null;
  userAgent: string | null;
  metadata: Record<string, unknown> | string | null;
}

export const sys = {
  health: () => api.get<HealthResponse>("/api/health"),
};

// ─── Chat shapes ────────────────────────────────────────────────────────

export type MessageStatus =
  | "pending"
  | "streaming"
  | "completed"
  | "failed"
  | "cancelled";

export type MessageRole = "user" | "assistant" | "system" | "tool";

export interface Chat {
  id: string;
  userId: string;
  title: string;
  gatewaySessionId: string;
  model: string | null;
  archivedAt: number | null;
  lastMessageAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface Message {
  id: string;
  chatId: string;
  userId: string;
  role: MessageRole;
  content: string;
  runId: string | null;
  status: MessageStatus;
  error: string | null;
  metadata: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface StartRunResponse {
  run: { id: string; chatId: string; status: string; messageId: string };
  userMessage: { id: string; role: string; content: string };
  assistantMessage: { id: string; role: string; content: string; status: MessageStatus };
}

export const chats = {
  list: (opts: { includeArchived?: boolean } = {}) => {
    const qs = opts.includeArchived ? "?includeArchived=true" : "";
    return api.get<{ chats: Chat[] }>(`/api/chats${qs}`);
  },
  create: (body: { title?: string; model?: string } = {}) =>
    api.post<{ chat: Chat }>("/api/chats", body),
  get: (id: string) => api.get<{ chat: Chat }>(`/api/chats/${id}`),
  patch: (id: string, body: { title?: string; archived?: boolean }) =>
    request<{ chat: Chat }>("PATCH", `/api/chats/${id}`, { body }),
  delete: (id: string) => api.delete<{ ok: true }>(`/api/chats/${id}`),
  messages: (id: string) =>
    api.get<{ messages: Message[] }>(`/api/chats/${id}/messages`),
  startRun: (id: string, body: { input: string; model?: string }) =>
    api.post<StartRunResponse>(`/api/chats/${id}/runs`, body),
  activeRun: (id: string) =>
    api.get<{
      run: {
        id: string;
        chatId: string;
        messageId: string;
        status: string;
        startedAt: number;
      } | null;
    }>(`/api/chats/${id}/active-run`),
};

export const runs = {
  stop: (runId: string) => api.post<{ ok: true }>(`/api/runs/${runId}/stop`),
  approve: (runId: string, choice: "once" | "session" | "always" | "deny") =>
    api.post<{ ok: true }>(`/api/runs/${runId}/approval`, { choice }),
};

// ─── Gateway capability shapes ─────────────────────────────────────────

export interface SkillRecord {
  name: string;
  description?: string | null;
  category?: string | null;
}

export interface ToolsetRecord {
  name: string;
  label?: string | null;
  description?: string | null;
  enabled?: boolean;
  configured?: boolean;
  tools?: string[];
}

export interface JobRecord {
  id: string;
  name?: string | null;
  prompt_preview?: string | null;
  schedule_display?: string | null;
  enabled?: boolean;
  state?: string | null;
  next_run_at?: string | null;
  last_run_at?: string | null;
  last_status?: string | null;
  last_error?: string | null;
  enabled_toolsets?: string[];
  skills?: string[];
  deliver?: string | null;
  origin?: { platform?: string; chat_name?: string; chat_id?: string } | null;
}

export const gateway = {
  skills: () => api.get<{ skills: SkillRecord[] }>("/api/gateway/skills"),
  toolsets: () => api.get<{ toolsets: ToolsetRecord[] }>("/api/gateway/toolsets"),
  jobs: () => api.get<{ jobs: JobRecord[] }>("/api/gateway/jobs"),
  forkChat: (chatId: string) =>
    api.post<{ chat: Chat; upstreamSession: Record<string, unknown> }>(
      `/api/gateway/chats/${chatId}/fork`,
    ),
};

// ─── Web Push ──────────────────────────────────────────────────────────

export interface PushTestResponse {
  ok: true;
  sent: number;
  failed: number;
  removed: number;
}

export const push = {
  publicKey: () => api.get<{ publicKey: string }>("/api/push/public-key"),
  subscribe: (sub: { endpoint: string; keys: { p256dh: string; auth: string } }) =>
    api.post<{ ok: true; subscription: { id: string; endpoint: string; createdAt: number } }>(
      "/api/push/subscribe",
      sub,
    ),
  unsubscribe: (endpoint: string) =>
    api.post<{ ok: true }>("/api/push/unsubscribe", { endpoint }),
  test: () => api.post<PushTestResponse>("/api/push/test"),
};

// ─── Uploads (Phase 6.D) ───────────────────────────────────────────
export interface AttachmentRecord {
  id: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  chatId: string | null;
  createdAt: number;
}

export interface UploadResponse extends AttachmentRecord {
  mediaUrl: string;
  deduplicated: boolean;
}

export const uploads = {
  list: (chatId?: string) =>
    api.get<{ items: AttachmentRecord[] }>(
      `/api/uploads${chatId ? `?chatId=${encodeURIComponent(chatId)}` : ""}`,
    ),
  /**
   * Multipart upload. We bypass the JSON helper because /api/uploads
   * expects FormData, and we still need the X-CSRF-Token cookie reflection.
   */
  async upload(file: File, chatId?: string): Promise<UploadResponse> {
    const fd = new FormData();
    fd.append("file", file, file.name);
    if (chatId) fd.append("chatId", chatId);
    const csrf =
      (document.cookie.match(/(?:^|;\s*)hv_csrf=([^;]+)/) ?? [])[1] ?? "";
    const res = await fetch("/api/uploads", {
      method: "POST",
      headers: { "X-CSRF-Token": csrf },
      body: fd,
      credentials: "same-origin",
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(body.error ?? `upload failed (${res.status})`);
    }
    return (await res.json()) as UploadResponse;
  },
  remove: (id: string) =>
    api.delete<{ ok: true; gcRemovedBlob: boolean }>(`/api/uploads/${id}`),
  rawUrl: (id: string) => `/api/uploads/${id}/raw`,
};

// ─── Metrics (Phase 6.G) ───────────────────────────────────────────
export interface UsageSummaryDto {
  totals: {
    messages: number;
    promptTokens: number;
    completionTokens: number;
    estUsd: number;
    pricelessRows: number;
  };
  byModel: Array<{
    model: string;
    messages: number;
    promptTokens: number;
    completionTokens: number;
    estUsd: number;
  }>;
  byChat: Array<{
    chatId: string;
    title: string;
    model: string | null;
    messages: number;
    promptTokens: number;
    completionTokens: number;
    estUsd: number;
  }>;
  byDay: Array<{
    date: string;
    promptTokens: number;
    completionTokens: number;
    estUsd: number;
  }>;
}

export const metrics = {
  usage: () => api.get<UsageSummaryDto>("/api/metrics/usage"),
};
