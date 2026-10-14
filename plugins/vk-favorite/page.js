"use strict";

/*
 * ВКонтакте: кнопка «добавить в мою музыку» для играющего трека.
 *
 * Плагин не ходит в API ВК — он находит в плеере самого ВК его кнопку
 * «+» и нажимает её, поэтому всё делает сам сайт, от имени пользователя,
 * как при обычном клике.
 *
 * Кнопка ВК — data-testid="MusicAudio_ToggleOwning", добавлен ли трек —
 * data-testactive="true" (метки автотестов самого ВК: они живут дольше
 * классов, которые меняются при каждой сборке). Такая же кнопка есть у
 * каждой строки в списках треков, поэтому нужная выбирается так:
 *   1. рядом с ней название играющего трека (Media Session), из таких —
 *      та, что в блоке плеера ВК;
 *   2. иначе — единственная такая кнопка в блоке плеера;
 *   3. запасной путь, если ВК сменит метки, — по подписи «Добавить в мою
 *      музыку» / «Удалить из моей музыки» внутри блока плеера.
 * Нет такой кнопки (ничего не играет, свой трек) — кнопки в панели нет.
 */

(() => {
  const TOGGLE = '[data-testid="MusicAudio_ToggleOwning"]';
  const ADD = /добавить (в )?(мою музыку|мои аудио|аудиозаписи|медиатеку|себе)|add to (my )?(music|library|audios)/i;
  const REMOVE = /удалить (из )?(моей музыки|моих аудио|аудиозаписей|медиатеки)|убрать из|remove from (my )?(music|library|audios)/i;
  // Блоки плеера ВК; строки списков — не плеер.
  const PLAYER = '[data-testid*="player" i], [class*="player" i], [id*="player" i]';
  const ROW = '.audio_row, [class*="AudioRow"], [data-testid*="row" i]';
  const UPDATE_MS = 300;

  // Неразрывные пробелы ВК (в&nbsp;мою) — в обычные.
  function norm(text) {
    return String(text || "").replace(/\s+/g, " ").trim().toLowerCase();
  }

  function labelOf(el) {
    return norm(el.getAttribute("aria-label") || el.getAttribute("title") || el.textContent);
  }

  function inPlayer(el) {
    const box = el.closest(PLAYER);
    return !!box && !box.closest(ROW) && !el.closest(ROW);
  }

  function added(el) {
    const t = el.getAttribute("data-testactive");
    if (t === "true" || t === "false") return t === "true";
    return REMOVE.test(labelOf(el));
  }

  function playingTitle() {
    try {
      const m = navigator.mediaSession && navigator.mediaSession.metadata;
      return m ? norm(m.title) : "";
    } catch (e) {
      return "";
    }
  }

  // Строка, в которой эта кнопка, — про трек title? Строка — наибольший
  // блок вокруг кнопки без других таких кнопок: выше уже весь список, и
  // название из соседней строки приняли бы за своё.
  function rowHasTitle(el, title) {
    let row = el;
    for (let node = el.parentElement; node && node.querySelectorAll(TOGGLE).length === 1; node = node.parentElement) {
      row = node;
    }
    return row !== el && norm(row.textContent).includes(title);
  }

  // { el, added } — кнопка ВК для играющего трека, или null.
  function find() {
    const toggles = [...document.querySelectorAll(TOGGLE)];
    const title = playingTitle();
    let el = null;
    if (title) {
      // Главный признак — рядом название играющего трека: тогда это точно
      // он, даже если «блок плеера» на деле обёртка всей страницы музыки.
      // Сначала плеер (там кнопка одна-две) — список в сотни строк
      // проверяем, только если в плеере не нашлось.
      el = toggles.find((t) => inPlayer(t) && rowHasTitle(t, title)) || toggles.find((t) => rowHasTitle(t, title)) || null;
    }
    if (!el) {
      // Названия не видно — только если кнопка в плеере одна (иначе можно
      // попасть в чужую строку).
      const inside = toggles.filter(inPlayer);
      if (inside.length === 1) el = inside[0];
    }
    if (el) return { el, added: added(el) };
    for (const b of document.querySelectorAll("button, [role=button]")) {
      if (!inPlayer(b)) continue;
      const label = labelOf(b);
      if (REMOVE.test(label)) return { el: b, added: true };
      if (ADD.test(label)) return { el: b, added: false };
    }
    return null;
  }

  SidebarTabs.plugin("vk-favorite", (plugin) => {
    plugin.button("add", {
      state() {
        const b = find();
        return b ? { active: b.added } : null;
      },
      press() {
        const b = find();
        if (b) b.el.click();
      },
    });

    // ВК меняет кнопку на месте (подпись/класс) — сообщаем плееру. Страница
    // ВК шевелит DOM постоянно (полоса прогресса), поэтому не чаще UPDATE_MS.
    let timer = 0;
    new MutationObserver(() => {
      if (timer) return;
      timer = setTimeout(() => {
        timer = 0;
        SidebarTabs.update();
      }, UPDATE_MS);
    }).observe(document.documentElement, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["aria-label", "title", "class", "data-testactive"],
    });
  });
})();
