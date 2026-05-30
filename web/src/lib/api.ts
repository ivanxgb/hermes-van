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
};

export const sys = {
  health: () => api.get<HealthResponse>("/api/health"),
};
