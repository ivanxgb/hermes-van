/**
 * Smart auto-scroll for the message list.
 *
 * Problem with naive scrollIntoView on every render: it rips the user
 * back down whenever a streaming delta lands, even if they scrolled up
 * to re-read earlier turns. That's hostile.
 *
 * Strategy: an IntersectionObserver watches a sentinel at the bottom
 * of the list. The hook publishes `atBottom` (true while the sentinel
 * is in view) and a `scrollToBottom()` callback. The caller is
 * responsible for triggering the scroll only when atBottom is true,
 * which preserves the user's reading position.
 *
 * Also returns a `scrolledFar` flag (>2× viewport away) so the UI can
 * show a "jump to latest" button conditionally — appearing the moment
 * the user is even one viewport up looks too eager.
 */
import { useCallback, useEffect, useRef, useState } from "react";

export interface ScrollAnchor {
  /**
   * Ref to attach to a 0-height sentinel <div> at the very end of the
   * scrollable container. The observer watches this node.
   */
  ref: React.RefObject<HTMLDivElement | null>;
  /** True while the sentinel is in the viewport (i.e. user is at bottom). */
  atBottom: boolean;
  /** True when the user has scrolled more than ~2 viewports up. */
  scrolledFar: boolean;
  /** Imperatively scroll to the sentinel. */
  scrollToBottom: (opts?: { behavior?: ScrollBehavior }) => void;
}

export function useScrollAnchor(): ScrollAnchor {
  const ref = useRef<HTMLDivElement | null>(null);
  const [atBottom, setAtBottom] = useState(true);
  const [scrolledFar, setScrolledFar] = useState(false);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    if (typeof IntersectionObserver === "undefined") {
      // SSR / very old environments — assume always at bottom so the
      // "jump to latest" button stays hidden and auto-scroll fires.
      setAtBottom(true);
      return;
    }
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry) return;
        setAtBottom(entry.isIntersecting);
        // Far if the sentinel is more than 2 viewports below the visible area.
        // entry.boundingClientRect.top is the sentinel's top relative to
        // the viewport; positive and large means it's far below the screen.
        const vh = window.innerHeight || 0;
        setScrolledFar(entry.boundingClientRect.top > vh * 2);
      },
      {
        // root=null watches the viewport; threshold 0 fires the moment any
        // pixel of the sentinel enters/leaves view. rootMargin -8px on the
        // bottom keeps "at bottom" stable for tiny composer-induced jitter.
        root: null,
        rootMargin: "0px 0px -8px 0px",
        threshold: 0,
      },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const scrollToBottom = useCallback(
    (opts: { behavior?: ScrollBehavior } = {}) => {
      ref.current?.scrollIntoView({
        behavior: opts.behavior ?? "smooth",
        block: "end",
      });
    },
    [],
  );

  return { ref, atBottom, scrolledFar, scrollToBottom };
}
