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
  gateway as gatewayApi,
  type Chat,
} from "../lib/api";
import { logout, useAuth } from "../lib/auth-store";
import {
  closeAllStreams,
  getActiveRuns,
  getMessageActivity,
  getTotalUnread,
  getUnreadCounts,
  loadChat,
  setFocusedChat,
  startChatRun,
  useAnyChatChange,
  useChat,
} from "../lib/chat-store";
import { renderMarkdown, hardenLinks } from "../lib/markdown";
import { useScrollAnchor } from "../lib/scroll-anchor";
import { estimateTokens, formatTokens } from "../lib/token-estimate";
import { deriveChatTitle } from "../lib/derive-title";
import { CommandPalette } from "../components/CommandPalette";
import { ChatOverflowMenu } from "../components/ChatOverflowMenu";
import { SearchPalette } from "../components/SearchPalette";
import { ModelSelector } from "../components/ModelSelector";
import { ActivityStream } from "../components/ActivityStream";
import {
  SlashAutocomplete,
  getSlashMatches,
  type SlashMatch,
} from "../components/SlashAutocomplete";
import { useCommands } from "../lib/use-commands";
import { VoiceInput } from "../components/VoiceInput";
import { FileAttachButton } from "../components/FileAttachButton";
import { CopyButton } from "../components/CopyButton";

function MessageBody({ content, streaming }: { content: string; streaming: boolean }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const html = useMemo(() => renderMarkdown(content), [content]);
  useEffect(() => {
    if (ref.current) hardenLinks(ref.current);
  }, [html]);
  if (!content) return <>{streaming ? "…" : ""}</>;
  return (
    <div
      ref={ref}
      className="md"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

export function ChatPage() {
  const [, setLocation] = useLocation();
  const auth = useAuth();
  const [chatList, setChatList] = useState<Chat[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [slashActive, setSlashActive] = useState(0);
  // Live slash commands from the gateway. Hook caches across opens.
  const slashCommands = useCommands();
  const slashMatches = useMemo<SlashMatch[]>(
    () =>
      input.includes("\n") ? [] : getSlashMatches(slashCommands.commands, input),
    [input, slashCommands.commands],
  );
  useEffect(() => {
    if (slashActive >= slashMatches.length) setSlashActive(0);
  }, [slashMatches.length, slashActive]);
  const scroll = useScrollAnchor();

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
    setFocusedChat(selectedId);
    if (!selectedId) return;
    void loadChat(selectedId);
  }, [selectedId]);

  // Drop focus on unmount so background unread bumping resumes once
  // we navigate away from /chat.
  useEffect(() => {
    return () => setFocusedChat(null);
  }, []);

  // Reflect total unread in the document title so users notice when a
  // background chat finishes even with the tab unfocused.
  useEffect(() => {
    const total = getTotalUnread();
    document.title = total > 0 ? `(${total}) hermes-van` : "hermes-van";
  });

  // Auto-scroll, but only when the user is already at the bottom.
  // This prevents streaming deltas from yanking the viewport away when
  // they've scrolled up to re-read earlier turns. Deps use primitives
  // (length, status string) so this doesn't re-fire on every keystroke
  // because of object-reference churn.
  const messageCount = focused.messages.length;
  const lastMessageContent = focused.messages[focused.messages.length - 1]?.content ?? "";
  const runStatus = focusedRun?.status;
  useEffect(() => {
    if (scroll.atBottom) {
      scroll.scrollToBottom({ behavior: "smooth" });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messageCount, lastMessageContent, runStatus]);

  // Global keyboard shortcuts
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const meta = e.metaKey || e.ctrlKey;
      // Don't fire when typing in an input/textarea (except for the explicit
      // shortcut combos with Cmd/Ctrl which the user clearly meant).
      const target = e.target as HTMLElement | null;
      const inField =
        target?.tagName === "INPUT" ||
        target?.tagName === "TEXTAREA" ||
        target?.isContentEditable;
      if (meta && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((p) => !p);
        return;
      }
      if (meta && e.shiftKey && e.key.toLowerCase() === "f") {
        e.preventDefault();
        setSearchOpen((p) => !p);
        return;
      }
      if (meta && e.key.toLowerCase() === "n") {
        e.preventDefault();
        void onNewChat();
        return;
      }
      if (meta && e.key === "/") {
        e.preventDefault();
        setShortcutsOpen((p) => !p);
        return;
      }
      if ((e.key === "?" || (e.shiftKey && e.key === "/")) && !inField && !paletteOpen && !shortcutsOpen) {
        e.preventDefault();
        setShortcutsOpen(true);
        return;
      }
      if (e.key === "Escape") {
        if (shortcutsOpen) {
          setShortcutsOpen(false);
          return;
        }
        if (searchOpen) {
          setSearchOpen(false);
          return;
        }
        if (sidebarOpen) {
          setSidebarOpen(false);
          return;
        }
        if (!paletteOpen) {
          // Esc cancels an active stream when not in a field
          if (!inField && focusedRun?.status === "streaming") {
            void onStop();
          }
        }
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusedRun?.status, paletteOpen, searchOpen, shortcutsOpen, sidebarOpen]);

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
      setError(err instanceof Error ? err.message : "Failed to delete chat");
    }
  }

  async function onRenameChat(id: string) {
    const existing = chatList.find((c) => c.id === id);
    const next = window.prompt(
      "Rename chat",
      existing?.title ?? "",
    );
    if (next === null) return;
    const trimmed = next.trim();
    if (!trimmed || trimmed === existing?.title) return;
    try {
      const { chat } = await chatsApi.patch(id, { title: trimmed });
      setChatList((prev) => prev.map((c) => (c.id === id ? chat : c)));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to rename chat");
    }
  }

  async function onForkChat(id: string) {
    setError(null);
    try {
      const { chat } = await gatewayApi.forkChat(id);
      setChatList((prev) => [chat, ...prev]);
      setSelectedId(chat.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Fork failed");
    }
  }

  async function onChangeModel(id: string) {
    const existing = chatList.find((c) => c.id === id);
    const current = existing?.model ?? "";
    // Prompt UX is intentionally minimal — a free-form input mirrors how
    // the gateway itself accepts arbitrary model strings (no fixed enum
    // exposed). Empty input clears the override; cancel keeps current.
    const next = window.prompt(
      `Set model for "${existing?.title ?? id}".\nCurrent: ${current || "(default)"}\nLeave empty to clear.`,
      current,
    );
    if (next === null) return; // user cancelled
    const trimmed = next.trim();
    await setChatModel(id, trimmed === "" ? null : trimmed);
  }

  async function setChatModel(id: string, model: string | null) {
    setError(null);
    try {
      const { chat } = await chatsApi.patch(id, { model });
      setChatList((prev) => prev.map((c) => (c.id === id ? chat : c)));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Model change failed");
    }
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!selectedId || !input.trim()) return;
    if (focusedRun && focusedRun.status === "streaming") return;
    // If the entire input is a known slash command, execute it instead
    // of sending it as a message to the gateway.
    const trimmed = input.trim();
    const exact = slashCommands.commands.find((c) => `/${c.name}` === trimmed);
    if (exact) {
      setInput("");
      runSlash(`/${exact.name}`);
      return;
    }
    setError(null);
    const text = input;
    setInput("");

    // Auto-name the chat from the first user message. We treat any chat
    // that still has the default title ("New chat") and zero existing
    // messages as un-named. The title is derived locally — first sentence
    // up to ~60 chars — so there's no extra round-trip and it works even
    // when the gateway is slow.
    const currentChat = chatList.find((c) => c.id === selectedId);
    const isUnnamed =
      currentChat?.title === "New chat" && focused.messages.length === 0;
    if (isUnnamed) {
      const autoTitle = deriveChatTitle(text);
      // Fire and forget — don't block the run on the rename. If it
      // fails, the chat keeps "New chat" and the user can rename
      // manually with the ✎ button.
      void chatsApi
        .patch(selectedId, { title: autoTitle })
        .then(({ chat }) =>
          setChatList((prev) =>
            prev.map((c) => (c.id === selectedId ? chat : c)),
          ),
        )
        .catch(() => {
          /* non-fatal */
        });
    }

    try {
      await startChatRun(selectedId, text, { userId: auth.user?.userId ?? "" });
      // re-pull chat list so lastMessageAt ordering reflects this run
      void chatsApi.list().then(({ chats }) => setChatList(chats));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to start run");
    }
  }

  // UI-only slash commands — handled locally without hitting the gateway.
  // Anything not in this set is forwarded as plain input to the agent,
  // which handles its own slash commands (/goal, /skills, /topic, /usage,
  // /jobs-list, /reload-mcp, etc.) server-side.
  const UI_LOCAL_SLASH = new Set([
    "/new",
    "/settings",
    "/capabilities",
    "/jobs",
    "/fork",
    "/logout",
    "/help",
    "/clear",
    "/model",
  ]);

  function runSlash(slash: string) {
    if (slash === "/new") void onNewChat();
    else if (slash === "/settings") setLocation("/settings");
    else if (slash === "/capabilities") setLocation("/capabilities");
    else if (slash === "/jobs") setLocation("/jobs");
    else if (slash === "/fork") {
      if (selectedId) void onForkChat(selectedId);
    }
    else if (slash === "/logout") void onLogout();
    else if (slash === "/help") {
      setShortcutsOpen(true);
    } else if (slash === "/clear") {
      if (selectedId) void onDeleteChat(selectedId).then(() => onNewChat());
    } else if (slash === "/model") {
      if (!selectedId) {
        alert("Open a chat first to change its model.");
        return;
      }
      void onChangeModel(selectedId);
    } else {
      // Gateway-handled command (or unknown). Forward verbatim as a
      // user message — the agent will receive it on its next turn and
      // run the command itself. This is the same path Telegram and
      // CLI clients use, so the behavior stays consistent.
      if (!selectedId) {
        alert("Open a chat first to run a command.");
        return;
      }
      void startChatRun(selectedId, slash, { userId: auth.user?.userId ?? "" }).catch(
        (err) => setError(err instanceof Error ? err.message : "Failed to run command"),
      );
    }
  }

  function pickSlash(cmd: SlashMatch) {
    // For UI-local commands, just run them. For gateway commands,
    // populate the input with the command + space so the user can
    // type any args before sending.
    if (UI_LOCAL_SLASH.has(cmd.name)) {
      setInput("");
      runSlash(cmd.name);
      return;
    }
    // Pre-fill the composer with "<cmd> " so the user can keep typing args.
    setInput(`${cmd.name} `);
    setSlashActive(0);
  }

  async function onStop() {
    if (!focusedRun) return;
    try {
      await runsApi.stop(focusedRun.runId);
    } catch {
      // ignore — server-side stop will fire run.cancelled regardless
    }
  }

  async function onApprove(choice: "once" | "session" | "always" | "deny") {
    if (!focusedRun) return;
    try {
      await runsApi.approve(focusedRun.runId, choice);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Approval failed");
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
  const unreadCounts = getUnreadCounts();

  return (
    <div className={`chat-shell ${sidebarOpen ? "sidebar-open" : ""}`}>
      <button
        type="button"
        className="sidebar-backdrop"
        aria-label="Close sidebar"
        onClick={() => setSidebarOpen(false)}
        tabIndex={sidebarOpen ? 0 : -1}
      />
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
              const unread = unreadCounts.get(c.id) ?? 0;
              return (
                <div
                  key={c.id}
                  className={`chat-row ${c.id === selectedId ? "active" : ""}`}
                  onClick={() => {
                    setSelectedId(c.id);
                    setSidebarOpen(false);
                  }}
                  data-testid={`chat-row-${c.id}`}
                  data-live={live ? "true" : "false"}
                  data-unread={unread}
                >
                  <span className="chat-title">{c.title}</span>
                  {live ? (
                    <span
                      className="live-dot"
                      data-testid={`chat-live-${c.id}`}
                      title="Streaming"
                    />
                  ) : unread > 0 ? (
                    <span
                      className="unread-badge"
                      data-testid={`chat-unread-${c.id}`}
                      title={`${unread} new`}
                    >
                      {unread}
                    </span>
                  ) : null}
                  <span className="chat-actions">
                    <button
                      className="btn-ghost btn-xs"
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        void onRenameChat(c.id);
                      }}
                      aria-label="Rename chat"
                      title="Rename"
                      data-testid={`chat-rename-${c.id}`}
                    >
                      ✎
                    </button>
                    <button
                      className="btn-ghost btn-xs"
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        void onDeleteChat(c.id);
                      }}
                      aria-label="Delete chat"
                      title="Delete"
                      data-testid={`chat-delete-${c.id}`}
                    >
                      ×
                    </button>
                  </span>
                </div>
              );
            })
          )}
        </nav>
        <div className="sidebar-foot">
          <span className="username">{auth.user?.username}</span>
          <button
            className="btn-text"
            type="button"
            onClick={() => setLocation("/capabilities")}
            data-testid="nav-capabilities"
          >
            capabilities
          </button>
          <button
            className="btn-text"
            type="button"
            onClick={() => setLocation("/jobs")}
            data-testid="nav-jobs"
          >
            jobs
          </button>
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
            <button
              type="button"
              className="hamburger empty-state-hamburger"
              aria-label="Open chat list"
              data-testid="hamburger-btn"
              onClick={() => setSidebarOpen(true)}
            >
              <span></span>
              <span></span>
              <span></span>
            </button>
            <h1>No chat selected.</h1>
            <p className="lead">Hit + new to start a conversation.</p>
          </div>
        ) : (
          <>
            <header className="chat-head">
              <button
                type="button"
                className="hamburger"
                aria-label="Open chat list"
                data-testid="hamburger-btn"
                onClick={() => setSidebarOpen(true)}
              >
                <span></span>
                <span></span>
                <span></span>
              </button>
              <div className="chat-head-title">
                <h2 className="chat-title-lg" data-testid="active-chat-title">
                  {selectedChat.title}
                </h2>
                {(() => {
                  const state = focusedRun?.pendingApproval
                    ? "approval"
                    : focusedRun?.status === "streaming"
                      ? "streaming"
                      : focusedRun?.status === "failed"
                        ? "failed"
                        : "ready";
                  const label =
                    state === "streaming"
                      ? "Running"
                      : state === "approval"
                        ? "Waiting approval"
                        : state === "failed"
                          ? "Failed"
                          : "Ready";
                  const model = selectedChat.model || "default";
                  return (
                    <span
                      className="agent-status"
                      data-state={state}
                      data-testid="agent-status"
                      title={`${label} · ${model}`}
                    >
                      <span className="agent-status-dot" aria-hidden />
                      <span className="agent-status-label">
                        {label} · <span className="mono">{model}</span>
                      </span>
                    </span>
                  );
                })()}
              </div>
              <div className="chat-head-actions">
                <ModelSelector
                  value={selectedChat.model ?? null}
                  onPick={(id) => void setChatModel(selectedChat.id, id)}
                  disabled={streaming}
                />
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
                <button
                  className="btn-text chat-head-desktop"
                  type="button"
                  onClick={() => void onForkChat(selectedChat.id)}
                  data-testid="fork-btn"
                  title="Branch this chat — creates a new session pointing at the same upstream history"
                >
                  fork
                </button>
                <a
                  className="btn-text chat-head-desktop"
                  href={`/api/chats/${selectedChat.id}/export.md`}
                  data-testid="export-md"
                  title="Export this chat as markdown"
                >
                  export.md
                </a>
                <ChatOverflowMenu
                  onFork={() => void onForkChat(selectedChat.id)}
                  exportHref={`/api/chats/${selectedChat.id}/export.md`}
                />
              </div>
            </header>

            {focusedRun?.pendingApproval ? (
              <div
                className="approval-callout"
                data-testid="approval-callout"
                role="alertdialog"
                aria-live="assertive"
              >
                <div className="approval-head">
                  <span className="tag approval-tag">— approval required</span>
                  {focusedRun.pendingApproval.description ? (
                    <span className="approval-desc">
                      {focusedRun.pendingApproval.description}
                    </span>
                  ) : null}
                </div>
                <pre
                  className="approval-cmd"
                  data-testid="approval-command"
                >
                  {focusedRun.pendingApproval.command}
                </pre>
                <div className="approval-actions">
                  {focusedRun.pendingApproval.choices.map((choice) => (
                    <button
                      key={choice}
                      type="button"
                      className={`btn-sm ${
                        choice === "deny"
                          ? "btn-danger"
                          : choice === "once"
                            ? "btn-primary"
                            : "btn-secondary"
                      }`}
                      data-testid={`approve-${choice}`}
                      onClick={() => void onApprove(choice)}
                    >
                      {choice}
                    </button>
                  ))}
                </div>
              </div>
            ) : null}

            <section className="messages" data-testid="messages">
              {focused.messages.length === 0 ? (
                <div className="empty">no messages yet — say hi</div>
              ) : (
                focused.messages.map((m) => {
                  const isAssistant = m.role === "assistant";
                  const activity = isAssistant
                    ? getMessageActivity(selectedId ?? "", m.id)
                    : [];
                  const isStreaming = m.status === "streaming";
                  return (
                    <article
                      key={m.id}
                      className={`msg msg-${m.role} msg-${m.status}`}
                      data-testid={`msg-${m.id}`}
                      data-role={m.role}
                      data-status={m.status}
                    >
                      <div className="msg-head">
                        <span className="msg-role">{m.role}</span>
                        {m.status === "completed" && m.content ? (
                          <CopyButton text={m.content} testId={`copy-${m.id}`} />
                        ) : null}
                      </div>
                      <div className="msg-body">
                        {isAssistant ? (
                          <ActivityStream
                            blocks={activity}
                            streaming={isStreaming && !m.content}
                          />
                        ) : null}
                        <MessageBody
                          content={m.content}
                          streaming={isStreaming}
                        />
                        {m.status === "failed" && m.error ? (
                          <div className="msg-error">error: {m.error}</div>
                        ) : null}
                      </div>
                    </article>
                  );
                })
              )}
              <div ref={scroll.ref} />
            </section>

            {scroll.scrolledFar && !scroll.atBottom ? (
              <button
                type="button"
                className="jump-latest"
                onClick={() => scroll.scrollToBottom({ behavior: "smooth" })}
                data-testid="jump-latest"
                aria-label="Jump to latest message"
                title="Jump to latest"
              >
                ↓ latest
              </button>
            ) : null}

            {error ? <div className="error">{error}</div> : null}

            <form className="composer" onSubmit={onSubmit}>
              {slashMatches.length > 0 ? (
                <SlashAutocomplete
                  matches={slashMatches}
                  active={slashActive}
                  onPick={pickSlash}
                  onHover={setSlashActive}
                  grouped={input.trim() === "/"}
                />
              ) : null}
              <div className="composer-bar" data-streaming={streaming}>
                <FileAttachButton
                  disabled={streaming}
                  chatId={selectedId ?? undefined}
                  onAttached={(snippet) => {
                    setInput((prev) => {
                      if (prev.length === 0) return snippet;
                      const sep = prev.endsWith("\n") ? "" : "\n";
                      return `${prev}${sep}${snippet}`;
                    });
                  }}
                />
                <textarea
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={(e) => {
                    // Slash autocomplete keyboard handling — only when
                    // matches are visible. Tab and Enter (without Shift)
                    // commit; arrows navigate; Escape clears.
                    if (slashMatches.length > 0) {
                      if (e.key === "ArrowDown") {
                        e.preventDefault();
                        setSlashActive((i) => Math.min(slashMatches.length - 1, i + 1));
                        return;
                      }
                      if (e.key === "ArrowUp") {
                        e.preventDefault();
                        setSlashActive((i) => Math.max(0, i - 1));
                        return;
                      }
                      if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) {
                        e.preventDefault();
                        const cmd = slashMatches[slashActive];
                        if (cmd) pickSlash(cmd);
                        return;
                      }
                      if (e.key === "Escape") {
                        e.preventDefault();
                        setInput("");
                        return;
                      }
                    }
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      void onSubmit(e as unknown as React.FormEvent);
                    }
                  }}
                  placeholder={
                    streaming
                      ? "Add more context… agent is running"
                      : "Message Hermes…  (try / for commands)"
                  }
                  rows={1}
                  data-testid="composer-input"
                />
                <div className="composer-actions">
                  <VoiceInput
                    disabled={streaming}
                    onTranscript={(chunk, isFinal) => {
                      // Only commit final chunks to the input. Interim
                      // results would cause the textarea to reset on every
                      // partial transcription as the speech engine
                      // refines its guess; appending only on final keeps
                      // the visible text stable.
                      if (!isFinal) return;
                      setInput((prev) =>
                        prev.length > 0 && !prev.endsWith(" ")
                          ? `${prev} ${chunk.trim()}`
                          : `${prev}${chunk.trim()}`,
                      );
                    }}
                  />
                  {streaming ? (
                    <button
                      type="button"
                      className="btn-secondary btn-sm"
                      onClick={onStop}
                      data-testid="composer-stop"
                    >
                      Stop
                    </button>
                  ) : (
                    <button
                      type="submit"
                      className="btn-primary"
                      disabled={!canSend}
                      data-testid="composer-send"
                      aria-label="Send message"
                    >
                      ↑
                    </button>
                  )}
                </div>
              </div>
              <div className="composer-meta">
                <span className="composer-hint">
                  <kbd>/</kbd>
                  <span>commands</span>
                  <span aria-hidden> · </span>
                  <kbd>↵</kbd>
                  <span>send</span>
                  <span aria-hidden> · </span>
                  <kbd>⇧↵</kbd>
                  <span>newline</span>
                </span>
                {input.trim().length > 0 ? (
                  <span
                    className="composer-tokens"
                    data-testid="composer-tokens"
                    title="Rough token estimate (chars/4 + CJK fallback)"
                  >
                    {formatTokens(estimateTokens(input))}
                  </span>
                ) : null}
              </div>
            </form>
          </>
        )}
      </main>

      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        chats={chatList}
        onSelectChat={(id) => setSelectedId(id)}
        onNewChat={onNewChat}
        onSettings={() => setLocation("/settings")}
        onLogout={onLogout}
        onSlash={runSlash}
      />

      <SearchPalette
        open={searchOpen}
        onClose={() => setSearchOpen(false)}
        chats={chatList}
        onSelect={(chatId, messageId) => {
          setSelectedId(chatId);
          // The target message may not be in the DOM yet (chat switch +
          // store re-render). Poll up to 1.5s, then scroll + flash.
          const start = Date.now();
          function tryFocus() {
            const node = document.querySelector(
              `[data-testid="msg-${CSS.escape(messageId)}"]`,
            );
            if (node instanceof HTMLElement) {
              node.scrollIntoView({ behavior: "smooth", block: "center" });
              node.classList.add("msg-flash");
              window.setTimeout(() => node.classList.remove("msg-flash"), 1800);
              return;
            }
            if (Date.now() - start < 1500) {
              window.setTimeout(tryFocus, 80);
            }
          }
          requestAnimationFrame(() => requestAnimationFrame(tryFocus));
        }}
      />



      {shortcutsOpen && (
        <div
          className="palette-overlay"
          role="dialog"
          aria-modal="true"
          aria-label="Keyboard shortcuts"
          data-testid="shortcuts-overlay"
          onClick={(e) => {
            if (e.target === e.currentTarget) setShortcutsOpen(false);
          }}
        >
          <div className="shortcuts-panel">
            <div className="shortcuts-head">
              <span className="tag">— shortcuts</span>
              <button
                type="button"
                className="btn-text"
                onClick={() => setShortcutsOpen(false)}
                aria-label="Close shortcuts"
              >
                ×
              </button>
            </div>
            <ul className="shortcuts-list">
              <li><kbd>⌘</kbd> <kbd>K</kbd><span>command palette</span></li>
              <li><kbd>⌘</kbd> <kbd>⇧</kbd> <kbd>F</kbd><span>search messages</span></li>
              <li><kbd>⌘</kbd> <kbd>N</kbd><span>new chat</span></li>
              <li><kbd>⌘</kbd> <kbd>/</kbd><span>toggle this overlay</span></li>
              <li><kbd>?</kbd><span>show shortcuts</span></li>
              <li><kbd>Enter</kbd><span>send message</span></li>
              <li><kbd>Shift</kbd> <kbd>Enter</kbd><span>newline in composer</span></li>
              <li><kbd>Esc</kbd><span>close overlay / cancel stream / close sidebar</span></li>
            </ul>
            <div className="shortcuts-foot">
              <span className="text-dim">slash commands: type / in palette</span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
