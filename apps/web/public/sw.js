/*
 * Kru Bot's service worker: shows a push notification when a bot finishes
 * or needs input, unless that conversation is already in front of you, and
 * opens the conversation when you click it.
 */
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: "Kru Bot", body: event.data ? event.data.text() : "" };
  }
  event.waitUntil(
    (async () => {
      const url = new URL(data.url || "/app", self.location.origin);
      const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const inFront = clients.some((client) => client.focused && client.visibilityState === "visible" && new URL(client.url).pathname === url.pathname);
      if (inFront) return;
      await self.registration.showNotification(data.title || "Kru Bot", {
        body: data.body || "",
        tag: data.tag || undefined,
        renotify: Boolean(data.tag),
        icon: "/logo.png",
        badge: "/logo.png",
        data: { url: url.href },
      });
    })(),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || "/app";
  event.waitUntil(
    (async () => {
      const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const client of clients) {
        if (new URL(client.url).origin !== self.location.origin) continue;
        await client.focus();
        if ("navigate" in client) await client.navigate(url);
        return;
      }
      await self.clients.openWindow(url);
    })(),
  );
});
