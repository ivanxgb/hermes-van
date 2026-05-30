/**
 * Chat surface — sidebar with chat list + active chat panel.
 *
 * Live streaming is wired to /api/runs/:id/events via EventSource.
 * The hook handles delta accumulation locally; the server persists
 * messages in parallel so a refresh restores state.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useLocation } from "wouter";
import {
  chats as chatsApi,
  runs as runsApi,
  type Chat,
  type Message,
} from "../lib/api";
import { logout, useAuth } from "../lib/auth-store";

interface StreamingState {
  runId: string | null;
  messageId: string | null;
  content: string;
  status: "idle" | "streaming" | "completed" | "failed" | "cancelled";
  error: string | null;
}

const IDLE_STREAM: StreamingState = {
  runId: null,
  messageId: null,
  content: "",
  status: "idle",
  error: null,
};

export function ChatPage() {
  const [, setLocation] = useLocation();
  const auth = useAuth();
  const [chatList, setChatList] = useState<Chat[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [stream, setStream] = useState<StreamingState>(IDLE_STREAM);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const esRef = useRef<EventSource | null>(null);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);

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

  // ── load messages when selected chat changes ──
  useEffect(() => {
    if (!selectedId) {
      setMessages([]);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const { messages: msgs } = await chatsApi.messages(selectedId);
        if (!cancelled) setMessages(msgs);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Failed to load messages");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedId]);

  // ── close any active SSE on unmount or chat switch ──
  useEffect(() => {
    return () => {
      esRef.current?.close();
      esRef.current = null;
    };
  }, []);

  // Auto-scroll on new messages or stream tick
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, stream.content]);

  // ── actions ──

  async function onNewChat() {
    setError(null);
    try {
      const { chat } = await chatsApi.create({});
      setChatList((prev) => [chat, ...prev]);
      setSelectedId(chat.id);
      setMessages([]);
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
        setMessages([]);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Delete failed");
    }
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!selectedId || !input.trim() || busy) return;
    setBusy(true);
    setError(null);
    const text = input;
    setInput("");

    try {
      const { run, userMessage, assistantMessage } = await chatsApi.startRun(
        selectedId,
        { input: text },
      );
      // Optimistically append user + assistant placeholder
      setMessages((prev) => [
        ...prev,
        {
          id: userMessage.id,
          chatId: selectedId,
          userId: auth.user?.userId ?? "",
          role: "user",
          content: userMessage.content,
          runId: null,
          status: "completed",
          error: null,
          metadata: null,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
        {
          id: assistantMessage.id,
          chatId: selectedId,
          userId: auth.user?.userId ?? "",
          role: "assistant",
          content: "",
          runId: run.id,
          status: "streaming",
          error: null,
          metadata: null,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      ]);
      setStream({
        runId: run.id,
        messageId: assistantMessage.id,
        content: "",
        status: "streaming",
        error: null,
      });
      openStream(run.id, assistantMessage.id, selectedId);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to start run");
      setBusy(false);
    }
  }

  function openStream(runId: string, messageId: string, chatId: string) {
    esRef.current?.close();
    const es = new EventSource(`/api/runs/${runId}/events`);
    esRef.current = es;

    es.addEventListener("message.delta", (ev) => {
      try {
        const data = JSON.parse((ev as MessageEvent).data) as { delta?: string };
        const delta = String(data.delta ?? "");
        setStream((s) => ({ ...s, content: s.content + delta }));
        setMessages((prev) =>
          prev.map((m) =>
            m.id === messageId ? { ...m, content: m.content + delta } : m,
          ),
        );
      } catch {
        // ignore
      }
    });

    const finalize = (status: "completed" | "failed" | "cancelled", error?: string) => {
      es.close();
      esRef.current = null;
      setStream({ ...IDLE_STREAM, status });
      setBusy(false);
      setMessages((prev) =>
        prev.map((m) =>
          m.id === messageId ? { ...m, status, error: error ?? null } : m,
        ),
      );
      // refresh chat list ordering (lastMessageAt updated server-side)
      void chatsApi.list().then(({ chats: cs }) => setChatList(cs));
      // re-fetch messages to pick up any usage metadata
      void chatsApi.messages(chatId).then(({ messages: ms }) => setMessages(ms));
    };

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
      // EventSource auto-retries; only treat as failure if we never get
      // a terminal event AND the readyState is closed.
      if (es.readyState === EventSource.CLOSED) {
        finalize("failed", "stream closed");
      }
    };
  }

  async function onStop() {
    if (!stream.runId) return;
    try {
      await runsApi.stop(stream.runId);
    } catch {
      // ignore
    }
  }

  async function onLogout() {
    await logout();
    setLocation("/login");
  }

  const selectedChat = chatList.find((c) => c.id === selectedId) ?? null;
  const canSend = !!selectedId && input.trim().length > 0 && !busy;

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
            chatList.map((c) => (
              <div
                key={c.id}
                className={`chat-row ${c.id === selectedId ? "active" : ""}`}
                onClick={() => setSelectedId(c.id)}
                data-testid={`chat-row-${c.id}`}
              >
                <span className="chat-title">{c.title}</span>
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
            ))
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
              {stream.status === "streaming" ? (
                <button className="btn-secondary btn-sm" type="button" onClick={onStop}>
                  stop
                </button>
              ) : null}
            </header>

            <section className="messages" data-testid="messages">
              {messages.length === 0 ? (
                <div className="empty">no messages yet — say hi</div>
              ) : (
                messages.map((m) => (
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
                placeholder={busy ? "Streaming…" : "Send a message (Enter to send, Shift+Enter for newline)"}
                disabled={busy}
                rows={3}
                data-testid="composer-input"
              />
              <button
                type="submit"
                className="btn-primary"
                disabled={!canSend}
                data-testid="composer-send"
              >
                {busy ? "Sending…" : "Send"}
              </button>
            </form>
          </>
        )}
      </main>
    </div>
  );
}
