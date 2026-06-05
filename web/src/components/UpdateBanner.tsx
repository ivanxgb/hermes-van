/**
 * UpdateBanner — shows a discreet banner when a new service worker has
 * been installed and is waiting to activate. Click "reload" to send the
 * SKIP_WAITING message to the SW and refresh the page atomically.
 *
 * Strategy:
 *  - Register the SW (or grab existing registration).
 *  - Listen for `updatefound` on the registration; when the installing
 *    worker reaches `installed` AND there is a controller (i.e. this
 *    isn't the first install), surface the banner.
 *  - On click, post {type: 'SKIP_WAITING'} to the waiting worker; once
 *    `controllerchange` fires, reload.
 */
import { useEffect, useState } from "react";

export function UpdateBanner() {
  const [waiting, setWaiting] = useState<ServiceWorker | null>(null);

  useEffect(() => {
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;

    let cancelled = false;

    function watch(reg: ServiceWorkerRegistration) {
      // If a worker is already waiting (e.g. user reloaded after a
      // background install), surface immediately.
      if (reg.waiting && navigator.serviceWorker.controller) {
        setWaiting(reg.waiting);
      }
      reg.addEventListener("updatefound", () => {
        const installing = reg.installing;
        if (!installing) return;
        installing.addEventListener("statechange", () => {
          if (
            installing.state === "installed" &&
            navigator.serviceWorker.controller
          ) {
            setWaiting(installing);
          }
        });
      });
    }

    void (async () => {
      try {
        const reg = await navigator.serviceWorker.getRegistration("/sw.js");
        if (cancelled) return;
        if (reg) watch(reg);
        else {
          // first-load registration is handled in main.tsx; if it's not
          // ready yet, retry once after a short delay.
          setTimeout(async () => {
            const r2 = await navigator.serviceWorker.getRegistration("/sw.js");
            if (!cancelled && r2) watch(r2);
          }, 1500);
        }
      } catch {
        // ignore — banner just stays hidden
      }
    })();

    // controllerchange fires when SKIP_WAITING completes; reload then.
    const onController = () => window.location.reload();
    navigator.serviceWorker.addEventListener("controllerchange", onController);

    return () => {
      cancelled = true;
      navigator.serviceWorker.removeEventListener(
        "controllerchange",
        onController,
      );
    };
  }, []);

  if (!waiting) return null;

  return (
    <div
      role="status"
      className="update-banner"
      data-testid="update-banner"
    >
      <span className="update-banner-text">
        new version ready
      </span>
      <button
        type="button"
        className="update-banner-btn"
        onClick={() => waiting.postMessage({ type: "SKIP_WAITING" })}
      >
        reload
      </button>
    </div>
  );
}
