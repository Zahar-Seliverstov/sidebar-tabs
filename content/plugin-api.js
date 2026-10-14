"use strict";

/*
 * API плагинов для скриптов страниц (plugins/<id>/page.js).
 *
 * Фон подключает этот файл перед скриптами включённых плагинов — только на
 * сайтах из их plugin.json. Скрипты одного расширения в одном фрейме живут в
 * общей песочнице, поэтому плагин видит SidebarTabs, а content/media.js —
 * реестр кнопок (__mtbPlugins) и кладёт их состояние в строку плеера.
 *
 * Плагин описывает кнопки в plugin.json (значок, подписи), а здесь —
 * только их поведение:
 *
 *   SidebarTabs.plugin("vk-favorite", (plugin) => {
 *     plugin.button("favorite", {
 *       state() { return null | { active: true|false } },  // null — кнопки сейчас нет
 *       press() { ... },                                   // нажать (результат увидим через state)
 *     });
 *   });
 *   SidebarTabs.update();  // состояние могло измениться — плеер перечитает его
 *
 * setup вызывается один раз на страницу, даже если скрипт плагина попал в
 * неё дважды (подключён и при загрузке, и в уже открытую вкладку).
 *
 * Плеер и так перечитывает состояние при каждом своём изменении (трек,
 * пауза), update() нужен, когда меняется только кнопка.
 */

(() => {
  if (window.__mtbPlugins) return;

  const ID = /^[a-z0-9-]{1,40}$/;

  const P = (window.__mtbPlugins = {
    // "плагин/кнопка" → { state, press }
    buttons: new Map(),
    // Плагины, выключенные, пока страница открыта (подключённую копию не выгрузить).
    off: new Set(),
    // Плагины, уже подключённые к странице (фон не подключает их второй раз).
    loaded: new Set(),
    // Состояние кнопок для плеера: { "плагин/кнопка": активна? } — только доступные сейчас.
    snapshot() {
      const out = {};
      for (const [key, b] of P.buttons) {
        if (P.off.has(key.split("/")[0])) continue;
        let st = null;
        try {
          st = b.state();
        } catch (e) {}
        if (st && typeof st === "object") out[key] = st.active === true;
      }
      return out;
    },
    press(key) {
      const b = P.buttons.get(key);
      if (!b || P.off.has(key.split("/")[0])) return false;
      try {
        b.press();
        return true;
      } catch (e) {
        return false;
      }
    },
  });

  function update() {
    const M = window.__mtbMedia;
    if (M && M.refresh) M.refresh();
  }

  window.SidebarTabs = {
    plugin(pluginId, setup) {
      if (!ID.test(pluginId)) throw new Error("SidebarTabs: неверный id плагина " + pluginId);
      if (typeof setup !== "function") throw new Error("SidebarTabs: нужна функция setup");
      if (P.loaded.has(pluginId)) return;
      P.loaded.add(pluginId);
      setup({
        button(buttonId, impl) {
          if (!ID.test(buttonId)) throw new Error("SidebarTabs: неверный id кнопки " + buttonId);
          if (!impl || typeof impl.state !== "function" || typeof impl.press !== "function") {
            throw new Error("SidebarTabs: у кнопки нужны state() и press()");
          }
          P.buttons.set(pluginId + "/" + buttonId, impl);
          update();
        },
      });
    },
    update,
  };

  browser.runtime.onMessage.addListener((msg) => {
    if (!msg || msg.type !== "pluginEnabled" || !ID.test(msg.id)) return undefined;
    if (msg.enabled) P.off.delete(msg.id);
    else P.off.add(msg.id);
    update();
    return undefined;
  });
})();
