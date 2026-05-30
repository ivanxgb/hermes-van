/**
 * hermes-van service worker.
 *
 * Two responsibilities:
 *
 *  1. Web Push (Phase 5.D.1) — handles `push` and `notificationclick`.
 *     Payload is a JSON blob: { title, body, url?, tag? }. Falls back
 *     to defaults if the push body is empty (which Web Push allows).
 *
 *  2. Offline shell / runtime cache (Phase 6.A) — keeps a single
 *     versioned cache populated on the fly. Strategy by route class:
 *
 *       /api/*, /auth/*       → network-only, never cached. Auth
 *                                cookies and user data must never be
 *                                served stale.
 *       /assets/*              → stale-while-revalidate. Vite emits
 *                                content-hashed bundles, so a cached
 *                                response with the same URL is by
 *                                definition still correct.
 *       navigations (mode:     → network-first, fall back to the last
 *       navigate, doc-shaped)    cached navigation. This is what makes
 *                                a hard reload work offline once the
 *                                user has visited at least once.
 *       everything else         → stale-while-revalidate.
 *
 * Cache name is versioned so bumping `CACHE_VERSION` evicts everything
 * older during `activate`. Bump on breaking changes to the asset graph.
 */
/* global self, caches, fetch, Response */

const CACHE_VERSION = "hermes-van-v1";
const OFFLINE_FALLBACK_URL = "/";

self.addEventListener("install", (event) => {
  // Open the cache early so the very first navigation has somewhere
  // to land. Don't precache anything — runtime caching on first
  // successful nav will fill it in. Avoids guessing hashed asset URLs.
  event.waitUntil(
    (async () => {
      await caches.open(CACHE_VERSION);
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      // Evict caches from older versions of this SW.
      const names = await caches.keys();
      await Promise.all(
        names
          .filter((n) => n !== CACHE_VERSION && n.startsWith("hermes-van-"))
          .map((n) => caches.delete(n)),
      );
      await self.clients.claim();
    })(),
  );
});

/**
 * True for any request that should never see a cached response.
 * Includes the OPTIONS preflights for those paths.
 */
function isNeverCache(req) {
  try {
    const url = new URL(req.url);
    if (url.origin !== self.location.origin) return true;
    const p = url.pathname;
    return (
      p.startsWith("/api/") ||
      p.startsWith("/auth/") ||
      p.startsWith("/v1/") ||
      // SSE — keep streaming through, never cache.
      p.endsWith("/events") ||
      // Service worker source itself: must always come from the network
      // so the browser sees updates. (Browsers do their own SW update
      // bypass, but this is belt-and-braces.)
      p === "/sw.js"
    );
  } catch {
    return true;
  }
}

function isAssetGet(req) {
  if (req.method !== "GET") return false;
  try {
    return new URL(req.url).pathname.startsWith("/assets/");
  } catch {
    return false;
  }
}

function isNavigation(req) {
  if (req.mode === "navigate") return true;
  // Some browsers issue document-shaped GETs without mode=navigate
  // (e.g. iframe, prerender). Treat HTML accept-headers as navigations.
  const accept = req.headers.get("accept") || "";
  return req.method === "GET" && accept.includes("text/html");
}

async function staleWhileRevalidate(event) {
  const cache = await caches.open(CACHE_VERSION);
  const cached = await cache.match(event.request);
  const networkP = fetch(event.request)
    .then((res) => {
      // Only cache OK same-origin responses.
      if (res && res.ok && res.type !== "opaque") {
        cache.put(event.request, res.clone()).catch(() => {});
      }
      return res;
    })
    .catch(() => null);
  return cached ?? (await networkP) ?? new Response("offline", { status: 504 });
}

async function networkFirstNavigation(event) {
  const cache = await caches.open(CACHE_VERSION);
  try {
    const fresh = await fetch(event.request);
    if (fresh && fresh.ok) {
      cache.put(event.request, fresh.clone()).catch(() => {});
    }
    return fresh;
  } catch {
    // Network down. Try the same URL from cache, then the offline
    // fallback shell, then a hard 504.
    const cached =
      (await cache.match(event.request)) ??
      (await cache.match(OFFLINE_FALLBACK_URL));
    return (
      cached ??
      new Response(
        "<!doctype html><meta charset=utf-8><title>offline</title>" +
          "<h1>offline</h1><p>hermes-van is offline. Reconnect and refresh.</p>",
        { status: 504, headers: { "content-type": "text/html; charset=utf-8" } },
      )
    );
  }
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return; // mutations are never cached
  if (isNeverCache(req)) return; // pass through to network

  if (isNavigation(req)) {
    event.respondWith(networkFirstNavigation(event));
    return;
  }
  if (isAssetGet(req)) {
    event.respondWith(staleWhileRevalidate(event));
    return;
  }
  // Default: stale-while-revalidate for any same-origin GET. Falls
  // through to the network for cross-origin GETs that we never cache.
  try {
    if (new URL(req.url).origin === self.location.origin) {
      event.respondWith(staleWhileRevalidate(event));
    }
  } catch {
    // ignore — pass through
  }
});

// ---------------------------------------------------------------------
// Web Push (Phase 5.D.1) — preserved verbatim. Adding caching above
// must not break notification delivery.
// ---------------------------------------------------------------------

self.addEventListener("push", (event) => {
  let data = { title: "hermes-van", body: "", tag: "hv" };
  if (event.data) {
    try {
      data = { ...data, ...event.data.json() };
    } catch {
      data = { ...data, body: event.data.text() };
    }
  }

  const opts = {
    body: data.body,
    tag: data.tag,
    icon: "/favicon.ico",
    badge: "/favicon.ico",
    data: { url: data.url ?? "/" },
  };

  event.waitUntil(self.registration.showNotification(data.title, opts));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = event.notification.data?.url ?? "/";

  event.waitUntil(
    (async () => {
      const all = await self.clients.matchAll({
        type: "window",
        includeUncontrolled: true,
      });
      for (const c of all) {
        if ("focus" in c) {
          await c.focus();
          if ("navigate" in c) await c.navigate(target);
          return;
        }
      }
      await self.clients.openWindow(target);
    })(),
  );
});
