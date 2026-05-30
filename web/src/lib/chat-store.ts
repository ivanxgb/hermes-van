/**
 * Multi-chat stream registry.
 *
 * Holds the live state for every chat the user has open in this tab —
 * messages cache, in-flight EventSource, current run id. Components
 * subscribe via the `useChat(chatId)` hook; switching chats becomes a
 * cheap subscription change rather than a teardown/rebuild that would
 * abort the stream.
 *
 * Design constraints:
 *   - At most one live run per chat (matches gateway concurrency model
 *     and our active_runs schema).
 *   - Cross-tab streams are *not* shared. Closing the tab closes its
 *     EventSources; the agent itself keeps running on the gateway, so
 *     re-opening the chat will refetch finalized messages.
 *   - Components never construct EventSource directly — they call
 *     startChatRun() and the registry handles SSE lifecycle, delta
 *     accumulation, and finalization.
 */
import { useSyncExternalStore } from "react";
import {
  chats as chatsApi,
  type Chat,
  type Message,
  type MessageStatus,
} from "./api";

export interface RunState {
  runId: string;
  chatId: string;
  messageId: string;
  status: "streaming" | "completed" | "failed" | "cancelled";
  error: string | null;
  startedAt: number;
}

interface ChatState {
  /** Server-known message log (rehydrated from /api/chats/:id/messages). */
  messages: Message[];
  /** Current in-flight run, if any. */
  run: RunState | null;
  /** Last refresh time so we can throttle reloads. */
  lastFetchAt: number;
}

type Listener = () => void;

const EMPTY_CHAT_STATE: ChatState = { messages: [], run: null, lastFetchAt: 0 };

const chatStates = new Map<string, ChatState>();
const eventSources = new Map<string, EventSource>();
const listeners = new Map<string, Set<Listener>>();
const globalListeners = new Set<Listener>();

function emit(chatId: string) {
  for (const l of listeners.get(chatId) ?? []) l();
  globalSignal += 1;
  for (const l of globalListeners) l();
}

function getOrInit(chatId: string): ChatState {
  let s = chatStates.get(chatId);
  if (!s) {
    s = { messages: [], run: null, lastFetchAt: 0 };
    chatStates.set(chatId, s);
  }
  return s;
}

function patch(chatId: string, fn: (prev: ChatState) => ChatState) {
  const prev = getOrInit(chatId);
  chatStates.set(chatId, fn(prev));
  emit(chatId);
}

// ─── Public API ────────────────────────────────────────────────────────

/** Snapshot for one chat (returns the same reference until something changes). */
export function getChatState(chatId: string): ChatState {
  return getOrInit(chatId);
}

/** Subscribe one chat's state. */
function subscribeChat(chatId: string, listener: Listener): () => void {
  let set = listeners.get(chatId);
  if (!set) {
    set = new Set();
    listeners.set(chatId, set);
  }
  set.add(listener);
  return () => {
    set!.delete(listener);
    if (set!.size === 0) listeners.delete(chatId);
  };
}

/** Subscribe to ANY change in any chat (used by the sidebar for badges). */
function subscribeAll(listener: Listener): () => void {
  globalListeners.add(listener);
  return () => globalListeners.delete(listener);
}

/** React hook: consume chat state. */
export function useChat(chatId: string | null): ChatState {
  return useSyncExternalStore(
    (l) => (chatId ? subscribeChat(chatId, l) : () => {}),
    () => (chatId ? getOrInit(chatId) : EMPTY_CHAT_STATE),
    () => (chatId ? getOrInit(chatId) : EMPTY_CHAT_STATE),
  );
}

let globalSignal = 0;
/** React hook: subscribe to global cross-chat changes (for sidebar). */
export function useAnyChatChange(): number {
  return useSyncExternalStore(
    (l) => subscribeAll(l),
    () => globalSignal,
    () => globalSignal,
  );
}

/** Returns Map of chatId → run for chats currently streaming. Read-only. */
export function getActiveRuns(): ReadonlyMap<string, RunState> {
  const out = new Map<string, RunState>();
  for (const [chatId, state] of chatStates) {
    if (state.run && state.run.status === "streaming") out.set(chatId, state.run);
  }
  return out;
}

// ─── Loading / fetching ────────────────────────────────────────────────

/** Fetch the message log for a chat (force=true bypasses cache). */
export async function loadChat(
  chatId: string,
  opts: { force?: boolean } = {},
): Promise<void> {
  const state = getOrInit(chatId);
  if (!opts.force && state.lastFetchAt > 0 && Date.now() - state.lastFetchAt < 1500) {
    return;
  }
  try {
    const { messages } = await chatsApi.messages(chatId);
    patch(chatId, (s) => ({ ...s, messages, lastFetchAt: Date.now() }));
  } catch (err) {
    // Surface via console; the UI will see stale messages but no crash.
    // eslint-disable-next-line no-console
    console.warn("loadChat failed", err);
  }
}

// ─── Run lifecycle ─────────────────────────────────────────────────────

interface StartRunResult {
  chat: Chat;
  run: RunState;
  userMessageId: string;
  assistantMessageId: string;
}

/**
 * Kick off a run: persist user turn server-side, append optimistic rows
 * to the local cache, open the SSE stream, and route deltas back into
 * the cache. Returns the new run state.
 *
 * Throws if a run is already in flight for this chat.
 */
export async function startChatRun(
  chatId: string,
  input: string,
  opts: { userId: string },
): Promise<StartRunResult> {
  const existing = getOrInit(chatId).run;
  if (existing && existing.status === "streaming") {
    throw new Error("A run is already in flight for this chat");
  }

  const { run, userMessage, assistantMessage } = await chatsApi.startRun(chatId, {
    input,
  });
  const now = Date.now();

  // Optimistic write into local cache
  patch(chatId, (s) => ({
    ...s,
    messages: [
      ...s.messages,
      {
        id: userMessage.id,
        chatId,
        userId: opts.userId,
        role: "user",
        content: userMessage.content,
        runId: null,
        status: "completed" as MessageStatus,
        error: null,
        metadata: null,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: assistantMessage.id,
        chatId,
        userId: opts.userId,
        role: "assistant",
        content: "",
        runId: run.id,
        status: "streaming" as MessageStatus,
        error: null,
        metadata: null,
        createdAt: now,
        updatedAt: now,
      },
    ],
    run: {
      runId: run.id,
      chatId,
      messageId: assistantMessage.id,
      status: "streaming",
      error: null,
      startedAt: now,
    },
  }));

  openStream({ runId: run.id, chatId, messageId: assistantMessage.id });

  // Re-fetch chat metadata for last-message ordering
  void chatsApi.list().then(() => {
    /* the sidebar refresh is the consumer's responsibility */
  });

  return {
    chat: { id: chatId } as Chat, // placeholder — caller usually has the row
    run: getOrInit(chatId).run!,
    userMessageId: userMessage.id,
    assistantMessageId: assistantMessage.id,
  };
}

/** Open the SSE stream for a run and pipe deltas into the cache. */
function openStream(input: { runId: string; chatId: string; messageId: string }) {
  const { runId, chatId, messageId } = input;
  // Close any pre-existing stream for this chat just in case.
  eventSources.get(chatId)?.close();

  const es = new EventSource(`/api/runs/${runId}/events`);
  eventSources.set(chatId, es);

  const finalize = (
    status: "completed" | "failed" | "cancelled",
    error?: string,
  ) => {
    es.close();
    eventSources.delete(chatId);
    patch(chatId, (s) => ({
      ...s,
      run: s.run ? { ...s.run, status, error: error ?? null } : null,
      messages: s.messages.map((m) =>
        m.id === messageId ? { ...m, status, error: error ?? null } : m,
      ),
    }));
    // Re-pull authoritative state to capture any usage/metadata persisted server-side
    void loadChat(chatId, { force: true });
  };

  es.addEventListener("message.delta", (ev) => {
    try {
      const data = JSON.parse((ev as MessageEvent).data) as { delta?: string };
      const delta = String(data.delta ?? "");
      if (!delta) return;
      patch(chatId, (s) => ({
        ...s,
        messages: s.messages.map((m) =>
          m.id === messageId ? { ...m, content: m.content + delta } : m,
        ),
      }));
    } catch {
      // ignore malformed event
    }
  });

  es.addEventListener("run.completed", () => finalize("completed"));
  es.addEventListener("run.failed", (ev) => {
    let errMsg = "run failed";
    try {
      errMsg = JSON.parse((ev as MessageEvent).data).error ?? errMsg;
    } catch {
      // ignore
    }
    finalize("failed", errMsg);
  });
  es.addEventListener("run.cancelled", () => finalize("cancelled"));
  es.onerror = () => {
    if (es.readyState === EventSource.CLOSED) {
      finalize("failed", "stream closed");
    }
  };
}

/** Close every open stream — call on logout. */
export function closeAllStreams(): void {
  for (const es of eventSources.values()) {
    try {
      es.close();
    } catch {
      // ignore
    }
  }
  eventSources.clear();
  // Mark all live runs as cancelled in local state so UI updates.
  for (const [chatId, state] of chatStates) {
    if (state.run && state.run.status === "streaming") {
      patch(chatId, (s) => ({
        ...s,
        run: s.run ? { ...s.run, status: "cancelled" } : null,
      }));
    }
  }
}

/** Drop everything (used by logout). */
export function resetStreamStore(): void {
  closeAllStreams();
  chatStates.clear();
  for (const [, set] of listeners) set.clear();
  listeners.clear();
  for (const l of globalListeners) l();
}
