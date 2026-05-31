/**
 * ChatOverflowMenu — small ⋯ dropdown shown only on mobile, holds the
 * secondary actions (fork, export) that get crowded out of the header
 * on small screens. CSS gates visibility (`display: none` above 768px).
 *
 * Click-outside / Esc closes. No portal: the menu is small and the
 * header has no overflow:hidden ancestor we'd clip against.
 */
import { useEffect, useRef, useState } from "react";

interface Props {
  onFork: () => void;
  exportHref: string;
}

export function ChatOverflowMenu({ onFork, exportHref }: Props) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      if (!ref.current) return;
      if (!ref.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="chat-head-overflow" ref={ref}>
      <button
        type="button"
        className="btn-overflow"
        aria-label="More actions"
        aria-expanded={open}
        aria-haspopup="menu"
        data-testid="chat-overflow-btn"
        onClick={() => setOpen((v) => !v)}
      >
        ⋯
      </button>
      {open ? (
        <div className="overflow-menu" role="menu">
          <button
            type="button"
            role="menuitem"
            className="overflow-item"
            data-testid="overflow-fork"
            onClick={() => {
              setOpen(false);
              onFork();
            }}
          >
            Fork chat
          </button>
          <a
            role="menuitem"
            className="overflow-item"
            href={exportHref}
            data-testid="overflow-export"
            onClick={() => setOpen(false)}
          >
            Export as markdown
          </a>
        </div>
      ) : null}
    </div>
  );
}
