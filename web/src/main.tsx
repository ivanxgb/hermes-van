import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { UpdateBanner } from "./components/UpdateBanner";
import { bootTheme } from "./lib/theme";
import "./index.css";

// Apply the saved theme synchronously, BEFORE React mounts. This avoids
// a flash of the default palette on cold load. bootTheme() is a no-op
// when nothing is stored (default theme already matches the CSS).
bootTheme();

const rootEl = document.getElementById("root");
if (!rootEl) throw new Error("Root element #root not found");

createRoot(rootEl).render(
  <StrictMode>
    <App />
    <UpdateBanner />
  </StrictMode>,
);

// PWA service worker registration.
//
// Only register in production builds. In dev, the SW would cache Vite's
// HMR responses and break instant updates. Settings UI (Phase 5.D.1)
// also registers on demand for push subscriptions; this just ensures
// the SW is live for offline-shell caching from the first visit.
if (import.meta.env.PROD && "serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    void navigator.serviceWorker
      .register("/sw.js")
      .then((reg) => {
        // Poke the registration every 5 minutes — picks up new SW
        // bytes without requiring the user to navigate.
        setInterval(() => void reg.update().catch(() => {}), 5 * 60_000);
      })
      .catch(() => {
        // Failed registration is non-fatal: the app still works online.
      });
  });
}
