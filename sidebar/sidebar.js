"use strict";

/*
 * Боковая панель вкладок текущего окна. Работает только пока панель открыта —
 * закрытая панель не стоит ничего (документ выгружается целиком).
 *
 * Схема обновления:
 *   - структурные события (создание/закрытие/перемещение вкладок, изменения
 *     групп) → один общий tabs.query + tabGroups.query, схлопнутый по времени
 *     (RESYNC_DELAY_MS): пачка из 30 закрытых вкладок = один запрос, а не 30,
 *     и никакой ручной бухгалтерии индексов, в которой легко ошибиться;
 *   - косметика (заголовок, иконка, статус загрузки, звук) → точечная правка
 *     одной вкладки без запросов;
 *   - отрисовка — не чаще раза за кадр, DOM-узлы переиспользуются по ключу,
 *     и у каждой строки меняется только то, что реально изменилось.
 *
 * Вся логика "что означает бросок / как выглядит список" — в model.js.
 */

const RESYNC_DELAY_MS = 16;
const MIME = "application/x-sidebar-tabs-tabs";
// Абсолютный URL: onIconError сравнивает его с img.src, который браузер
// всегда разворачивает в абсолютный, — с относительным путём сравнение не
// совпало бы, и сбой загрузки заглушки зациклился бы.
const FALLBACK_ICON = browser.runtime.getURL("icons/lucide/globe-fallback.svg");

const hasGroups = typeof browser.tabs.group === "function" && !!browser.tabGroups;

const state = {
  windowId: null,
  tabs: new Map(),
  groups: new Map(),
  selected: new Set(),
  anchorId: null,
  orderedIds: [],
  lastActiveId: null,
  renameGroupId: null,
  // hostname → иконка сайта (ведёт background.js). Читается один раз при
  // открытии панели: живые обновления не нужны — у загруженных вкладок
  // своя иконка, кэш нужен только незагруженным, а они с прошлых сессий.
  favicons: new Map(),
  // tabId → громкость 0..0.99 (ведёт background.js; 100% в карте не хранится).
  volumes: new Map(),
  // Вкладки, где страница не дала выставить громкость (служебные страницы).
  volumeBlocked: new Set(),
  // Что играет во вкладках (ведёт background.js, см. content/media.js).
  media: [],
  // Вкладки плеера из других окон (своего окна — в tabs).
  otherTabs: new Map(),
};

const $pinned = document.getElementById("pinned");
const $scroll = document.getElementById("scroll");
const $rows = document.getElementById("rows");
const $menu = document.getElementById("menu");

// key → DOM-элемент. Ключи: "p<id>" закреплённая, "t<id>" вкладка, "g<id>" группа.
const els = new Map();

function report(err) {
  console.error("[sidebar-tabs] sidebar", err);
}

function run(promise) {
  Promise.resolve(promise).catch(report);
}

// ---------------------------------------------------------------- синхронизация

let resyncTimer = null;
let resyncRunning = false;
let resyncAgain = false;

function scheduleResync() {
  if (resyncTimer !== null) return;
  resyncTimer = setTimeout(() => {
    resyncTimer = null;
    resync();
  }, RESYNC_DELAY_MS);
}

async function resync() {
  if (resyncRunning) {
    resyncAgain = true;
    return;
  }
  resyncRunning = true;
  try {
    do {
      resyncAgain = false;
      const [tabs, groups] = await Promise.all([
        browser.tabs.query({ windowId: state.windowId }),
        hasGroups ? browser.tabGroups.query({ windowId: state.windowId }).catch(() => []) : [],
      ]);
      state.tabs = new Map(tabs.map((t) => [t.id, t]));
      state.groups = new Map(groups.map((g) => [g.id, g]));
    } while (resyncAgain);
  } catch (err) {
    report(err);
  } finally {
    resyncRunning = false;
  }
  for (const id of state.selected) if (!state.tabs.has(id)) state.selected.delete(id);
  // Громкость не чистим: её держит фон для вкладок всех окон, а плеер
  // показывает вкладку и из другого окна.
  for (const id of state.volumeBlocked) if (!state.tabs.has(id)) state.volumeBlocked.delete(id);
  scheduleRender();
}

// Точечная правка пришла, пока запрос в полёте: его ответ может оказаться
// старее этой правки — повторяем запрос, а не рискуем откатить состояние.
function patchTab(tab) {
  state.tabs.set(tab.id, tab);
  if (resyncRunning) resyncAgain = true;
  scheduleRender();
}

function ours(windowId) {
  return windowId === state.windowId;
}

function listen() {
  const t = browser.tabs;
  t.onCreated.addListener((tab) => ours(tab.windowId) && scheduleResync());
  t.onRemoved.addListener((tabId, info) => {
    if (!ours(info.windowId) || info.isWindowClosing) return;
    state.tabs.delete(tabId);
    state.selected.delete(tabId);
    scheduleResync();
  });
  t.onMoved.addListener((tabId, info) => ours(info.windowId) && scheduleResync());
  t.onAttached.addListener((tabId, info) => ours(info.newWindowId) && scheduleResync());
  t.onDetached.addListener((tabId, info) => ours(info.oldWindowId) && scheduleResync());
  t.onReplaced.addListener(() => scheduleResync());
  t.onActivated.addListener((info) => {
    if (!ours(info.windowId)) return;
    for (const tab of state.tabs.values()) tab.active = tab.id === info.tabId;
    scheduleRender();
  });
  t.onUpdated.addListener(
    (tabId, change, tab) => {
      // pinned/groupId/hidden меняют раскладку и индексы соседей — это уже
      // структурное изменение, остальное (заголовок, иконка, звук) — косметика.
      if (change.pinned !== undefined || change.groupId !== undefined || change.hidden !== undefined) {
        scheduleResync();
      } else {
        patchTab(tab);
      }
    },
    { windowId: state.windowId }
  );

  if (hasGroups) {
    const g = browser.tabGroups;
    g.onCreated.addListener((group) => ours(group.windowId) && scheduleResync());
    g.onRemoved.addListener((group) => ours(group.windowId) && scheduleResync());
    g.onMoved.addListener((group) => ours(group.windowId) && scheduleResync());
    g.onUpdated.addListener((group) => {
      if (!ours(group.windowId)) return;
      state.groups.set(group.id, group);
      if (resyncRunning) resyncAgain = true;
      scheduleRender();
    });
  }
}

// ---------------------------------------------------------------- тема

// Цвета берутся из текущей темы Firefox. Тема задаёт только базовые цвета,
// всё остальное (приглушённый текст, hover, выделение) CSS выводит из них
// через color-mix. Ключа нет в теме (встроенные темы обычно пустые) — свойство
// снимается, и действует запасной цвет из CSS для светлой/тёмной схемы.
const THEME_VARS = {
  "--bg": ["sidebar", "toolbar", "frame"],
  "--fg": ["sidebar_text", "toolbar_text", "tab_background_text"],
  "--accent": ["tab_line", "icons_attention", "sidebar_highlight"],
  "--border": ["sidebar_border", "toolbar_bottom_separator"],
  "--menu-bg": ["popup"],
  "--menu-fg": ["popup_text"],
};

// Цвет темы бывает строкой или (устаревший формат) массивом [r, g, b(, a)].
function themeColor(colors, keys) {
  for (const key of keys) {
    const c = colors[key];
    if (typeof c === "string" && c) return c;
    if (Array.isArray(c) && c.length >= 3) return `rgb(${c.join(",")})`;
  }
  return "";
}

let colorProbe = null;

// Тёмный ли цвет: нужно для color-scheme (полоса прокрутки, поле ввода).
function isDark(color) {
  colorProbe ??= document.createElement("canvas").getContext("2d");
  colorProbe.fillStyle = "#fff";
  colorProbe.fillStyle = color;
  const m = colorProbe.fillStyle.match(/[\da-f]{2}/gi);
  if (!m || colorProbe.fillStyle[0] !== "#") return null;
  const [r, g, b] = m.map((h) => parseInt(h, 16));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b < 128;
}

function applyTheme(theme) {
  const colors = (theme && theme.colors) || {};
  const style = document.documentElement.style;
  for (const [prop, keys] of Object.entries(THEME_VARS)) {
    const value = themeColor(colors, keys);
    if (value) style.setProperty(prop, value);
    else style.removeProperty(prop);
  }
  const bg = style.getPropertyValue("--bg");
  const dark = bg ? isDark(bg) : null;
  if (dark === null) style.removeProperty("color-scheme");
  else style.setProperty("color-scheme", dark ? "dark" : "light");
  // Цвет значков на кнопке акцентного цвета (пауза в плеере и т.п.).
  const accent = style.getPropertyValue("--accent");
  const accentDark = accent ? isDark(accent) : null;
  if (accentDark === null) style.removeProperty("--on-accent");
  else style.setProperty("--on-accent", accentDark ? "#fff" : "#111");
}

function listenTheme() {
  if (!browser.theme) return;
  run(browser.theme.getCurrent(state.windowId).then(applyTheme));
  browser.theme.onUpdated.addListener(({ windowId }) => {
    // Событие без windowId — тема сменилась глобально; с чужим окном — не наша.
    if (windowId !== undefined && !ours(windowId)) return;
    run(browser.theme.getCurrent(state.windowId).then(applyTheme));
  });
}

// ---------------------------------------------------------------- отрисовка

let renderQueued = false;

function scheduleRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    render();
  });
}

// Приводит детей container к списку entries, переиспользуя узлы по ключу.
// Нужные узлы по очереди ставятся на место; всё лишнее в итоге оказывается
// в хвосте и удаляется одним проходом (или уходит с анимацией — flip.leave).
function reconcile(container, entries, make, update, flip) {
  let ref = container.firstChild;
  for (const [key, data] of entries) {
    let el = els.get(key);
    if (!el) {
      el = make(key);
      els.set(key, el);
    }
    update(el, data);
    if (el === ref) ref = ref.nextSibling;
    else container.insertBefore(el, ref);
  }
  while (ref) {
    const next = ref.nextSibling;
    if (ref.dataset.key) els.delete(ref.dataset.key);
    if (flip) flip.leave(ref);
    else ref.remove();
    ref = next;
  }
}

// ---------------------------------------------------------------- плавные перестановки
//
// FLIP: перед перестройкой запоминаем, где была каждая строка, после —
// где она теперь, и пружиной (Motion) везём её из старого места в новое.
// Новые строки проявляются, ушедшие гаснут на своём месте, пока соседи
// съезжаются. Только при изменении состава или порядка строк: обычные
// обновления (заголовок, иконка, звук) ничего не измеряют.

const FLIP_SPRING = { type: "spring", stiffness: 520, damping: 42, mass: 1 };
const FLIP_FADE = { duration: 0.18, ease: [0.2, 0.8, 0.2, 1] };
const FLIP_MAX_ROWS = 400;
const flipSigs = new WeakMap();

function motionAllowed() {
  return !matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function beginFlip(container, entries) {
  const sig = entries.map((e) => e[0]).join(",");
  const prev = flipSigs.get(container);
  flipSigs.set(container, sig);
  if (prev === undefined || prev === sig || !motionAllowed() || entries.length > FLIP_MAX_ROWS || container.hidden) {
    return null;
  }
  const box = container.getBoundingClientRect();
  // Видимая область: у списка — окно прокрутки, закреплённые видны всегда.
  const view = container === $rows ? $scroll.getBoundingClientRect() : { top: -Infinity, bottom: Infinity };
  const before = new Map();
  for (const el of container.children) {
    if (!el.dataset.key) continue;
    if (el._flip) el._flip.stop();
    before.set(el, el.getBoundingClientRect());
  }
  // Положение «как в раскладке», без хвоста предыдущей анимации.
  for (const el of before.keys()) el.style.transform = "";
  return {
    container,
    before,
    box,
    view,
    leave(el) {
      const r = before.get(el);
      if (!r || r.bottom < view.top || r.top > view.bottom) {
        el.remove();
        return;
      }
      // Призрак: вынут из раскладки, стоит на старом месте и гаснет.
      delete el.dataset.key;
      delete el.dataset.id;
      delete el.dataset.gid;
      el.draggable = false;
      el.classList.add("leaving");
      el.style.position = "absolute";
      el.style.left = r.left - box.left + "px";
      el.style.top = r.top - box.top + "px";
      el.style.width = r.width + "px";
      el.style.margin = "0";
      Motion.animate(el, { opacity: 0, scale: 0.97 }, FLIP_FADE).finished.then(() => el.remove(), () => el.remove());
    },
  };
}

function finishFlip(flip) {
  if (!flip) return;
  const { view, before } = flip;
  for (const el of flip.container.children) {
    if (!el.dataset.key) continue;
    const r = el.getBoundingClientRect();
    const was = before.get(el);
    const visible = r.bottom >= view.top && r.top <= view.bottom;
    // Начальное положение ставим сразу, в этом же кадре: Motion применит
    // первый ключевой кадр только на следующем, и строка на кадр мелькнула
    // бы на новом месте.
    if (!was) {
      if (!visible) continue;
      el.style.opacity = "0";
      el.style.transform = "translateY(-6px)";
      el._flip = Motion.animate(el, { opacity: [0, 1], y: [-6, 0] }, FLIP_FADE);
      continue;
    }
    const dx = was.left - r.left;
    const dy = was.top - r.top;
    if ((dx || dy) && (visible || (was.bottom >= view.top && was.top <= view.bottom))) {
      el.style.transform = `translateX(${dx}px) translateY(${dy}px)`;
      el._flip = Motion.animate(el, { x: [dx, 0], y: [dy, 0] }, FLIP_SPRING);
    }
  }
}

function render() {
  const { pinned, rows } = buildLayout([...state.tabs.values()], state.groups);

  const pinEntries = pinned.map((tab) => ["p" + tab.id, tab]);
  const entries = [];
  for (const row of rows) {
    if (row.kind === "group") {
      entries.push(["g" + row.group.id, row]);
      continue;
    }
    entries.push(["t" + row.tab.id, row]);
  }

  // Оба замера «до» — до любых изменений DOM: закреплённые вкладки сдвигают список.
  const pinFlip = beginFlip($pinned, pinEntries);
  const rowFlip = beginFlip($rows, entries);
  reconcile($pinned, pinEntries, makePin, updatePin, pinFlip);
  $pinned.hidden = pinned.length === 0;
  reconcile($rows, entries, makeRow, updateRow, rowFlip);
  finishFlip(pinFlip);
  finishFlip(rowFlip);

  state.orderedIds = pinned.map((t) => t.id).concat(rows.filter((r) => r.kind === "tab").map((r) => r.tab.id));

  const active = [...state.tabs.values()].find((t) => t.active);
  if (active && active.id !== state.lastActiveId) {
    state.lastActiveId = active.id;
    const el = els.get((active.pinned ? "p" : "t") + active.id);
    if (el) el.scrollIntoView({ block: "nearest" });
  }

  if (state.renameGroupId !== null && els.has("g" + state.renameGroupId)) {
    const gid = state.renameGroupId;
    state.renameGroupId = null;
    startRename(gid);
  }

  renderPlayer();
  renderToolbar();
}

const ROW_MAKERS = { g: makeGroup, t: makeTab };
const ROW_UPDATERS = { g: updateGroup, t: updateTab };

function makeRow(key) {
  return ROW_MAKERS[key[0]](key);
}

function updateRow(el, row) {
  ROW_UPDATERS[el.dataset.key[0]](el, row);
}

function setIcon(img, url) {
  const src = url || FALLBACK_ICON;
  if (img.dataset.src === src) return;
  img.dataset.src = src;
  img.src = src;
}

function onIconError(e) {
  // chrome://-иконки и битые адреса расширению недоступны — ставим заглушку.
  if (e.target.src !== FALLBACK_ICON) e.target.src = FALLBACK_ICON;
}

function makeIcon() {
  const img = document.createElement("img");
  img.className = "fav";
  img.alt = "";
  img.draggable = false;
  img.addEventListener("error", onIconError);
  return img;
}

function tabClasses(base, tab) {
  let cls = base;
  if (tab.active) cls += " active";
  if (tab.discarded) cls += " discarded";
  if (tab.status === "loading") cls += " loading";
  if (state.selected.has(tab.id)) cls += " selected";
  return cls;
}

function tooltip(tab) {
  const title = tab.title || tab.url;
  return tab.url && tab.url !== title ? title + "\n" + tab.url : title;
}

function setIfChanged(el, prop, value) {
  if (el._v[prop] === value) return false;
  el._v[prop] = value;
  return true;
}

function makePin(key) {
  const el = document.createElement("div");
  el.dataset.key = key;
  el.dataset.id = key.slice(1);
  el.draggable = true;
  el._v = {};
  el.append(makeIcon());
  return el;
}

function updatePin(el, tab) {
  if (setIfChanged(el, "cls", tabClasses("pin", tab))) el.className = el._v.cls;
  if (setIfChanged(el, "tip", tooltip(tab))) el.title = el._v.tip;
  setIcon(el.firstChild, iconFor(tab, state.favicons));
}

function makeTab(key) {
  const el = document.createElement("div");
  el.dataset.key = key;
  el.dataset.id = key.slice(1);
  el.draggable = true;
  el._v = {};

  const title = document.createElement("span");
  title.className = "title";
  const audio = makeVolumeControl("audio vexp");
  const close = document.createElement("span");
  close.className = "close";
  close.title = "Закрыть вкладку";
  close.dataset.icon = "x";

  el.append(makeIcon(), title, audio, close);
  return el;
}

function updateTab(el, row) {
  const tab = row.tab;
  const inGroup = row.groupId !== NO_GROUP;

  if (setIfChanged(el, "cls", tabClasses(inGroup ? "tab in-group" : "tab", tab))) el.className = el._v.cls;
  if (setIfChanged(el, "title", tab.title || tab.url || "")) el.children[1].textContent = el._v.title;
  if (setIfChanged(el, "tip", tooltip(tab))) el.title = el._v.tip;
  setIcon(el.firstChild, iconFor(tab, state.favicons));

  // Значок звука показывается, когда вкладка звучит, выключена или у неё
  // изменена громкость (или регулятор открыт из меню).
  const audioEl = el.children[2];
  const shown = !!tab.audible || isMuted(tab) || state.volumes.has(tab.id);
  if (setIfChanged(el, "audioShown", shown)) audioEl.classList.toggle("shown", shown);
  if (setIfChanged(el, "audible", !!tab.audible)) audioEl.classList.toggle("playing", !!tab.audible);
  updateVolumeControl(audioEl, tab.id, true);

  const color = inGroup ? groupColor(state.groups.get(row.groupId)) : "";
  if (setIfChanged(el, "color", color)) setColorVar(el, color);
}

function volumeIcon(volume) {
  if (volume === 0) return "volume";
  return volume < 0.5 ? "volume-1" : "volume-2";
}

function groupColor(group) {
  return group && GROUP_COLORS.includes(group.color) ? group.color : "grey";
}

function setColorVar(el, color) {
  if (color) el.style.setProperty("--gc", `var(--c-${color})`);
  else el.style.removeProperty("--gc");
}

function makeGroup(key) {
  const el = document.createElement("div");
  el.dataset.key = key;
  el.dataset.gid = key.slice(1);
  el.draggable = true;
  el._v = {};

  const chev = document.createElement("span");
  chev.className = "chev";
  const title = document.createElement("span");
  title.className = "gtitle";
  const count = document.createElement("span");
  count.className = "count";

  el.append(chev, title, count);
  return el;
}

function updateGroup(el, row) {
  const g = row.group;
  if (setIfChanged(el, "cls", g.collapsed ? "group collapsed" : "group")) el.className = el._v.cls;
  if (setIfChanged(el, "title", g.title || "")) el.children[1].textContent = el._v.title;
  if (setIfChanged(el, "count", String(row.count))) el.children[2].textContent = el._v.count;
  if (setIfChanged(el, "color", groupColor(g))) setColorVar(el, el._v.color);
  if (setIfChanged(el, "tip", g.collapsed ? "Развернуть группу" : "Свернуть группу")) el.title = el._v.tip;
}

// ---------------------------------------------------------------- действия

// target событий drag в Firefox бывает текстовым узлом — поднимаемся до элемента.
function elementOf(node) {
  return node && node.nodeType === Node.ELEMENT_NODE ? node : node && node.parentElement;
}

function tabIdOf(node) {
  const el = elementOf(node);
  const row = el && el.closest("[data-id]");
  return row ? Number(row.dataset.id) : null;
}

function groupIdOf(node) {
  const el = elementOf(node);
  const row = el && el.closest("[data-gid]");
  return row ? Number(row.dataset.gid) : null;
}

function tabsOfGroup(gid) {
  return [...state.tabs.values()].filter((t) => t.groupId === gid).sort((a, b) => a.index - b.index);
}

function setSelection(ids) {
  state.selected = new Set(ids);
  scheduleRender();
}

// Цели действия: если кликнули по выделенной вкладке — всё выделение,
// иначе только её (как в обычной полосе вкладок Firefox).
function targetsFor(id) {
  if (state.selected.has(id) && state.selected.size > 1) {
    return state.orderedIds.filter((x) => state.selected.has(x));
  }
  return [id];
}

function newTab(props = {}) {
  return browser.tabs.create({ windowId: state.windowId, ...props });
}

async function groupTabs(ids, groupId) {
  const unpinned = ids.filter((id) => {
    const t = state.tabs.get(id);
    return t && !t.pinned;
  });
  if (unpinned.length === 0) return;
  const options = { tabIds: unpinned };
  if (groupId !== undefined) options.groupId = groupId;
  const gid = await browser.tabs.group(options);
  if (groupId === undefined) state.renameGroupId = gid;
  setSelection([]);
}

function setMuted(ids, muted) {
  return Promise.all(ids.map((x) => browser.tabs.update(x, { muted })));
}

// Громкость применяется в фоне (background.js), там же она переживает
// перезагрузку страницы. Здесь — только отображение и отправка.
function setVolume(ids, volume) {
  for (const id of ids) {
    if (volume >= 1) state.volumes.delete(id);
    else state.volumes.set(id, volume);
  }
  scheduleRender();
  for (const id of ids) {
    browser.runtime.sendMessage({ type: "setVolume", tabId: id, volume }).then((applied) => {
      const had = state.volumeBlocked.has(id);
      if (applied) state.volumeBlocked.delete(id);
      else state.volumeBlocked.add(id);
      if (had !== !applied) scheduleRender();
    }, report);
  }
}

// Ползунок шлёт input на каждый пиксель — отправляем не чаще раза в 80 мс,
// но последнее значение не теряется никогда.
const VOLUME_THROTTLE_MS = 80;
let volumeTimer = null;
let volumePending = null;

function setVolumeThrottled(ids, volume) {
  volumePending = [ids, volume];
  if (volumeTimer) return;
  setVolume(...volumePending);
  volumePending = null;
  volumeTimer = setTimeout(function flush() {
    volumeTimer = null;
    if (volumePending) setVolumeThrottled(...volumePending);
  }, VOLUME_THROTTLE_MS);
}

async function newTabInGroup(gid) {
  const members = tabsOfGroup(gid);
  const last = members[members.length - 1];
  const tab = await newTab(last ? { index: last.index + 1 } : {});
  await browser.tabs.group({ tabIds: [tab.id], groupId: gid });
}

function toggleCollapsed(gid) {
  const g = state.groups.get(gid);
  if (g) run(browser.tabGroups.update(gid, { collapsed: !g.collapsed }));
}

function startRename(gid) {
  const el = els.get("g" + gid);
  const group = state.groups.get(gid);
  if (!el || el.querySelector(".rename")) return;

  const titleEl = el.children[1];
  const input = document.createElement("input");
  input.className = "rename";
  input.value = group ? group.title || "" : "";
  input.placeholder = "Название группы";
  titleEl.hidden = true;
  // В перетаскиваемом элементе мышью нельзя выделить текст в поле ввода.
  el.draggable = false;
  el.insertBefore(input, titleEl);
  input.focus();
  input.select();

  let done = false;
  const finish = (commit) => {
    if (done) return;
    done = true;
    input.remove();
    titleEl.hidden = false;
    el.draggable = true;
    if (commit) run(browser.tabGroups.update(gid, { title: input.value.trim() }));
  };
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") finish(true);
    else if (e.key === "Escape") finish(false);
    e.stopPropagation();
  });
  input.addEventListener("blur", () => finish(true));
}

// ---------------------------------------------------------------- громкость
//
// Значок звука (у вкладки и у строки плеера) при наведении плавно
// раздвигается в ширину и показывает ползунок прямо в строке; мышь ушла —
// сворачивается. Клик по значку — выключить звук, колесо — ±5%. Из
// контекстного меню регулятор открывается «прилипшим»: сворачивается только
// кликом мимо, Esc или прокруткой.
//
// Выключенный звук — это громкость 0 для глаз: ползунок стоит в нуле, а если
// его потянуть (или крутнуть колесо вверх), звук включается с новой громкостью.

const VOL_OPEN_MS = 160;
const VOL_CLOSE_MS = 420;
let volOpen = null;
let volSticky = false;
let volTimer = 0;
// Ползунок тянут мышью: не перебиваем его значение и не сворачиваем
// регулятор, даже если курсор при этом ушёл за его край.
let sliderHeld = false;

// Вкладка этого окна или (для плеера) другого — те держит state.otherTabs.
function tabById(id) {
  return state.tabs.get(id) || state.otherTabs.get(id) || null;
}

function isMuted(tab) {
  return !!(tab && tab.mutedInfo && tab.mutedInfo.muted);
}

function volumeOf(id) {
  return state.volumes.has(id) ? state.volumes.get(id) : 1;
}

// То, что показывает ползунок: при выключенном звуке — ноль.
function shownVolume(id) {
  return isMuted(tabById(id)) ? 0 : volumeOf(id);
}

function toggleMuted(id) {
  const tab = tabById(id);
  if (tab) run(setMuted([id], !isMuted(tab)));
}

// Новая громкость от ползунка или колеса: заодно включает выключенный звук.
function changeVolume(ids, volume, throttled) {
  const muted = ids.filter((id) => isMuted(tabById(id)));
  if (volume > 0 && muted.length) run(setMuted(muted, false));
  if (throttled) setVolumeThrottled(ids, volume);
  else setVolume(ids, volume);
}

// Регулятор: [значок][ползунок, ширина 0 → раскрывается][проценты].
function makeVolumeControl(cls) {
  const box = document.createElement("span");
  box.className = cls;
  const icon = document.createElement("span");
  icon.className = "vicon";
  const slide = document.createElement("span");
  slide.className = "vslide";
  const range = document.createElement("input");
  range.type = "range";
  range.className = "range";
  range.min = "0";
  range.max = "100";
  range.step = "1";
  range.tabIndex = -1;
  slide.append(range);
  const pct = document.createElement("span");
  pct.className = "vpct";
  box.append(icon, slide, pct);
  box._v = {};
  return box;
}

// showPct — проценты видны и в свёрнутом виде (у вкладки с изменённой громкостью).
function updateVolumeControl(box, tabId, showPct) {
  const tab = tabById(tabId);
  const muted = isMuted(tab);
  const vol = volumeOf(tabId);
  const icon = muted ? "volume-x" : volumeIcon(vol);
  if (setIfChanged(box, "icon", icon)) box.firstChild.dataset.icon = icon;
  if (setIfChanged(box, "muted", muted)) box.classList.toggle("muted", muted);
  const blocked = state.volumeBlocked.has(tabId);
  if (setIfChanged(box, "blocked", blocked)) box.classList.toggle("blocked", blocked);
  const tip = blocked
    ? "Эта страница не даёт менять громкость (служебная страница или ещё не загружена)"
    : (muted ? "Звук выключен. " : "") + "Клик — выключить/включить звук, наведите — громкость, колесо — ±5%";
  if (setIfChanged(box, "tip", tip)) box.firstChild.title = tip;
  const range = box.children[1].firstChild;
  const value = String(Math.round(shownVolume(tabId) * 100));
  if (!(sliderHeld && document.activeElement === range) && range.value !== value) range.value = value;
  const pct = box.dataset.open !== undefined || (showPct && !muted && vol < 1) ? range.value + "%" : "";
  if (setIfChanged(box, "pct", pct)) box.lastChild.textContent = pct;
}

function volumeTargetOf(node) {
  const row = node.closest(".pr");
  return row ? Number(row.dataset.tab) : tabIdOf(node);
}

function openVolume(box, sticky = false) {
  clearTimeout(volTimer);
  volTimer = 0;
  if (volOpen && volOpen !== box) closeVolume();
  if (!box || !box.isConnected) return;
  volOpen = box;
  volSticky = sticky;
  box.dataset.open = "";
  scheduleRender();
}

function closeVolume() {
  clearTimeout(volTimer);
  volTimer = 0;
  if (!volOpen) return;
  delete volOpen.dataset.open;
  volOpen = null;
  volSticky = false;
  scheduleRender();
}

function scheduleVolumeClose() {
  clearTimeout(volTimer);
  volTimer = 0;
  if (!volOpen || volSticky) return;
  volTimer = setTimeout(function close() {
    if (sliderHeld) volTimer = setTimeout(close, VOL_CLOSE_MS);
    else closeVolume();
  }, VOL_CLOSE_MS);
}

document.addEventListener("input", (e) => {
  const box = e.target.closest && e.target.closest(".vexp");
  if (!box) return;
  const id = volumeTargetOf(box);
  if (id === null) return;
  box.lastChild.textContent = e.target.value + "%";
  changeVolume([id], Number(e.target.value) / 100, true);
});

// Ползунок внутри перетаскиваемой строки: пока его тянут, строка не
// перетаскивается (иначе Firefox начал бы перетаскивать саму вкладку).
document.addEventListener(
  "pointerdown",
  (e) => {
    sliderHeld = e.target.type === "range";
    if (sliderHeld) {
      const row = e.target.closest("[draggable=true]");
      if (row) {
        row.draggable = false;
        document.addEventListener("pointerup", () => (row.draggable = true), { once: true, capture: true });
      }
    }
  },
  true
);
document.addEventListener("pointerup", () => (sliderHeld = false), true);

document.addEventListener("mouseover", (e) => {
  const node = elementOf(e.target);
  if (!node || dragTabIds || dragGroupId !== null || dragPlayerTab !== null) return;
  const box = node.closest(".vexp");
  // У боковых строк барабана регулятор не раскрывается — они только поворачивают барабан.
  if (box && !box.closest(".pr:not(.center)")) {
    clearTimeout(volTimer);
    volTimer = 0;
    if (box !== volOpen) volTimer = setTimeout(() => openVolume(box), volOpen ? 0 : VOL_OPEN_MS);
    return;
  }
  scheduleVolumeClose();
});
document.documentElement.addEventListener("mouseleave", scheduleVolumeClose);

// ---------------------------------------------------------------- плеер
//
// Внизу панели — всё, что звучит (в любом окне), по строке на вкладку:
// обложка, трек, громкость и маленькая пауза; снизу тонкая полоса позиции.
// Под строками — пульт трека в центре: позиция с таймкодами (клик и
// перетаскивание — перемотка, колесо — ±5 с), ±10 с, предыдущий/следующий
// и крупная пауза. Кнопки, которых сайт не объявил, приглушены и по нажатию
// объясняют, почему не работают: «следующий трек» без обработчика сайта
// сделать нельзя, а пауза и перемотка работают всегда, если есть плеер.
// Пока команда идёт, кнопка «думает»; не дошла — пульт говорит об этом прямо.
//
// Порядок строк постоянный (его ведёт фон) и меняется только
// перетаскиванием. Две строки и больше — барабан: строки лежат на
// поверхности цилиндра, центральная — крупная и плоская, соседние уходят
// назад, мельчают и тускнеют. Колесо крутит барабан на строку за щелчок,
// пружина (Motion) доводит его до строки с лёгким перелётом — «трещотка».

const PLAYER_TICK_MS = 500;
// Шаг барабана в градусах и высота строки задают его радиус: строки
// касаются друг друга краями, как грани настоящего барабана.
const WHEEL_STEP_DEG = 26;
const WHEEL_ROW_H = 34;
const WHEEL_RADIUS = WHEEL_ROW_H / 2 / Math.tan((WHEEL_STEP_DEG / 2) * (Math.PI / 180));
const WHEEL_VISIBLE = 2.6;
const WHEEL_SPRING = { type: "spring", stiffness: 420, damping: 24, mass: 0.9 };
// Прокрутка тачпадом приходит мелкими порциями — щелчок на каждые столько пикселей.
const WHEEL_PIXELS_PER_STEP = 60;
const PLAYER_MIME = "application/x-sidebar-tabs-player";
const $player = document.getElementById("player");
const $playerList = document.getElementById("player-list");
const playerEls = new Map();
let playerRows = [];
let playerTick = 0;
const fetchingTabs = new Set();
const brokenArtwork = new Set();

function sessionKey(s) {
  return s.tabId + ":" + s.frameId;
}

function sessionOf(row) {
  const key = row && row.dataset.key;
  return playerRows.find((s) => sessionKey(s) === key) || null;
}

// Вкладка звучит в другом окне — список её не знает, спрашиваем отдельно.
function ensureTab(tabId) {
  if (state.tabs.has(tabId) || state.otherTabs.has(tabId) || fetchingTabs.has(tabId)) return;
  fetchingTabs.add(tabId);
  browser.tabs.get(tabId).then(
    (tab) => {
      fetchingTabs.delete(tabId);
      state.otherTabs.set(tabId, tab);
      scheduleRender();
    },
    () => {} // вкладка уже закрыта — фон сам уберёт её из списка
  );
}

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch (e) {
    return "";
  }
}

function button(cls, act, icon, title) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = cls;
  b.dataset.act = act;
  if (icon) b.dataset.icon = icon;
  if (title) b.title = title;
  return b;
}

function makePlayerRow(key) {
  const el = document.createElement("div");
  el.className = "pr";
  el.dataset.key = key;
  el.draggable = true;
  el._v = {};

  const art = button("pr-art", "focus", "", "Перейти к вкладке");
  const img = document.createElement("img");
  img.alt = "";
  img.draggable = false;
  img.addEventListener("error", () => {
    brokenArtwork.add(img.src);
    el._v.art = null;
    if (img.src !== FALLBACK_ICON) scheduleRender();
  });
  art.append(img);

  const text = button("pr-text", "focus", "", "");
  const title = document.createElement("span");
  title.className = "pr-title";
  const subLine = document.createElement("span");
  subLine.className = "pr-sub";
  const eq = document.createElement("span");
  eq.className = "eq";
  eq.append(document.createElement("i"), document.createElement("i"), document.createElement("i"));
  const sub = document.createElement("span");
  subLine.append(eq, sub);
  text.append(title, subLine);

  const bar = document.createElement("div");
  bar.className = "pr-bar";
  const fill = document.createElement("div");
  fill.className = "pr-fill";
  bar.append(fill);

  el.append(
    art,
    text,
    makeVolumeControl("pr-vol vexp"),
    button("pl-btn pl-play", "toggle", "play", ""),
    bar
  );
  el._p = { img, title, sub, fill, bar, vol: el.children[2], play: el.children[3] };
  return el;
}

function updatePlayerRow(el, s) {
  ensureTab(s.tabId);
  const tab = tabById(s.tabId);
  const p = el._p;
  el.dataset.tab = s.tabId;

  const title = s.title || (tab && tab.title) || "Без названия";
  const sub = s.artist || (tab ? hostOf(tab.url) : "");
  if (setIfChanged(el, "title", title)) p.title.textContent = title;
  if (setIfChanged(el, "sub", sub)) p.sub.textContent = sub;
  if (setIfChanged(el, "tip", [title, s.artist, s.album].filter(Boolean).join("\n"))) p.title.parentElement.title = el._v.tip;

  const cover = s.artwork && !brokenArtwork.has(s.artwork) ? s.artwork : "";
  const art = cover || (tab ? iconFor(tab, state.favicons) : "") || FALLBACK_ICON;
  if (setIfChanged(el, "art", art)) {
    p.img.src = art;
    p.img.parentElement.classList.toggle("cover", !!cover);
  }

  const muted = isMuted(tab);
  let cls = "pr";
  if (s.playing) cls += " playing";
  if (muted) cls += " muted";
  if (setIfChanged(el, "cls", cls)) el.className = cls;

  updateVolumeControl(p.vol, s.tabId, false);
  if (setIfChanged(el, "play", s.playing ? "pause" : "play")) {
    p.play.dataset.icon = el._v.play;
    p.play.title = s.playing ? "Пауза" : "Играть";
  }
  p.play.hidden = !s.canPlay;
  p.bar.hidden = !s.position;
  updateRowProgress(el, s);
}

function updateRowProgress(el, s) {
  if (!s.position) return;
  const pos = mediaPosition(s.position, s.playing, Date.now());
  el._p.fill.style.transform = `scaleX(${(pos / s.position.duration).toFixed(4)})`;
  const tip = formatTime(pos) + " / " + formatTime(s.position.duration);
  if (setIfChanged(el, "pos", tip)) el._p.bar.title = tip;
}

function renderPlayer() {
  playerRows = mediaRows(state.media);
  $player.hidden = playerRows.length === 0;

  // reconcile() ведёт общий словарь els списка вкладок — у плеера свой.
  let ref = $playerList.firstChild;
  for (const s of playerRows) {
    const key = sessionKey(s);
    let el = playerEls.get(key);
    if (!el) playerEls.set(key, (el = makePlayerRow(key)));
    updatePlayerRow(el, s);
    if (el === ref) ref = ref.nextSibling;
    else $playerList.insertBefore(el, ref);
  }
  while (ref) {
    const next = ref.nextSibling;
    playerEls.delete(ref.dataset.key);
    ref.remove();
    ref = next;
  }

  for (const id of state.otherTabs.keys()) {
    if (!playerRows.some((s) => s.tabId === id)) state.otherTabs.delete(id);
  }
  syncWheel();
  updateDeck();

  if (playerRows.some((s) => s.playing && s.position)) {
    if (!playerTick) playerTick = setInterval(tickPlayer, PLAYER_TICK_MS);
  } else {
    clearInterval(playerTick);
    playerTick = 0;
  }
}

function tickPlayer() {
  for (const s of playerRows) {
    const el = playerEls.get(sessionKey(s));
    if (el && s.playing) updateRowProgress(el, s);
  }
  if (deckSession && deckSession.playing) updateDeckProgress(deckSession);
}

// Состояние меняем сразу, не дожидаясь ответа страницы — кнопка не «залипает».
// Если страница сделает иначе, следующее её сообщение всё поправит.
function sendMediaControl(s, action, seekTime) {
  if (action === "toggle" && s.canPlay) {
    if (s.position) s.position = { ...s.position, position: mediaPosition(s.position, s.playing, Date.now()), at: Date.now() };
    s.playing = !s.playing;
  } else if (action === "seekto" && s.position) {
    s.position = { ...s.position, position: seekTime, at: Date.now() };
  }
  scheduleRender();
  const token = ++controlToken;
  $player.classList.add("pending");
  const done = (result) => {
    if (token === controlToken) $player.classList.remove("pending");
    if (result === true) return;
    if (result === "ignored") {
      showDeckNote("Сайт не отреагировал на команду — показано, что происходит на самом деле");
      return;
    }
    showDeckNote("Вкладка не ответила — состояние обновлено, попробуйте ещё раз");
    refreshMedia();
  };
  // Фон ответит рассылкой фактического состояния; не дошло — спросим сами.
  browser.runtime.sendMessage({ type: "mediaControl", tabId: s.tabId, frameId: s.frameId, action, seekTime }).then(done, (err) => {
    report(err);
    done(false);
  });
}

function refreshMedia() {
  browser.runtime.sendMessage({ type: "getMedia" }).then((list) => {
    if (Array.isArray(list)) {
      state.media = list;
      scheduleRender();
    }
  }, report);
}

function onPlayerClick(e) {
  if ($deck.contains(e.target)) {
    onDeckClick(e);
    return;
  }
  const row = e.target.closest(".pr");
  const s = sessionOf(row);
  if (!s) return;
  const btn = e.target.closest("[data-act]");
  if (btn) {
    const act = btn.dataset.act;
    if (act === "mute") toggleMuted(s.tabId);
    else if (act === "focus") {
      run(browser.tabs.update(s.tabId, { active: true }));
      if (s.windowId !== state.windowId) run(browser.windows.update(s.windowId, { focused: true }));
    } else sendMediaControl(s, act);
  }
}

// ---------------------------------------------------------------- пульт трека
//
// Один на весь плеер и всегда про строку в центре барабана. Фон плеера —
// её обложка, размытая в пятно цвета: картинка одна и статичная, поэтому
// размытие считается раз и дальше ничего не стоит.

const SKIP_SEC = 10;
const WHEEL_SEEK_SEC = 5;
const $deck = document.getElementById("deck");
const $deckBar = document.getElementById("deck-bar");
const $deckTip = document.getElementById("deck-tip");
const $deckPos = document.getElementById("deck-pos");
const $deckDur = document.getElementById("deck-dur");
const $playerBg = document.getElementById("player-bg");
const deckBtn = (act) => $deck.querySelector(`[data-act="${act}"]`);
const $dkPlay = deckBtn("toggle");
const $dkPrev = deckBtn("previoustrack");
const $dkNext = deckBtn("nexttrack");
const $dkBack = deckBtn("back");
const $dkFwd = deckBtn("forward");
let deckSession = null;
let controlToken = 0;
let noteTimer = 0;
const NOTE_MS = 3500;
const $deckNote = document.getElementById("deck-note");
const $deckNoteText = document.getElementById("deck-note-text");
const $deckReload = document.getElementById("deck-reload");
let deckCover = null;
// Время под пальцем, пока тянут ползунок: позиция с сайта его не перебивает.
let deckDragTime = null;

function centerSession() {
  return playerRows.find((r) => r.tabId === wheelCenterTab) || playerRows[0] || null;
}

function canSkip(s) {
  return !!(s.position && s.canSeek) || s.actions.includes("seekforward");
}

function updateDeck() {
  const s = centerSession();
  deckSession = s;
  if (!s) return;

  const cover = s.artwork && !brokenArtwork.has(s.artwork) ? s.artwork : "";
  if (cover !== deckCover) {
    deckCover = cover;
    $playerBg.style.backgroundImage = cover ? `url(${JSON.stringify(cover)})` : "";
    $player.classList.toggle("has-cover", !!cover);
  }
  $player.classList.toggle("is-playing", s.playing);

  const icon = s.playing ? "pause-fill" : "play-fill";
  if ($dkPlay.dataset.icon !== icon) $dkPlay.dataset.icon = icon;
  const noSite = s.basic
    ? "Звук идёт без плеера (Web Audio) — сайт не даёт им управлять, можно только громкость"
    : s.late
      ? "Расширение обновилось после загрузки страницы — кнопки сайта вернутся после её перезагрузки"
      : "";
  setOff($dkPlay, s.canPlay, s.playing ? "Пауза" : "Играть", noSite);
  setOff($dkPrev, s.actions.includes("previoustrack"), "Предыдущий трек", noSite || "Этот сайт не даёт переключать треки извне");
  setOff($dkNext, s.actions.includes("nexttrack"), "Следующий трек", noSite || "Этот сайт не даёт переключать треки извне");
  setOff($dkBack, canSkip(s), "Назад на 10 секунд", noSite || "Этот сайт не даёт перематывать");
  setOff($dkFwd, canSkip(s), "Вперёд на 10 секунд", noSite || "Этот сайт не даёт перематывать");

  // Постоянная подсказка — когда кнопки сайта точно могли быть, но потерялись.
  const sticky = s.late ? "Кнопки сайта вернутся после перезагрузки вкладки" : "";
  if (!noteTimer) setDeckNote(sticky, !!sticky);

  // Без длительности полосы нет; «Эфир» — только у настоящей трансляции,
  // а не у любого трека, длину которого сайт не сообщил.
  $deck.classList.toggle("live", !s.position && s.live === true);
  $deck.classList.toggle("no-pos", !s.position && s.live !== true);
  $deck.classList.toggle("seekable", !!s.position && s.canSeek);
  updateDeckProgress(s);
}

// Недоступная кнопка не выключается совсем: по нажатию объясняет причину.
function setOff(btn, on, title, why) {
  btn.classList.toggle("off", !on);
  btn.dataset.why = on ? "" : why;
  const t = on ? title : `${title} — недоступно: ${why}`;
  if (btn.title !== t) btn.title = t;
}

function setDeckNote(text, reload) {
  $deckNote.hidden = !text;
  if ($deckNoteText.textContent !== text) $deckNoteText.textContent = text;
  $deckReload.hidden = !reload;
}

// Короткое сообщение на NOTE_MS, потом пульт возвращается к обычному виду.
function showDeckNote(text) {
  clearTimeout(noteTimer);
  setDeckNote(text, false);
  noteTimer = setTimeout(() => {
    noteTimer = 0;
    updateDeck();
  }, NOTE_MS);
}

function updateDeckProgress(s) {
  if (!s.position) return;
  const duration = s.position.duration;
  const pos = deckDragTime !== null ? deckDragTime : mediaPosition(s.position, s.playing, Date.now());
  $deckBar.style.setProperty("--p", (pos / duration).toFixed(4));
  const a = formatTime(pos);
  const b = formatTime(duration);
  if ($deckPos.textContent !== a) $deckPos.textContent = a;
  if ($deckDur.textContent !== b) $deckDur.textContent = b;
  $deckBar.setAttribute("aria-valuetext", a + " из " + b);
}

function skipBy(s, sec) {
  if (s.position && s.canSeek) {
    const pos = mediaPosition(s.position, s.playing, Date.now());
    sendMediaControl(s, "seekto", Math.max(0, Math.min(s.position.duration - 0.5, pos + sec)));
  } else {
    sendMediaControl(s, sec < 0 ? "seekbackward" : "seekforward");
  }
}

function onDeckClick(e) {
  const s = deckSession;
  const btn = e.target.closest("button[data-act]");
  if (!s || !btn) return;
  const act = btn.dataset.act;
  if (btn.classList.contains("off")) showDeckNote(btn.dataset.why);
  else if (act === "reload") run(browser.tabs.reload(s.tabId));
  else if (act === "back") skipBy(s, -SKIP_SEC);
  else if (act === "forward") skipBy(s, SKIP_SEC);
  else sendMediaControl(s, act);
}

function deckTimeAt(e) {
  const r = $deckBar.getBoundingClientRect();
  const x = Math.max(0, Math.min(r.width, e.clientX - r.left));
  return { x, time: (x / r.width) * deckSession.position.duration };
}

function canSeekDeck() {
  return !!(deckSession && deckSession.position && deckSession.canSeek);
}

function showDeckTip(e) {
  const { x, time } = deckTimeAt(e);
  $deckTip.textContent = formatTime(time);
  $deckTip.style.left = x + "px";
  $deckTip.hidden = false;
  return time;
}

$deckBar.addEventListener("pointerdown", (e) => {
  if (e.button !== 0 || !canSeekDeck()) return;
  e.preventDefault();
  $deckBar.setPointerCapture(e.pointerId);
  $deck.classList.add("dragging");
  deckDragTime = showDeckTip(e);
  updateDeckProgress(deckSession);
});

$deckBar.addEventListener("pointermove", (e) => {
  if (!canSeekDeck()) return;
  const time = showDeckTip(e);
  if (deckDragTime === null) return;
  deckDragTime = time;
  updateDeckProgress(deckSession);
});

function endDeckDrag(commit) {
  if (deckDragTime === null) return;
  const time = deckDragTime;
  deckDragTime = null;
  $deck.classList.remove("dragging");
  if (commit && canSeekDeck()) sendMediaControl(deckSession, "seekto", time);
  else if (deckSession) updateDeckProgress(deckSession);
}

$deckBar.addEventListener("pointerup", () => endDeckDrag(true));
$deckBar.addEventListener("pointercancel", () => endDeckDrag(false));
$deckBar.addEventListener("pointerleave", () => {
  if (deckDragTime === null) $deckTip.hidden = true;
});
$deckBar.addEventListener("lostpointercapture", () => {
  $deckTip.hidden = true;
  endDeckDrag(true);
});

$deckBar.addEventListener(
  "wheel",
  (e) => {
    if (!deckSession || !canSkip(deckSession)) return;
    e.preventDefault();
    if (e.deltaY) skipBy(deckSession, Math.sign(e.deltaY) * -WHEEL_SEEK_SEC);
  },
  { passive: false }
);

$deckBar.addEventListener("keydown", (e) => {
  const s = deckSession;
  if (!s) return;
  if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
    e.preventDefault();
    if (canSkip(s)) skipBy(s, (e.key === "ArrowLeft" ? -1 : 1) * WHEEL_SEEK_SEC);
  } else if (e.key === " " || e.key === "Enter") {
    e.preventDefault();
    if (s.canPlay) sendMediaControl(s, "toggle");
  }
});

// Перетаскивание строк плеера — только внутри плеера; со списком вкладок
// не смешивается (свой тип данных, список его не принимает).
let dragPlayerTab = null;
let lastDragSpin = 0;

function playerDropTarget(e) {
  const row = elementOf(e.target) && elementOf(e.target).closest(".pr");
  if (!row) return null;
  const r = row.getBoundingClientRect();
  return { row, before: e.clientY < r.top + r.height / 2 };
}

$playerList.addEventListener("dragstart", (e) => {
  const row = elementOf(e.target) && elementOf(e.target).closest(".pr");
  if (!row) return;
  dragPlayerTab = Number(row.dataset.tab);
  e.dataTransfer.setData(PLAYER_MIME, String(dragPlayerTab));
  e.dataTransfer.effectAllowed = "move";
  row.classList.add("dragging");
  closeVolume();
});

$playerList.addEventListener("dragover", (e) => {
  if (!e.dataTransfer.types.includes(PLAYER_MIME)) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = "move";
  const t = playerDropTarget(e);
  markDrop(t && t.row, t && (t.before ? "drop-before" : "drop-after"));
  // Барабан поворачивается, когда строку подносят к его краю.
  const r = $playerList.getBoundingClientRect();
  const now = performance.now();
  if (now - lastDragSpin > 450) {
    if (e.clientY < r.top + 12) spinBy(-1);
    else if (e.clientY > r.bottom - 12) spinBy(1);
    else return;
    lastDragSpin = now;
  }
});

$playerList.addEventListener("drop", (e) => {
  if (!e.dataTransfer.types.includes(PLAYER_MIME)) return;
  e.preventDefault();
  const t = playerDropTarget(e);
  markDrop(null);
  const tabId = Number(e.dataTransfer.getData(PLAYER_MIME));
  if (!t || !Number.isInteger(tabId)) return;
  let target = t.row;
  if (!t.before) target = target.nextElementSibling;
  const beforeId = target ? Number(target.dataset.tab) : null;
  if (beforeId === tabId) return;

  // Сразу у себя, не дожидаясь рассылки фона.
  const moving = state.media.filter((m) => m.tabId === tabId);
  const rest = state.media.filter((m) => m.tabId !== tabId);
  const at = beforeId === null ? rest.length : rest.findIndex((m) => m.tabId === beforeId);
  rest.splice(at === -1 ? rest.length : at, 0, ...moving);
  state.media = rest;
  scheduleRender();
  run(browser.runtime.sendMessage({ type: "mediaMove", tabId, beforeId }));
});

$playerList.addEventListener("dragend", () => {
  markDrop(null);
  for (const el of $playerList.querySelectorAll(".dragging")) el.classList.remove("dragging");
  dragPlayerTab = null;
});

// ---------------------------------------------------------------- барабан плеера

// Позиция барабана — дробный индекс строки в центре. Ведёт её пружина,
// поэтому прерванный поворот продолжается с текущей скоростью, а не рывком.
const wheelPos = Motion.motionValue(0);
let wheelTarget = 0;
let wheelCenterTab = null;
let wheelAnim = null;
let wheelPixels = 0;

wheelPos.on("change", layoutWheel);

function wheelMode() {
  return playerRows.length >= 2;
}

// Список строк изменился: в центре остаётся та же вкладка (новый плеер,
// вставший наверх, не должен сдвигать то, что сейчас слушают). Самый
// первый раз — в центр то, что играет.
function syncWheel() {
  const wheel = wheelMode();
  $player.classList.toggle("wheel", wheel);
  $player.classList.toggle("wheel-tall", playerRows.length >= 4);
  if (!wheel) {
    stopWheel();
    wheelPos.jump(0);
    wheelTarget = 0;
    wheelCenterTab = playerRows.length ? playerRows[0].tabId : null;
    layoutWheel();
    return;
  }
  let index = playerRows.findIndex((r) => r.tabId === wheelCenterTab);
  if (index === -1) {
    index = wheelCenterTab === null ? Math.max(0, playerRows.findIndex((r) => r.playing)) : Math.min(wheelTarget, playerRows.length - 1);
  }
  if (index !== wheelTarget) {
    const shift = index - wheelTarget;
    stopWheel();
    wheelPos.jump(wheelPos.get() + shift);
    wheelTarget = index;
    spinTo(index);
  }
  wheelCenterTab = playerRows[index].tabId;
  layoutWheel();
}

function stopWheel() {
  if (wheelAnim) wheelAnim.stop();
  wheelAnim = null;
}

function spinTo(index) {
  const target = Math.max(0, Math.min(playerRows.length - 1, index));
  wheelTarget = target;
  wheelCenterTab = playerRows[target] ? playerRows[target].tabId : null;
  updateDeck();
  closeVolume();
  stopWheel();
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) {
    wheelPos.jump(target);
    return;
  }
  wheelAnim = Motion.animate(wheelPos, target, WHEEL_SPRING);
}

function spinBy(steps) {
  if (wheelMode()) spinTo(wheelTarget + steps);
}

// Каждая строка — грань цилиндра: поворот вокруг его оси на (i − позиция)
// шагов. Центральная строка в покое получает transform: none — без
// дробных преобразований текст остаётся резким.
function layoutWheel() {
  const wheel = wheelMode();
  const pos = wheelPos.get();
  for (let i = 0; i < playerRows.length; i++) {
    const el = playerEls.get(sessionKey(playerRows[i]));
    if (!el) continue;
    if (!wheel) {
      el.style.transform = "";
      el.style.opacity = "";
      el.style.visibility = "";
      el.style.zIndex = "";
      el.classList.add("center");
      continue;
    }
    const d = i - pos;
    const ad = Math.abs(d);
    if (ad > WHEEL_VISIBLE) {
      el.style.visibility = "hidden";
      continue;
    }
    el.style.visibility = "";
    el.style.zIndex = String(100 - Math.round(ad * 10));
    el.style.opacity = String(Math.max(0, 1 - ad * 0.34).toFixed(3));
    el.style.transform =
      ad < 0.002
        ? "none"
        : `translateZ(${-WHEEL_RADIUS}px) rotateX(${(-d * WHEEL_STEP_DEG).toFixed(2)}deg) translateZ(${WHEEL_RADIUS}px) scale(${(1 - Math.min(ad, 3) * 0.07).toFixed(3)})`;
    el.classList.toggle("center", ad < 0.5);
  }
}

$playerList.addEventListener(
  "wheel",
  (e) => {
    if (!wheelMode() || elementOf(e.target).closest(".pr.center .vexp")) return;
    e.preventDefault();
    // Колесо мыши — щелчок на деление; тачпад — накапливаем пиксели.
    if (e.deltaMode !== WheelEvent.DOM_DELTA_PIXEL || Math.abs(e.deltaY) >= 50) {
      spinBy(Math.sign(e.deltaY));
      wheelPixels = 0;
      return;
    }
    wheelPixels += e.deltaY;
    while (Math.abs(wheelPixels) >= WHEEL_PIXELS_PER_STEP) {
      spinBy(Math.sign(wheelPixels));
      wheelPixels -= Math.sign(wheelPixels) * WHEEL_PIXELS_PER_STEP;
    }
  },
  { passive: false }
);

// Клик по боковой строке поворачивает к ней барабан; кнопки у неё неактивны,
// чтобы промах по крутящейся строке не ставил на паузу соседний трек.
$playerList.addEventListener(
  "click",
  (e) => {
    const row = elementOf(e.target).closest(".pr");
    if (!row || !wheelMode() || row.classList.contains("center")) return;
    e.stopPropagation();
    const index = playerRows.findIndex((s) => sessionKey(s) === row.dataset.key);
    if (index !== -1) spinTo(index);
  },
  true
);

function listenMedia() {
  browser.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === "mediaState" && Array.isArray(msg.sessions)) {
      state.media = msg.sessions;
      scheduleRender();
    }
  });
  browser.tabs.onUpdated.addListener(
    (tabId, change, tab) => {
      if (!state.otherTabs.has(tabId)) return;
      state.otherTabs.set(tabId, tab);
      scheduleRender();
    },
    { properties: ["mutedInfo", "title", "favIconUrl"] }
  );
}

// ---------------------------------------------------------------- панель сверху
//
// Сводка (сколько вкладок и сколько из них в памяти) и две массовые кнопки:
// выгрузить из памяти все вкладки окна и закрыть все вкладки вне групп.
// Выгрузка безопасна и срабатывает сразу; закрытие — со вторым нажатием:
// кнопка краснеет, «Закрыть» сменяется на «Точно?» и ждёт 3 секунды.

const CONFIRM_MS = 3000;
const $tbTotal = document.getElementById("tb-total");
const $tbLoaded = document.getElementById("tb-loaded");
const $tbDiscard = document.getElementById("tb-discard");
const $tbClose = document.getElementById("tb-close-loose");
const $tbCloseLabel = $tbClose.querySelector(".tb-label");
let closeConfirmTimer = 0;

// Что можно выгрузить: не активная (её Firefox не выгружает), не уже
// выгруженная и не звучащая — музыку молча не обрываем.
function discardableIds(tabs) {
  return tabs.filter((t) => !t.active && !t.discarded && !t.audible).map((t) => t.id);
}

function looseTabIds() {
  return [...state.tabs.values()].filter((t) => !t.pinned && !isGrouped(t)).map((t) => t.id);
}

function renderToolbar() {
  const tabs = [...state.tabs.values()];
  const loaded = tabs.filter((t) => !t.discarded).length;
  const total = pluralTabs(tabs.length);
  const inMemory = `${loaded} в памяти`;
  if ($tbTotal.textContent !== total) $tbTotal.textContent = total;
  if ($tbLoaded.textContent !== inMemory) $tbLoaded.textContent = inMemory;

  const discard = discardableIds(tabs).length;
  $tbDiscard.disabled = discard === 0;
  setCount($tbDiscard, discard);
  $tbDiscard.title = discard
    ? `Выгрузить из памяти все вкладки (${discard}). Активная и звучащие остаются.`
    : "Выгружать нечего";

  const loose = looseTabIds().length;
  $tbClose.disabled = loose === 0;
  setCount($tbClose, loose);
  if (!$tbClose.classList.contains("confirm")) {
    $tbClose.title = loose ? `Закрыть все вкладки вне групп (${loose})` : "Вкладок вне групп нет";
  }
}

// Счётчик на кнопке — сколько вкладок она затронет; ноль не показываем.
function setCount(btn, n) {
  const text = n ? String(n) : "";
  const el = btn.lastChild;
  if (el.textContent !== text) el.textContent = text;
}

function resetCloseConfirm() {
  clearTimeout(closeConfirmTimer);
  $tbClose.classList.remove("confirm");
  $tbCloseLabel.textContent = "Закрыть";
}

function onToolbarClick(e) {
  const btn = e.target.closest("button");
  if (!btn || btn.disabled) return;
  if (btn === $tbDiscard) {
    run(browser.tabs.discard(discardableIds([...state.tabs.values()])));
  } else if (btn === $tbClose) {
    if (!btn.classList.contains("confirm")) {
      btn.classList.add("confirm");
      btn.title = "Нажмите ещё раз, чтобы закрыть";
      $tbCloseLabel.textContent = "Точно?";
      renderToolbar();
      closeConfirmTimer = setTimeout(() => {
        resetCloseConfirm();
        renderToolbar();
      }, CONFIRM_MS);
      return;
    }
    const ids = looseTabIds();
    resetCloseConfirm();
    // Закрыть все вкладки окна нельзя (окно закроется) — тогда оставляем новую.
    if (ids.length >= state.tabs.size) run(newTab());
    run(browser.tabs.remove(ids));
  }
}

// ---------------------------------------------------------------- мышь

const DBLCLICK_WAIT_MS = 230;
let collapseTimer = 0;

document.addEventListener("click", (e) => {
  // Клик по пункту меню: меню к этому моменту уже закрыто и очищено,
  // сам пункт отсоединён от документа — списку вкладок он не адресован.
  if (!e.target.isConnected || $menu.contains(e.target)) return;
  if (e.button !== 0 || e.target.tagName === "INPUT") return;

  if (e.target.closest("#new-tab")) {
    run(newTab());
    return;
  }

  if (e.target.closest("#toolbar")) {
    onToolbarClick(e);
    return;
  }

  if (e.target.closest(".vexp") && !e.target.closest(".pr:not(.center)")) {
    if (e.target.classList.contains("vicon")) toggleMuted(volumeTargetOf(e.target));
    return;
  }
  if ($player.contains(e.target)) {
    onPlayerClick(e);
    return;
  }

  const gid = groupIdOf(e.target);
  if (gid !== null) {
    // По имени группы двойной клик — переименование, поэтому одиночный клик
    // по имени сворачивает с короткой паузой (второй клик её отменяет);
    // по остальному заголовку — сразу.
    clearTimeout(collapseTimer);
    if (!e.target.closest(".gtitle")) toggleCollapsed(gid);
    else if (e.detail === 1) collapseTimer = setTimeout(() => toggleCollapsed(gid), DBLCLICK_WAIT_MS);
    return;
  }

  const id = tabIdOf(e.target);
  if (id === null) {
    if (state.selected.size) setSelection([]);
    return;
  }

  if (e.target.classList.contains("close")) {
    run(browser.tabs.remove(id));
    return;
  }


  if (e.ctrlKey || e.metaKey) {
    const next = new Set(state.selected);
    if (next.size === 0) {
      const active = [...state.tabs.values()].find((t) => t.active);
      if (active) next.add(active.id);
    }
    if (next.has(id)) next.delete(id);
    else next.add(id);
    state.anchorId = id;
    setSelection(next);
    return;
  }

  if (e.shiftKey) {
    const from = state.anchorId !== null ? state.anchorId : state.lastActiveId;
    setSelection(rangeBetween(state.orderedIds, from, id));
    return;
  }

  state.anchorId = id;
  if (state.selected.size) setSelection([]);
  run(browser.tabs.update(id, { active: true }));
});

// Средняя кнопка: закрыть вкладку. mousedown гасится, чтобы не включался автоскролл.
document.addEventListener("mousedown", (e) => {
  if (e.button === 1) e.preventDefault();
});
document.addEventListener("auxclick", (e) => {
  if (e.button !== 1) return;
  const id = tabIdOf(e.target);
  if (id !== null) run(browser.tabs.remove(id));
});

document.addEventListener("dblclick", (e) => {
  if (e.target.tagName === "INPUT") return;
  const gid = groupIdOf(e.target);
  if (gid !== null) {
    if (e.target.closest(".gtitle")) {
      clearTimeout(collapseTimer);
      startRename(gid);
    }
    return;
  }
  if (e.target === $scroll || e.target.id === "filler" || e.target === $rows) run(newTab());
});

// Колесо над значком звука, регулятором или громкостью плеера — ±5%.
document.addEventListener(
  "wheel",
  (e) => {
    const node = elementOf(e.target);
    if (!node) return;
    let ids = null;
    const box = node.closest(".vexp");
    if (box && box.closest(".pr")) ids = box.closest(".pr:not(.center)") ? null : [volumeTargetOf(box)];
    else if (box) ids = targetsFor(tabIdOf(box));
    if (!ids || ids[0] === null) return;
    e.preventDefault();
    // Колесо на себя (вниз) — громче, от себя — тише.
    const next = Math.min(1, Math.max(0, Math.round((shownVolume(ids[0]) + (e.deltaY > 0 ? 0.05 : -0.05)) * 20) / 20));
    changeVolume(ids, next, false);
  },
  { passive: false }
);

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    if (volOpen) closeVolume();
    else if (!$menu.hidden) closeMenu();
    else if (state.selected.size) setSelection([]);
  }
});

// ---------------------------------------------------------------- перетаскивание
//
// Три вида перетаскивания, различаются по типу данных в dataTransfer:
//   вкладки (MIME)       — перестановка + группировка, см. planDrop;
//   группа (GROUP_MIME)  — перенос группы целиком, см. planGroupDrop;
//   ссылки со страниц    — открыть новые вкладки в месте броска.
// Вкладка, брошенная вне панели (на страницу, на рабочий стол), уходит
// в новое окно — как в обычной полосе вкладок.

const GROUP_MIME = "application/x-sidebar-tabs-group";
const URL_TYPES = ["text/x-moz-url", "text/uri-list"];
const AUTOSCROLL_EDGE = 36;
const EXPAND_DELAY_MS = 600;
const MAX_DROPPED_URLS = 20;

const $dragImage = document.getElementById("drag-image");

let dragTabIds = null;
let dragGroupId = null;
let dropMarked = null;

function dragKind(dt) {
  const types = dt.types;
  if (types.includes(MIME)) return "tabs";
  if (types.includes(GROUP_MIME)) return "group";
  if (URL_TYPES.some((t) => types.includes(t))) return "url";
  return null;
}

function markDrop(el, cls) {
  if (dropMarked && (dropMarked.el !== el || dropMarked.cls !== cls)) {
    dropMarked.el.classList.remove(dropMarked.cls);
    dropMarked = null;
  }
  if (el && !dropMarked) {
    el.classList.add(cls);
    dropMarked = { el, cls };
  }
}

function dropTargetAt(e, kind) {
  const node = elementOf(e.target);
  if (!node) return null;

  const tabEl = node.closest("[data-id]");
  if (tabEl) {
    const r = tabEl.getBoundingClientRect();
    if (tabEl.classList.contains("pin")) {
      if (kind !== "tabs") return null;
      return { kind: "tab", tabId: Number(tabEl.dataset.id), zone: dropZone(e.clientX - r.left, r.width, false) };
    }
    const zone = dropZone(e.clientY - r.top, r.height, hasGroups && kind !== "group");
    return { kind: "tab", tabId: Number(tabEl.dataset.id), zone };
  }

  const groupEl = node.closest("[data-gid]");
  if (groupEl && hasGroups) {
    const r = groupEl.getBoundingClientRect();
    const y = e.clientY - r.top;
    const zone =
      kind === "group" ? (y < r.height / 2 ? "before" : "after") : y < r.height * 0.25 ? "before" : "onto";
    return { kind: "group", groupId: Number(groupEl.dataset.gid), zone };
  }

  if ($scroll.contains(node)) return { kind: "end" };
  return null;
}

// Где рисовать индикатор для якоря "до/после вкладки": у первой вкладки
// группы место "до неё" визуально над заголовком группы, а у вкладки,
// скрытой в свёрнутой группе, — "после" рисуется на заголовке.
function anchorIndicator(anchor) {
  if (anchor.end) return [$scroll, "drop-end"];
  const tab = state.tabs.get(anchor.tabId);
  if (!tab) return [null];
  if (isGrouped(tab)) {
    const members = tabsOfGroup(tab.groupId);
    const header = els.get("g" + tab.groupId);
    if (anchor.side === "before" && members[0] && members[0].id === tab.id && header) return [header, "drop-before"];
    if (anchor.side === "after" && !els.has("t" + tab.id) && header) return [header, "drop-after"];
  }
  const row = els.get("t" + tab.id);
  return row ? [row, "drop-" + anchor.side] : [null];
}

function indicatorFor(target, kind) {
  if (kind === "group") {
    const plan = planGroupDrop(dragGroupId === null ? NaN : dragGroupId, target, state.tabs);
    return plan ? anchorIndicator(plan.anchor) : [null];
  }
  if (target.kind === "end") return [$scroll, "drop-end"];
  if (target.kind === "group") {
    return [els.get("g" + target.groupId), target.zone === "before" ? "drop-before" : "drop-onto"];
  }
  return [els.get((state.tabs.get(target.tabId) || {}).pinned ? "p" + target.tabId : "t" + target.tabId), "drop-" + target.zone];
}

// Автопрокрутка у краёв списка. dragover приходит слишком редко для плавной
// прокрутки, поэтому крутим своим циклом по кадрам, пока курсор у края;
// цикл сам глохнет, если dragover перестал приходить (курсор ушёл из панели).
let scrollSpeed = 0;
let scrollRaf = 0;
let lastDragOver = 0;

function updateAutoscroll(e) {
  const r = $scroll.getBoundingClientRect();
  const fromTop = e.clientY - r.top;
  const fromBottom = r.bottom - e.clientY;
  scrollSpeed = 0;
  if (fromTop < AUTOSCROLL_EDGE) scrollSpeed = -Math.ceil((AUTOSCROLL_EDGE - Math.max(fromTop, 0)) / 3);
  else if (fromBottom < AUTOSCROLL_EDGE) scrollSpeed = Math.ceil((AUTOSCROLL_EDGE - Math.max(fromBottom, 0)) / 3);
  lastDragOver = performance.now();
  if (scrollSpeed && !scrollRaf) scrollRaf = requestAnimationFrame(autoscrollTick);
}

function autoscrollTick() {
  scrollRaf = 0;
  if (!scrollSpeed || performance.now() - lastDragOver > 400) return;
  $scroll.scrollTop += scrollSpeed;
  scrollRaf = requestAnimationFrame(autoscrollTick);
}

// Свёрнутая группа разворачивается, если задержать над ней перетаскиваемую
// вкладку — иначе нельзя бросить вкладку в конкретное место внутри неё.
let expandTimer = null;
let expandGid = null;

function updateHoverExpand(target, kind) {
  const gid = kind !== "group" && target && target.kind === "group" && target.zone === "onto" ? target.groupId : null;
  const group = gid !== null ? state.groups.get(gid) : null;
  const wanted = group && group.collapsed ? gid : null;
  if (wanted === expandGid) return;
  clearTimeout(expandTimer);
  expandGid = wanted;
  if (wanted !== null) {
    expandTimer = setTimeout(() => {
      expandGid = null;
      run(browser.tabGroups.update(wanted, { collapsed: false }));
    }, EXPAND_DELAY_MS);
  }
}

function clearDragFeedback() {
  markDrop(null);
  scrollSpeed = 0;
  clearTimeout(expandTimer);
  expandGid = null;
  for (const el of document.querySelectorAll(".dragging")) el.classList.remove("dragging");
}

function pluralTabs(n) {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return n + " вкладка";
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return n + " вкладки";
  return n + " вкладок";
}

document.addEventListener("dragstart", (e) => {
  if (e.target.tagName === "INPUT") return;
  const gid = groupIdOf(e.target);
  if (gid !== null) {
    dragGroupId = gid;
    e.dataTransfer.setData(GROUP_MIME, String(gid));
    e.dataTransfer.effectAllowed = "move";
    for (const t of tabsOfGroup(gid)) {
      const row = els.get("t" + t.id);
      if (row) row.classList.add("dragging");
    }
    els.get("g" + gid).classList.add("dragging");
    return;
  }

  const id = tabIdOf(e.target);
  if (id === null) return;
  const ids = targetsFor(id);
  dragTabIds = ids;
  e.dataTransfer.setData(MIME, JSON.stringify(ids));
  e.dataTransfer.effectAllowed = "move";
  if (ids.length > 1) {
    $dragImage.textContent = pluralTabs(ids.length);
    e.dataTransfer.setDragImage($dragImage, 12, 12);
  }
  for (const x of ids) {
    const el = els.get("t" + x) || els.get("p" + x);
    if (el) el.classList.add("dragging");
  }
});

document.addEventListener("dragover", (e) => {
  const kind = dragKind(e.dataTransfer);
  if (!kind) return;
  e.preventDefault();
  if (kind !== "url") e.dataTransfer.dropEffect = "move";
  updateAutoscroll(e);
  const target = dropTargetAt(e, kind);
  const [el, cls] = target ? indicatorFor(target, kind) : [null];
  markDrop(el, cls);
  updateHoverExpand(target, kind);
});

document.addEventListener("dragleave", (e) => {
  if (!e.relatedTarget) {
    markDrop(null);
    scrollSpeed = 0;
    updateHoverExpand(null, null);
  }
});

document.addEventListener("dragend", (e) => {
  clearDragFeedback();
  const dt = e.dataTransfer;
  // dropEffect "none" без отмены по Esc — вкладку бросили туда, где её
  // никто не принял: вне панели. Внутри панели бросок принимается всегда.
  if (dragTabIds && dt.dropEffect === "none" && !dt.mozUserCancelled) run(detachToWindow(dragTabIds));
  dragTabIds = null;
  dragGroupId = null;
});

document.addEventListener("drop", (e) => {
  const kind = dragKind(e.dataTransfer);
  if (!kind) return;
  e.preventDefault();
  const target = dropTargetAt(e, kind);
  clearDragFeedback();
  if (!target) return;

  if (kind === "tabs") {
    let ids;
    try {
      ids = JSON.parse(e.dataTransfer.getData(MIME)).map(Number);
    } catch (err) {
      return;
    }
    run(executeDrop(ids, target));
  } else if (kind === "group") {
    const gid = Number(e.dataTransfer.getData(GROUP_MIME));
    if (Number.isInteger(gid)) run(executeGroupDrop(gid, target));
  } else {
    run(dropUrls(readUrls(e.dataTransfer), target));
  }
});

async function executeDrop(ids, target) {
  const plan = planDrop(ids, target, state.tabs);
  if (!plan) return;

  try {
    // Вкладки, перетащенные из панели другого окна, сначала переносим сюда.
    const foreign = plan.ids.filter((id) => !state.tabs.has(id));
    if (foreign.length) await browser.tabs.move(foreign, { windowId: state.windowId, index: -1 });

    if (hasGroups && plan.group) {
      if (plan.group.type === "join") {
        await browser.tabs.group({ tabIds: plan.ids, groupId: plan.group.groupId });
      } else if (plan.group.type === "new") {
        state.renameGroupId = await browser.tabs.group({ tabIds: [plan.group.withTabId, ...plan.ids] });
      } else if (plan.group.type === "ungroup") {
        const grouped = plan.ids.filter((id) => state.tabs.has(id) && isGrouped(state.tabs.get(id)));
        if (grouped.length) await browser.tabs.ungroup(grouped);
      }
    }

    // Групповые операции сами переставляют вкладки, поэтому индекс считается
    // по свежему состоянию окна, а не по тому, что было на момент броска.
    if (plan.anchor) {
      const fresh = await browser.tabs.query({ windowId: state.windowId });
      const index = computeMoveIndex(fresh, plan.ids, plan.anchor);
      if (index !== null) await browser.tabs.move(plan.ids, { index });
    }
  } catch (err) {
    report(err);
  }
  setSelection([]);
  scheduleResync();
}

// Группа переносится только через tabGroups.move: перенос её вкладок по
// одной через tabs.move разрывал бы группу — первая же унесённая вкладка
// перестаёт соседствовать с остальными и выпадает из неё.
async function executeGroupDrop(gid, target) {
  if (typeof browser.tabGroups.move !== "function") return;
  const plan = planGroupDrop(gid, target, state.tabs);
  if (!plan) return;
  const foreign = !state.groups.has(gid);

  try {
    const fresh = await browser.tabs.query({ windowId: state.windowId });
    const index = computeMoveIndex(fresh, plan.memberIds, plan.anchor);
    if (index === null) return;
    await browser.tabGroups.move(gid, foreign ? { windowId: state.windowId, index } : { index });

    // index здесь — итоговая позиция первой вкладки группы. Если браузер
    // трактует его иначе (до изъятия группы), поправляем одним повтором.
    if (index !== -1) {
      const after = await browser.tabs.query({ windowId: state.windowId });
      const first = after.filter((t) => t.groupId === gid).sort((a, b) => a.index - b.index)[0];
      if (first && first.index !== index) {
        await browser.tabGroups.move(gid, { index: index + (index - first.index) });
      }
    }
  } catch (err) {
    report(err);
  }
  scheduleResync();
}

async function detachToWindow(ids) {
  const own = ids.filter((id) => state.tabs.has(id));
  // Унести все вкладки окна в новое окно — бессмысленно (старое опустеет).
  if (own.length === 0 || own.length >= state.tabs.size) return;
  try {
    const win = await browser.windows.create({ tabId: own[0] });
    if (own.length > 1) await browser.tabs.move(own.slice(1), { windowId: win.id, index: -1 });
  } catch (err) {
    report(err);
  }
  setSelection([]);
}

// Ссылки, перетащенные со страниц. Открываем только обычные адреса —
// tabs.create всё равно отказывается открывать привилегированные.
function readUrls(dt) {
  const moz = dt.getData("text/x-moz-url");
  const lines = moz
    ? moz.split("\n").filter((_, i) => i % 2 === 0)
    : dt.getData("text/uri-list").split(/\r?\n/).filter((l) => !l.startsWith("#"));
  return lines
    .map((l) => l.trim())
    .filter((u) => /^(https?|ftp):/i.test(u))
    .slice(0, MAX_DROPPED_URLS);
}

async function dropUrls(urls, target) {
  if (urls.length === 0) return;
  const created = await Promise.all(
    urls.map((url) => browser.tabs.create({ windowId: state.windowId, url, active: false }))
  );
  await executeDrop(
    created.map((t) => t.id),
    target
  );
}

// ---------------------------------------------------------------- контекстное меню

function closeMenu() {
  $menu.hidden = true;
  $menu.textContent = "";
}

function openMenu(items, x, y) {
  $menu.textContent = "";
  for (const item of items) {
    if (item === "-") {
      const sep = document.createElement("div");
      sep.className = "sep";
      $menu.append(sep);
      continue;
    }
    if (item.swatches) {
      const box = document.createElement("div");
      box.className = "swatches";
      for (const color of GROUP_COLORS) {
        const sw = document.createElement("span");
        sw.className = color === item.current ? "swatch current" : "swatch";
        sw.title = color;
        setColorVar(sw, color);
        sw.addEventListener("click", () => {
          closeMenu();
          item.pick(color);
        });
        box.append(sw);
      }
      $menu.append(box);
      continue;
    }
    const mi = document.createElement("div");
    mi.className = item.danger ? "mi danger" : "mi";
    mi.setAttribute("role", "menuitem");
    if (item.color) {
      const dot = document.createElement("span");
      dot.className = "dot";
      setColorVar(dot, item.color);
      mi.append(dot);
    }
    mi.append(item.label);
    mi.addEventListener("click", () => {
      closeMenu();
      run(item.action());
    });
    $menu.append(mi);
  }

  $menu.hidden = false;
  const w = $menu.offsetWidth;
  const h = $menu.offsetHeight;
  $menu.style.left = Math.max(4, Math.min(x, innerWidth - w - 4)) + "px";
  $menu.style.top = Math.max(4, Math.min(y, innerHeight - h - 4)) + "px";
}

function tabMenu(id) {
  const ids = targetsFor(id);
  if (!state.selected.has(id)) setSelection([]);
  const tabs = ids.map((x) => state.tabs.get(x)).filter(Boolean);
  const first = tabs[0];
  if (!first) return [];
  const n = tabs.length;
  const suffix = n > 1 ? ` (${n})` : "";
  const items = [];

  if (hasGroups && !tabs.some((t) => t.pinned)) {
    items.push({ label: "Новая группа" + suffix, action: () => groupTabs(ids) });
    for (const g of state.groups.values()) {
      if (tabs.every((t) => t.groupId === g.id)) continue;
      items.push({
        label: "В группу «" + (g.title || "Без названия") + "»",
        color: groupColor(g),
        action: () => groupTabs(ids, g.id),
      });
    }
    const grouped = tabs.filter(isGrouped).map((t) => t.id);
    if (grouped.length) items.push({ label: "Убрать из группы", action: () => browser.tabs.ungroup(grouped) });
    items.push("-");
  }

  const muted = !!(first.mutedInfo && first.mutedInfo.muted);
  items.push({ label: (muted ? "Включить звук" : "Выключить звук") + suffix, action: () => setMuted(ids, !muted) });
  items.push({
    label: "Громкость…",
    action: () => {
      const el = els.get((first.pinned ? "p" : "t") + id);
      if (el && el.querySelector(".vexp")) openVolume(el.querySelector(".vexp"), true);
    },
  });
  items.push("-");
  items.push(
    { label: "Перезагрузить" + suffix, action: () => Promise.all(ids.map((x) => browser.tabs.reload(x))) },
    { label: "Дублировать" + suffix, action: () => Promise.all(ids.map((x) => browser.tabs.duplicate(x))) },
    {
      label: (first.pinned ? "Открепить" : "Закрепить") + suffix,
      action: () => Promise.all(ids.map((x) => browser.tabs.update(x, { pinned: !first.pinned }))),
    },
    {
      label: "Выгрузить из памяти" + suffix,
      action: () => browser.tabs.discard(tabs.filter((t) => !t.active).map((t) => t.id)),
    },
    "-",
    {
      label: "Закрыть другие вкладки",
      action: () =>
        browser.tabs.remove([...state.tabs.values()].filter((t) => !t.pinned && !ids.includes(t.id)).map((t) => t.id)),
    },
    { label: n > 1 ? `Закрыть вкладки (${n})` : "Закрыть вкладку", danger: true, action: () => browser.tabs.remove(ids) }
  );
  return items;
}

function groupMenu(gid) {
  const g = state.groups.get(gid);
  if (!g) return [];
  const ids = () => tabsOfGroup(gid).map((t) => t.id);
  return [
    { label: "Переименовать", action: () => startRename(gid) },
    { swatches: true, current: groupColor(g), pick: (color) => run(browser.tabGroups.update(gid, { color })) },
    { label: g.collapsed ? "Развернуть" : "Свернуть", action: () => browser.tabGroups.update(gid, { collapsed: !g.collapsed }) },
    { label: "Новая вкладка в группе", action: () => newTabInGroup(gid) },
    {
      label: `Выгрузить из памяти (${discardableIds(tabsOfGroup(gid)).length})`,
      action: () => browser.tabs.discard(discardableIds(tabsOfGroup(gid))),
    },
    "-",
    { label: "Разгруппировать", action: () => browser.tabs.ungroup(ids()) },
    { label: "Закрыть группу", danger: true, action: () => browser.tabs.remove(ids()) },
  ];
}

document.addEventListener("contextmenu", (e) => {
  if (e.target.tagName === "INPUT") return;
  e.preventDefault();
  if ($player.contains(e.target) || e.target.closest("#toolbar")) return;
  const gid = groupIdOf(e.target);
  const id = tabIdOf(e.target);
  const items =
    gid !== null ? groupMenu(gid) : id !== null ? tabMenu(id) : [{ label: "Новая вкладка", action: () => newTab() }];
  if (items.length) openMenu(items, e.clientX, e.clientY);
});

document.addEventListener(
  "mousedown",
  (e) => {
    if (!$menu.hidden && !$menu.contains(e.target)) closeMenu();
    if (volOpen && !volOpen.contains(e.target)) closeVolume();
  },
  true
);
window.addEventListener("blur", closeMenu);
window.addEventListener("resize", () => {
  closeMenu();
  closeVolume();
});
$scroll.addEventListener(
  "scroll",
  () => {
    closeMenu();
    closeVolume();
  },
  { passive: true }
);

// ---------------------------------------------------------------- старт

(async () => {
  try {
    const [win, stored, volumes, media] = await Promise.all([
      browser.windows.getCurrent(),
      browser.storage.local.get("favicons").catch(() => ({})),
      browser.runtime.sendMessage({ type: "getVolumes" }).catch(() => ({})),
      browser.runtime.sendMessage({ type: "getMedia" }).catch(() => []),
    ]);
    state.windowId = win.id;
    state.media = Array.isArray(media) ? media : [];
    for (const [id, v] of Object.entries(volumes || {})) state.volumes.set(Number(id), v);
    if (stored.favicons && typeof stored.favicons === "object") {
      state.favicons = new Map(Object.entries(stored.favicons));
    }
    listenTheme();
    listenMedia();
    listen();
    await resync();
  } catch (err) {
    report(err);
  }
})();
