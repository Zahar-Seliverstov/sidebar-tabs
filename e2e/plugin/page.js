"use strict";

// Тестовый плагин (только e2e): кнопка «нравится» тестовой страницы player.html?like=1.
(() => {
  const btn = () => document.getElementById("like");
  SidebarTabs.plugin("e2e-like", (plugin) => {
    plugin.button("like", {
      state: () => (btn() ? { active: btn().dataset.on === "1" } : null),
      press: () => btn().click(),
    });
    new MutationObserver(() => SidebarTabs.update()).observe(document.documentElement, { attributes: true, subtree: true });
  });
})();
