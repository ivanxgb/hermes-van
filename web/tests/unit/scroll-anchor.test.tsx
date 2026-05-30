/**
 * useScrollAnchor — IntersectionObserver-backed bottom-of-list anchor.
 *
 * jsdom doesn't ship IntersectionObserver, so we install a controllable
 * mock that records every observed node and exposes a `fire()` helper
 * for driving entry callbacks. We render a real component that mounts
 * the ref via JSX so the effect runs naturally.
 *
 * Coverage:
 *   1. Initial render: atBottom defaults to true.
 *   2. Sentinel intersecting → atBottom=true, scrolledFar=false.
 *   3. Sentinel out of view + close → atBottom=false, scrolledFar=false.
 *   4. Sentinel out of view + far → scrolledFar=true.
 *   5. scrollToBottom() calls scrollIntoView on the ref node.
 *   6. Missing IntersectionObserver → atBottom stays true.
 */
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { useImperativeHandle, forwardRef } from "react";

import { useScrollAnchor } from "../../src/lib/scroll-anchor";

interface Captured {
  cb: IntersectionObserverCallback;
  observed: Element[];
}

const observers: Captured[] = [];

class MockObserver {
  cb: IntersectionObserverCallback;
  observed: Element[] = [];
  constructor(cb: IntersectionObserverCallback) {
    this.cb = cb;
    observers.push({ cb, observed: this.observed });
  }
  observe(node: Element) {
    this.observed.push(node);
  }
  unobserve() {}
  disconnect() {}
  takeRecords() {
    return [];
  }
}

function fireEntry(
  index: number,
  options: { isIntersecting: boolean; topOffset: number },
) {
  const captured = observers[index];
  if (!captured) throw new Error(`No observer at index ${index}`);
  const node = captured.observed[0]!;
  const entry = {
    isIntersecting: options.isIntersecting,
    boundingClientRect: { top: options.topOffset } as DOMRectReadOnly,
    intersectionRatio: options.isIntersecting ? 1 : 0,
    intersectionRect: {} as DOMRectReadOnly,
    rootBounds: null,
    target: node,
    time: Date.now(),
  } as unknown as IntersectionObserverEntry;
  act(() => {
    captured.cb([entry], {} as IntersectionObserver);
  });
}

interface HarnessHandle {
  current: ReturnType<typeof useScrollAnchor>;
}

const Harness = forwardRef<HarnessHandle>(function Harness(_props, ref) {
  const anchor = useScrollAnchor();
  useImperativeHandle(ref, () => ({ current: anchor }), [anchor]);
  return <div ref={anchor.ref} data-testid="sentinel" />;
});

function mount() {
  const handle = { current: undefined as unknown as ReturnType<typeof useScrollAnchor> };
  // Wrap the imperative handle in a stable object so each render mutates
  // .current and the test can read the latest snapshot.
  const Wrapper = () => (
    <Harness ref={(h) => {
      if (h) handle.current = h.current;
    }} />
  );
  const utils = render(<Wrapper />);
  return { handle, ...utils };
}

beforeEach(() => {
  observers.length = 0;
  Object.defineProperty(window, "innerHeight", {
    configurable: true,
    value: 800,
  });
  // jsdom doesn't ship scrollIntoView; install a no-op so spies attach.
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    writable: true,
    value: () => undefined,
  });
  // @ts-expect-error — jsdom doesn't ship this.
  globalThis.IntersectionObserver = MockObserver;
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  // @ts-expect-error — restore for next file.
  delete globalThis.IntersectionObserver;
});

describe("useScrollAnchor", () => {
  test("defaults to atBottom=true and scrolledFar=false", () => {
    const { handle } = mount();
    expect(handle.current.atBottom).toBe(true);
    expect(handle.current.scrolledFar).toBe(false);
  });

  test("sentinel intersecting → atBottom=true, scrolledFar=false", () => {
    const { handle } = mount();
    fireEntry(0, { isIntersecting: true, topOffset: 200 });
    expect(handle.current.atBottom).toBe(true);
    expect(handle.current.scrolledFar).toBe(false);
  });

  test("close out-of-view → atBottom=false, scrolledFar=false", () => {
    const { handle } = mount();
    fireEntry(0, { isIntersecting: false, topOffset: 1000 });
    expect(handle.current.atBottom).toBe(false);
    expect(handle.current.scrolledFar).toBe(false);
  });

  test("far out-of-view → scrolledFar=true", () => {
    const { handle } = mount();
    fireEntry(0, { isIntersecting: false, topOffset: 5000 });
    expect(handle.current.atBottom).toBe(false);
    expect(handle.current.scrolledFar).toBe(true);
  });

  test("scrollToBottom calls scrollIntoView on the sentinel", () => {
    const { handle, getByTestId } = mount();
    const node = getByTestId("sentinel");
    const spy = vi
      .spyOn(node, "scrollIntoView")
      .mockImplementation(() => undefined);
    handle.current.scrollToBottom({ behavior: "auto" });
    expect(spy).toHaveBeenCalledWith({ behavior: "auto", block: "end" });
  });

  test("missing IntersectionObserver → atBottom stays true", () => {
    // @ts-expect-error — strip the mock for this test.
    delete globalThis.IntersectionObserver;
    const { handle } = mount();
    expect(handle.current.atBottom).toBe(true);
  });
});
