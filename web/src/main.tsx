import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./index.css";

const rootEl = document.getElementById("root");
if (!rootEl) throw new Error("Root element #root not found");

createRoot(rootEl).render(
  <StrictMode>
    <App />
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
    navigator.serviceWorker.register("/sw.js").catch(() => {
      // Failed registration is non-fatal: the app still works online.
    });
  });
}
