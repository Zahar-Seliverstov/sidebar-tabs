"use strict";

/*
 * Только для e2e: подключается к фону тестовой копии расширения (run.js
 * дописывает его в manifest.json вместе с e2e-config.js, где E2E_ORIGIN).
 * Каждые REPORT_MS отправляет раннеру то, что сейчас показал бы плеер
 * (mediaList()) и вкладки; забирает у раннера команды и возвращает результат.
 * В собранное расширение не попадает.
 */

(() => {
  const REPORT_MS = 200;
  const POLL_MS = 100;

  const post = (path, body) =>
    fetch(E2E_ORIGIN + path, { method: "POST", body: JSON.stringify(body) }).catch(() => {});

  async function report() {
    try {
      const tabs = await browser.tabs.query({});
      await post("/hook/state", {
        at: Date.now(),
        sessions: mediaList(),
        tabs: tabs.map((t) => ({
          id: t.id,
          url: t.url,
          audible: !!t.audible,
          status: t.status,
          discarded: !!t.discarded,
          mic: !!(t.sharingState && t.sharingState.microphone),
        })),
      });
    } catch (err) {
      await post("/hook/error", { message: String(err) });
    }
    setTimeout(report, REPORT_MS);
  }

  function optionsView() {
    return browser.extension.getViews({ type: "tab" }).find((v) => v.location.pathname.endsWith("/options/options.html"));
  }

  function panel() {
    return browser.extension.getViews({ type: "tab" }).find((v) => v.location.pathname.endsWith("/sidebar/sidebar.html"));
  }

  async function execute(cmd) {
    switch (cmd.op) {
      case "open":
        return (await browser.tabs.create({ url: cmd.url, active: true })).id;
      case "close":
        await browser.tabs.remove(cmd.tabId);
        return true;
      case "navigate":
        await browser.tabs.update(cmd.tabId, { url: cmd.url });
        return true;
      case "discard":
        await browser.tabs.update(cmd.tabId, { active: false }).catch(() => {});
        await browser.tabs.create({ url: "about:blank", active: true });
        await browser.tabs.discard(cmd.tabId);
        return true;
      case "control":
        return mediaControl({ tabId: cmd.tabId, frameId: cmd.frameId, action: cmd.action, seekTime: cmd.seekTime });
      case "cleanup": {
        // После упавшего сценария: закрыть его вкладки, чтобы не мешали следующим.
        const tabs = await browser.tabs.query({ url: E2E_ORIGIN + "/*" });
        await browser.tabs.remove(tabs.map((t) => t.id));
        return true;
      }
      case "reloadExt":
        // Как обновление расширения: старые копии скриптов в страницах умирают.
        setTimeout(() => browser.runtime.reload(), 100);
        return true;
      case "getMedia":
        await verifyMedia();
        return mediaList();
      case "page":
        // Вызов api страницы (window.api.<fn>()) — из песочницы content-скрипта.
        await browser.tabs.executeScript(cmd.tabId, { code: `window.wrappedJSObject.api.${cmd.fn}();` });
        return true;
      case "pageState": {
        const [json] = await browser.tabs.executeScript(cmd.tabId, { code: "JSON.stringify(window.wrappedJSObject.api.state())" });
        return JSON.parse(json);
      }
      // --- настоящая панель: открывается в отдельном окне (в фоновой
      // вкладке requestAnimationFrame не работает — панель бы не рисовалась).
      case "uiOpen": {
        const win = await browser.windows.create({ url: browser.runtime.getURL("sidebar/sidebar.html") });
        for (let i = 0; i < 100 && !panel(); i++) await new Promise((r) => setTimeout(r, 50));
        if (!panel()) throw new Error("панель не открылась");
        return win.id;
      }
      case "uiPlayer":
        return [...panel().document.querySelectorAll("#player-list .pr")].map((el) => ({
          tab: Number(el.dataset.tab),
          title: el.querySelector(".pr-title").textContent,
          center: el.classList.contains("center"),
          playIcon: el.querySelector(".pl-play").dataset.icon,
          playHidden: el.querySelector(".pl-play").hidden,
          // Предыдущий/следующий — на пульте, он про строку в центре.
          prevHidden: !el.classList.contains("center") || panel().document.querySelector('#deck [data-act="previoustrack"]').classList.contains("off"),
          nextHidden: !el.classList.contains("center") || panel().document.querySelector('#deck [data-act="nexttrack"]').classList.contains("off"),
          note: panel().document.getElementById("deck-note").hidden ? "" : panel().document.getElementById("deck-note-text").textContent,
          pending: panel().document.getElementById("player").classList.contains("pending"),
        }));
      case "uiControl": {
        // Регулятор во строке вкладки: виден ли, значок, проценты.
        const el = panel().document.querySelector(cmd.selector);
        if (!el) return null;
        return {
          shown: panel().getComputedStyle(el).display !== "none",
          icon: el.querySelector(".vicon").dataset.icon,
          muted: el.classList.contains("muted"),
          blocked: el.classList.contains("blocked"),
          pct: el.querySelector(".vpct").textContent,
        };
      }
      case "uiClick": {
        const el = panel().document.querySelector(cmd.selector);
        if (!el) throw new Error("нет элемента " + cmd.selector);
        el.click();
        return true;
      }
      case "uiWheel": {
        const view = panel();
        const el = view.document.querySelector(cmd.selector);
        if (!el) throw new Error("нет элемента " + cmd.selector);
        el.dispatchEvent(new view.WheelEvent("wheel", { deltaY: cmd.deltaY, deltaMode: 0, bubbles: true, cancelable: true }));
        return true;
      }
      case "setPlugin":
        return setPluginEnabled(cmd.plugin, cmd.enabled);
      case "uiButton": {
        const el = panel().document.querySelector(cmd.selector);
        if (!el) return null;
        return { on: el.classList.contains("on"), icon: el.style.getPropertyValue("--icon"), title: el.title };
      }
      case "setMic":
        return setTabMic(cmd.tabId, cmd);
      case "tabVolume":
        return tabVolumes.has(cmd.tabId) ? tabVolumes.get(cmd.tabId) : 1;
      // --- новые возможности 5.14: общие запросы к панели, фону и Firefox.
      case "uiQuery": {
        // Все элементы по селектору: видимость, классы, текст, подсказка.
        const view = panel();
        return [...view.document.querySelectorAll(cmd.selector)].map((el) => ({
          shown: !el.hidden && view.getComputedStyle(el).display !== "none",
          cls: el.className,
          text: el.textContent,
          title: el.title,
          data: { ...el.dataset },
        }));
      }
      case "uiCall": {
        // Функция панели (верхнеуровневые function — свойства её window).
        const value = await panel()[cmd.fn](...(cmd.args || []));
        return value === undefined ? null : JSON.parse(JSON.stringify(value, (k, v) => (typeof v === "function" ? undefined : v)));
      }
      case "uiMenuClick": {
        // Пункт открытого меню по тексту.
        const item = [...panel().document.querySelectorAll("#menu .mi")].find((el) => el.querySelector(".mi-label").textContent === cmd.label);
        if (!item) throw new Error("нет пункта меню " + cmd.label);
        item.click();
        return true;
      }
      case "setSettings":
        await browser.storage.local.set({ settings: cmd.settings });
        return true;
      case "storage":
        return (await browser.storage.local.get(cmd.key))[cmd.key] || null;
      case "tabInfo": {
        const t = await browser.tabs.get(cmd.tabId).catch(() => null);
        if (!t) return null;
        const group = t.groupId !== undefined && t.groupId !== -1 ? await browser.tabGroups.get(t.groupId) : null;
        return { url: t.url, groupId: t.groupId, group: group && { title: group.title, color: group.color }, cookieStoreId: t.cookieStoreId, active: t.active };
      }
      case "openIn":
        return (await browser.tabs.create({ url: cmd.url, cookieStoreId: cmd.cookieStoreId, active: true })).id;
      case "createContainer":
        return (await browser.contextualIdentities.create({ name: cmd.name, color: cmd.color || "orange", icon: "briefcase" })).cookieStoreId;
      case "removeContainer":
        await browser.contextualIdentities.remove(cmd.cookieStoreId);
        return true;
      case "commands":
        return browser.commands.getAll();
      case "command":
        return runCommand(cmd.name, cmd.tab);
      case "optionsOpen": {
        await browser.runtime.openOptionsPage();
        for (let i = 0; i < 100 && !(optionsView() && optionsView().document.querySelector(".shortcut")); i++) await new Promise((r) => setTimeout(r, 50));
        if (!optionsView()) throw new Error("настройки не открылись");
        return true;
      }
      case "optionsAddRule": {
        const view = optionsView();
        view.document.getElementById("rule-add").click();
        const rule = view.document.querySelector(".rule:last-child");
        for (const [sel, value] of [[".rule-pattern", cmd.pattern], [".rule-group", cmd.group]]) {
          const input = rule.querySelector(sel);
          input.value = value;
          input.dispatchEvent(new view.Event("input", { bubbles: true }));
        }
        return true;
      }
      case "optionsRecord": {
        // Назначить сочетание: клик по кнопке команды и нажатие клавиш.
        const view = optionsView();
        const row = view.document.querySelector(`.shortcut[data-name="${cmd.name}"]`);
        row.querySelector('[data-act="record"]').click();
        view.document.dispatchEvent(new view.KeyboardEvent("keydown", { code: cmd.code, key: cmd.key, ctrlKey: !!cmd.ctrl, altKey: !!cmd.alt, shiftKey: !!cmd.shift, bubbles: true, cancelable: true }));
        return true;
      }
      case "optionsQuery":
        return [...optionsView().document.querySelectorAll(cmd.selector)].map((el) => ({ text: el.textContent, hidden: el.hidden, cls: el.className }));
      default:
        throw new Error("unknown op " + cmd.op);
    }
  }

  async function poll() {
    try {
      const cmd = await (await fetch(E2E_ORIGIN + "/hook/cmd")).json();
      if (cmd && cmd.op) {
        let result;
        try {
          result = { ok: true, value: await execute(cmd) };
        } catch (err) {
          result = { ok: false, error: String(err) };
        }
        await post("/hook/result", { id: cmd.id, ...result });
      }
    } catch (err) {
      // Раннер ещё не поднялся или уже ушёл.
    }
    setTimeout(poll, POLL_MS);
  }

  report();
  poll();
})();
