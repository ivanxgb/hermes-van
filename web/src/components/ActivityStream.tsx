/**
 * ActivityStream — renders the agent's tool calls and reasoning blocks
 * inline within an assistant message.
 *
 * This is the "mission control" view: instead of a lonely "…" while the
 * agent works, the user sees a structured stream of what's happening
 * right now. Each block has a left gutter that encodes type + status
 * (running phosphor, done bone, failed signal red).
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { ActivityBlock } from "../lib/chat-store";

interface Props {
  blocks: readonly ActivityBlock[];
  /** When true, shows a tail "thinking" placeholder if no blocks have arrived yet. */
  streaming: boolean;
}

export function ActivityStream({ blocks, streaming }: Props) {
  if (blocks.length === 0 && !streaming) return null;

  return (
    <div className="activity" data-testid="activity-stream">
      {blocks.map((b) =>
        b.kind === "tool" ? (
          <ToolBlockRow key={b.id} block={b} />
        ) : (
          <ReasoningBlockRow key={b.id} block={b} />
        ),
      )}
      {streaming && blocks.length === 0 ? <PendingPing /> : null}
    </div>
  );
}

function ToolBlockRow({
  block,
}: {
  block: Extract<ActivityBlock, { kind: "tool" }>;
}) {
  const dur = block.durationMs;
  const status = block.status;
  return (
    <div
      className={`activity-row activity-tool activity-${status}`}
      data-tool={block.tool}
      data-status={status}
    >
      <span className="activity-gutter" aria-hidden>
        {status === "running" ? <RunningDot /> : status === "done" ? "✓" : "✗"}
      </span>
      <span className="activity-kind">{block.tool}</span>
      {block.preview ? (
        <span className="activity-preview" title={block.preview}>
          {block.preview}
        </span>
      ) : null}
      {typeof dur === "number" ? (
        <span className="activity-meta">{formatDuration(dur)}</span>
      ) : null}
    </div>
  );
}

function ReasoningBlockRow({
  block,
}: {
  block: Extract<ActivityBlock, { kind: "reasoning" }>;
}) {
  const [open, setOpen] = useState(false);
  const preview = useMemo(() => firstLine(block.text), [block.text]);
  return (
    <div
      className={`activity-row activity-reasoning ${open ? "open" : ""}`}
      data-status="reasoning"
    >
      <button
        type="button"
        className="activity-toggle"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
      >
        <span className="activity-gutter" aria-hidden>
          ◆
        </span>
        <span className="activity-kind">thinking</span>
        {!open ? (
          <span className="activity-preview">{preview}</span>
        ) : (
          <span className="activity-meta">{open ? "hide" : "show"}</span>
        )}
      </button>
      {open ? <pre className="activity-body">{block.text}</pre> : null}
    </div>
  );
}

function PendingPing() {
  return (
    <div
      className="activity-row activity-pending"
      data-testid="activity-pending"
    >
      <span className="activity-gutter" aria-hidden>
        <RunningDot />
      </span>
      <span className="activity-kind">thinking</span>
    </div>
  );
}

function RunningDot() {
  return <span className="activity-dot" aria-hidden />;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0)}s`;
  const m = Math.floor(s / 60);
  const rest = Math.round(s - m * 60);
  return `${m}m${rest}s`;
}

function firstLine(s: string): string {
  const i = s.indexOf("\n");
  const head = (i >= 0 ? s.slice(0, i) : s).trim();
  return head.length > 120 ? `${head.slice(0, 120)}…` : head;
}

/**
 * Tiny hook to keep tool-row durations live while running. Increments a
 * tick every 250ms so the parent re-renders and shows a growing
 * elapsed time. Currently unused (we just show final duration on done)
 * but kept as a primitive for future polish.
 */
export function useTick(active: boolean): number {
  const [tick, setTick] = useState(0);
  const ref = useRef(tick);
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => {
      ref.current += 1;
      setTick(ref.current);
    }, 250);
    return () => clearInterval(t);
  }, [active]);
  return tick;
}
