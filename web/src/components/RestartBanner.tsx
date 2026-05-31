/**
 * RestartBanner — heartbeats /api/version every 30s. If the server's
 * startedAt changes (process restarted) or the endpoint becomes
 * unreachable, surfaces a banner that prompts a reload.
 *
 * Two failure modes:
 *
 *  1. Server restarted (new startedAt) → "Servidor reiniciado · recargar".
 *     Reloading restores the SSE stream and picks up any fresh bundle.
 *
 *  2. Repeated heartbeat failures → "Sin conexión con el servidor".
 *     Could be VPS down, network blip, or restart in progress.
 *
 * The existing UpdateBanner handles "new SW bundle available". This
 * handles "process restarted, same bundle" — which UpdateBanner misses.
 *
 * Polls only when the tab is visible (saves CPU + battery on iOS).
 */
import { useEffect, useState } from "react";

const HEARTBEAT_MS = 30_000;
const FAIL_THRESHOLD = 3;

interface VersionResponse {
  startedAt: number;
  buildId: string;
}

export function RestartBanner() {
  const [needsReload, setNeedsReload] = useState<
    | null
    | { reason: "restart"; startedAt: number }
    | { reason: "offline" }
  >(null);

  useEffect(() => {
    let firstStartedAt: number | null = null;
    let consecutiveFailures = 0;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    async function tick() {
      if (cancelled) return;
      // Pause when the tab is hidden — pickup happens on visibilitychange.
      if (document.hidden) {
        timer = setTimeout(tick, HEARTBEAT_MS);
        return;
      }
      try {
        const res = await fetch("/api/version", {
          credentials: "same-origin",
          // Reasonable cap so a hung VPS doesn't block subsequent ticks.
          signal: AbortSignal.timeout(8000),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as VersionResponse;
        consecutiveFailures = 0;
        if (firstStartedAt === null) {
          firstStartedAt = data.startedAt;
        } else if (data.startedAt !== firstStartedAt) {
          if (!cancelled) {
            setNeedsReload({ reason: "restart", startedAt: data.startedAt });
          }
          return; // stop polling — banner is sticky
        }
      } catch {
        consecutiveFailures += 1;
        if (consecutiveFailures >= FAIL_THRESHOLD) {
          if (!cancelled) setNeedsReload({ reason: "offline" });
          // keep polling so the banner clears if connectivity returns
        }
      }
      if (!cancelled) timer = setTimeout(tick, HEARTBEAT_MS);
    }

    // Wake-up on visibility change resets failure count and triggers an
    // immediate check so the banner reflects current state quickly when
    // the user comes back to the tab.
    function onVisibility() {
      if (!document.hidden) {
        consecutiveFailures = 0;
        if (timer) clearTimeout(timer);
        void tick();
      }
    }
    document.addEventListener("visibilitychange", onVisibility);

    void tick();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  if (!needsReload) return null;

  const text =
    needsReload.reason === "restart"
      ? "Server restarted"
      : "Server unreachable";
  const cta = needsReload.reason === "restart" ? "reload" : "retry";

  return (
    <div
      role="status"
      className="update-banner"
      data-testid="restart-banner"
      data-reason={needsReload.reason}
    >
      <span className="update-banner-text">{text}</span>
      <button
        type="button"
        className="update-banner-btn"
        onClick={() => window.location.reload()}
      >
        {cta}
      </button>
    </div>
  );
}
