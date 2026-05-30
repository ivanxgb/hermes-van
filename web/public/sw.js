/**
 * hermes-van service worker — Web Push only.
 *
 * Handles `push` and `notificationclick` events. The payload is a JSON
 * blob: { title, body, url?, tag? }. Falls back to defaults if the
 * server sends an empty push (which Web Push allows).
 */
/* global self, clients */

self.addEventListener("install", (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("push", (event) => {
  let data = { title: "hermes-van", body: "", tag: "hv" };
  if (event.data) {
    try {
      data = { ...data, ...event.data.json() };
    } catch {
      // Non-JSON payloads — show as raw text body.
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
      // If we already have a window open, focus it and navigate.
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
