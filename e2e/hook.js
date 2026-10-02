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
        tabs: tabs.map((t) => ({ id: t.id, url: t.url, audible: !!t.audible, status: t.status, discarded: !!t.discarded })),
      });
    } catch (err) {
      await post("/hook/error", { message: String(err) });
    }
    setTimeout(report, REPORT_MS);
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
      case "tabVolume":
        return tabVolumes.has(cmd.tabId) ? tabVolumes.get(cmd.tabId) : 1;
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
