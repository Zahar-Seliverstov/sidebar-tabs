"use strict";

/*
 * Запуск панели: первое чтение состояния и подписки. Подключается
 * последним — к этому моменту объявлено всё остальное.
 * Общие состояние и функции — в sidebar.js (обычные скрипты делят одну
 * глобальную область, порядок подключения — в sidebar.html).
 */

// ---------------------------------------------------------------- старт

(async () => {
  try {
    const [win, stored, volumes, media, mic] = await Promise.all([
      browser.windows.getCurrent(),
      browser.storage.local.get(["favicons", SidebarSettings.SETTINGS_KEY]).catch(() => ({})),
      browser.runtime.sendMessage({ type: "getVolumes" }).catch(() => ({})),
      browser.runtime.sendMessage({ type: "getMedia" }).catch(() => []),
      browser.runtime.sendMessage({ type: "getMic" }).catch(() => ({})),
    ]);
    state.windowId = win.id;
    state.incognito = !!win.incognito;
    state.media = Array.isArray(media) ? media : [];
    for (const [id, v] of Object.entries(volumes || {})) state.volumes.set(Number(id), v);
    for (const [id, m] of Object.entries(mic || {})) state.mic.set(Number(id), m);
    if (stored.favicons && typeof stored.favicons === "object") {
      state.favicons = new Map(Object.entries(stored.favicons));
    }
    state.settings = SidebarSettings.normalizeSettings(stored[SidebarSettings.SETTINGS_KEY]);
    loadPlugins().catch(report);
    listenSettings();
    listenShortcuts();
    listenContainers();
    listenClosed();
    listenTheme();
    listenMedia();
    listen();
    await resync();
  } catch (err) {
    report(err);
  }
})();
