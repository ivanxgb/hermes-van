/**
 * Chat surface — sidebar with chat list + main panel for the active chat.
 *
 * State lives in the multi-chat store (lib/chat-store), so switching
 * chats does NOT abort an in-flight run. Each chat has its own
 * EventSource managed by the store; the sidebar shows a live indicator
 * for chats that are streaming in the background.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation } from "wouter";
import {
  chats as chatsApi,
  runs as runsApi,
  type Chat,
} from "../lib/api";
import { logout, useAuth } from "../lib/auth-store";
import {
  closeAllStreams,
  getActiveRuns,
  loadChat,
  startChatRun,
  useAnyChatChange,
  useChat,
} from "../lib/chat-store";

export function ChatPage() {
  const [, setLocation] = useLocation();
  const auth = useAuth();
  const [chatList, setChatList] = useState<Chat[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);

  // Subscribe to the global change signal so badges update in real time.
  useAnyChatChange();

  // Live state for the focused chat (subscribes to the store).
  const focused = useChat(selectedId);
  const focusedRun = focused.run;

  // Snapshot of every chat's run state, refreshed by the global subscription.
  const activeRuns = useMemo(() => getActiveRuns(), []);
  void activeRuns; // retained for clarity; getActiveRuns is read fresh per render below

  // ── load chat list on mount ──
  const refreshChats = useCallback(async () => {
    try {
      const { chats } = await chatsApi.list();
      setChatList(chats);
      if (!selectedId && chats[0]) setSelectedId(chats[0].id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load chats");
    }
  }, [selectedId]);

  useEffect(() => {
    void refreshChats();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Hydrate messages whenever a different chat is selected.
  useEffect(() => {
    if (!selectedId) return;
    void loadChat(selectedId);
  }, [selectedId]);

  // Auto-scroll
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [focused.messages, focusedRun?.status]);

  // ── actions ──

  async function onNewChat() {
    setError(null);
    try {
      const { chat } = await chatsApi.create({});
      setChatList((prev) => [chat, ...prev]);
      setSelectedId(chat.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create chat");
    }
  }

  async function onDeleteChat(id: string) {
    if (!confirm("Delete this chat? This cannot be undone.")) return;
    try {
      await chatsApi.delete(id);
      setChatList((prev) => prev.filter((c) => c.id !== id));
      if (selectedId === id) {
        setSelectedId(null);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Delete failed");
    }
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!selectedId || !input.trim()) return;
    if (focusedRun && focusedRun.status === "streaming") return;
    setError(null);
    const text = input;
    setInput("");

    try {
      await startChatRun(selectedId, text, { userId: auth.user?.userId ?? "" });
      // re-pull chat list so lastMessageAt ordering reflects this run
      void chatsApi.list().then(({ chats }) => setChatList(chats));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to start run");
    }
  }

  async function onStop() {
    if (!focusedRun) return;
    try {
      await runsApi.stop(focusedRun.runId);
    } catch {
      // ignore — server-side stop will fire run.cancelled regardless
    }
  }

  async function onLogout() {
    closeAllStreams();
    await logout();
    setLocation("/login");
  }

  const selectedChat = chatList.find((c) => c.id === selectedId) ?? null;
  const streaming = focusedRun?.status === "streaming";
  const canSend = !!selectedId && input.trim().length > 0 && !streaming;

  // Read fresh per-render so badges flip from streaming → idle as soon
  // as the store finalizes a run.
  const liveRuns = getActiveRuns();

  return (
    <div className="chat-shell">
      <aside className="sidebar" data-testid="chat-sidebar">
        <div className="sidebar-head">
          <span className="tag">— hermes-van</span>
          <button
            className="btn-primary btn-sm"
            type="button"
            onClick={onNewChat}
            data-testid="new-chat-btn"
          >
            + new
          </button>
        </div>
        <nav className="chat-list">
          {chatList.length === 0 ? (
            <div className="empty">no chats yet</div>
          ) : (
            chatList.map((c) => {
              const live = liveRuns.has(c.id);
              return (
                <div
                  key={c.id}
                  className={`chat-row ${c.id === selectedId ? "active" : ""}`}
                  onClick={() => setSelectedId(c.id)}
                  data-testid={`chat-row-${c.id}`}
                  data-live={live ? "true" : "false"}
                >
                  <span className="chat-title">{c.title}</span>
                  {live ? (
                    <span
                      className="live-dot"
                      data-testid={`chat-live-${c.id}`}
                      title="Streaming"
                    />
                  ) : null}
                  <button
                    className="btn-ghost btn-xs"
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      void onDeleteChat(c.id);
                    }}
                    aria-label="Delete chat"
                  >
                    ×
                  </button>
                </div>
              );
            })
          )}
        </nav>
        <div className="sidebar-foot">
          <span className="username">{auth.user?.username}</span>
          <button className="btn-text" type="button" onClick={() => setLocation("/settings")}>
            settings
          </button>
          <button className="btn-text" type="button" onClick={onLogout}>
            logout
          </button>
        </div>
      </aside>

      <main className="chat-main">
        {!selectedChat ? (
          <div className="empty-state">
            <h1>No chat selected.</h1>
            <p className="lead">Hit + new to start a conversation.</p>
          </div>
        ) : (
          <>
            <header className="chat-head">
              <h2 className="chat-title-lg" data-testid="active-chat-title">
                {selectedChat.title}
              </h2>
              {streaming ? (
                <button
                  className="btn-secondary btn-sm"
                  type="button"
                  onClick={onStop}
                  data-testid="stop-btn"
                >
                  stop
                </button>
              ) : null}
            </header>

            <section className="messages" data-testid="messages">
              {focused.messages.length === 0 ? (
                <div className="empty">no messages yet — say hi</div>
              ) : (
                focused.messages.map((m) => (
                  <article
                    key={m.id}
                    className={`msg msg-${m.role} msg-${m.status}`}
                    data-testid={`msg-${m.id}`}
                    data-role={m.role}
                    data-status={m.status}
                  >
                    <div className="msg-role">{m.role}</div>
                    <div className="msg-body">
                      {m.content || (m.status === "streaming" ? "…" : "")}
                      {m.status === "failed" && m.error ? (
                        <div className="msg-error">error: {m.error}</div>
                      ) : null}
                    </div>
                  </article>
                ))
              )}
              <div ref={messagesEndRef} />
            </section>

            {error ? <div className="error">{error}</div> : null}

            <form className="composer" onSubmit={onSubmit}>
              <textarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    void onSubmit(e as unknown as React.FormEvent);
                  }
                }}
                placeholder={
                  streaming
                    ? "Streaming… (this chat) — switch tabs freely"
                    : "Send a message (Enter to send, Shift+Enter for newline)"
                }
                disabled={streaming}
                rows={3}
                data-testid="composer-input"
              />
              <button
                type="submit"
                className="btn-primary"
                disabled={!canSend}
                data-testid="composer-send"
              >
                {streaming ? "Streaming…" : "Send"}
              </button>
            </form>
          </>
        )}
      </main>
    </div>
  );
}
