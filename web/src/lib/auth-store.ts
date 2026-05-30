/**
 * Auth state. Single source of truth for "who is logged in".
 *
 * - bootstraps via GET /auth/me
 * - exposes login(), logout(), refresh()
 */
import { useSyncExternalStore } from "react";
import { ApiError, auth, type MeResponse } from "./api";

type Listener = () => void;

interface AuthState {
  status: "loading" | "anonymous" | "authenticated";
  user: MeResponse | null;
  error: string | null;
}

let state: AuthState = { status: "loading", user: null, error: null };
const listeners = new Set<Listener>();

function emit() {
  for (const l of listeners) l();
}

function setState(next: Partial<AuthState>) {
  state = { ...state, ...next };
  emit();
}

export async function refresh(): Promise<void> {
  try {
    const me = await auth.me();
    setState({ status: "authenticated", user: me, error: null });
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) {
      setState({ status: "anonymous", user: null, error: null });
    } else {
      setState({
        status: "anonymous",
        user: null,
        error: err instanceof Error ? err.message : "auth probe failed",
      });
    }
  }
}

export async function logout(): Promise<void> {
  try {
    await auth.logout();
  } catch {
    // ignore — even if the server didn't accept, we forget locally
  }
  setState({ status: "anonymous", user: null, error: null });
}

export function useAuth(): AuthState {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => state,
    () => state,
  );
}

export function bootstrapAuth() {
  void refresh();
}
