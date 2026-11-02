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
 *
 * Файлы панели (обычные скрипты, одна общая глобальная область; порядок —
 * в sidebar.html, каждый следующий может пользоваться предыдущими):
 *   spring.js  — пружины для анимаций;
 *   model.js   — чистая логика без DOM (раскладка, броски, дубликаты, плеер);
 *   sidebar.js — ядро: состояние, синхронизация с Firefox, настройки,
 *                горячие клавиши, контейнеры, тема, планировщик отрисовки;
 *   list.js    — строки списка, плавные перестановки, действия;
 *   volume.js  — громкость и микрофон;
 *   player.js  — плеер, пульт, скорость, барабан;
 *   toolbar.js — полоса сверху, плагины, недавно закрытые;
 *   input.js   — мышь, перетаскивание, контекстное меню;
 *   main.js    — запуск.
 */

const RESYNC_DELAY_MS = 16;
// Запрос вкладок не удался — повтор через столько (иначе список так и
// остался бы устаревшим до следующего события вкладок).
const RESYNC_RETRY_MS = 500;
const MIME = "application/x-sidebar-tabs-tabs";
// Абсолютный URL: onIconError сравнивает его с img.src, который браузер
// всегда разворачивает в абсолютный, — с относительным путём сравнение не
// совпало бы, и сбой загрузки заглушки зациклился бы.
const FALLBACK_ICON = browser.runtime.getURL("icons/lucide/globe-fallback.svg");

const hasGroups = typeof browser.tabs.group === "function" && !!browser.tabGroups;

const state = {
  windowId: null,
  // Приватное окно: контейнеров в нём не бывает.
  incognito: false,
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
  // tabId → { volume, muted } микрофона вкладки (ведёт background.js, по
  // умолчанию — 100% и включён; см. content/mic.js).
  mic: new Map(),
  // Вкладки, где микрофоном управлять не вышло (захвачен до установки расширения).
  micBlocked: new Set(),
  // Плагины (ведёт background.js): [{ id, name, description, enabled, buttons }].
  plugins: [],
  // Что играет во вкладках (ведёт background.js, см. content/media.js).
  media: [],
  // Вкладки плеера из других окон (своего окна — в tabs).
  otherTabs: new Map(),
  // Настройки (страница options/, см. shared/settings.js).
  settings: SidebarSettings.normalizeSettings(null),
  // Имя команды → сочетание клавиш ("Ctrl+Alt+M"); только назначенные.
  shortcuts: new Map(),
  os: "linux",
  // cookieStoreId → контейнер Firefox ({ name, colorCode, … }).
  containers: new Map(),
  // tabId → сколько ещё вкладок открыто на той же странице.
  dups: new Map(),
  // Какие вкладки закроет кнопка дубликатов (считается в render() вместе с dups).
  dupsToClose: [],
  // sessions.getRecentlyClosed() — для блока «Недавно закрытые».
  closed: [],
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
    setTimeout(scheduleResync, RESYNC_RETRY_MS);
  } finally {
    resyncRunning = false;
  }
  for (const id of state.selected) if (!state.tabs.has(id)) state.selected.delete(id);
  // Громкость не чистим: её держит фон для вкладок всех окон, а плеер
  // показывает вкладку и из другого окна.
  for (const id of state.volumeBlocked) if (!state.tabs.has(id)) state.volumeBlocked.delete(id);
  for (const id of state.mic.keys()) if (!state.tabs.has(id)) state.mic.delete(id);
  for (const id of state.micBlocked) if (!state.tabs.has(id)) state.micBlocked.delete(id);
  scheduleRender();
}

// Точечная правка пришла, пока запрос в полёте: его ответ может оказаться
// старее этой правки — повторяем запрос, а не рискуем откатить состояние.
// Новый адрес меняет дубликаты (и у соседей) — тогда полная перерисовка,
// иначе только строка этой вкладки.
function patchTab(tab, change) {
  state.tabs.set(tab.id, tab);
  if (resyncRunning) resyncAgain = true;
  if (change && change.url !== undefined) scheduleRender();
  else scheduleRender([tab.id]);
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
    const changed = [];
    for (const tab of state.tabs.values()) {
      const active = tab.id === info.tabId;
      if (tab.active !== active) changed.push(tab.id);
      tab.active = active;
    }
    scheduleRender(changed);
  });
  t.onUpdated.addListener(
    (tabId, change, tab) => {
      // pinned/groupId/hidden меняют раскладку и индексы соседей — это уже
      // структурное изменение, остальное (заголовок, иконка, звук) — косметика.
      if (change.pinned !== undefined || change.groupId !== undefined || change.hidden !== undefined) {
        scheduleResync();
      } else {
        patchTab(tab, change);
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

// ---------------------------------------------------------------- настройки

function listenSettings() {
  browser.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes[PLUGINS_KEY]) loadPlugins().catch(report);
    if (!changes[SidebarSettings.SETTINGS_KEY]) return;
    const prevColors = JSON.stringify(state.settings.colors);
    state.settings = SidebarSettings.normalizeSettings(changes[SidebarSettings.SETTINGS_KEY].newValue);
    if (JSON.stringify(state.settings.colors) !== prevColors) applyTheme(lastTheme);
    scheduleRender();
    renderClosed();
  });
}

function saveSettings(patch) {
  state.settings = { ...state.settings, ...patch };
  return browser.storage.local.set({ [SidebarSettings.SETTINGS_KEY]: state.settings });
}

// ---------------------------------------------------------------- горячие клавиши
//
// Подсказки в меню и всплывающих подсказках. Сочетания своих команд
// (manifest.json → commands) берутся у Firefox — с учётом того, что
// пользователь переназначил, и обновляются, когда он их меняет. Сочетания
// самого Firefox расширению не узнать — для них известные стандартные (их
// в Firefox не переназначить).

const FIREFOX_KEYS = {
  "ff-new-tab": "Ctrl+T",
  "ff-close": "Ctrl+W",
  "ff-reopen": "Ctrl+Shift+T",
  "ff-reload": "Ctrl+R",
  "ff-mute": "Ctrl+M",
};

async function loadShortcuts() {
  if (!browser.commands || typeof browser.commands.getAll !== "function") return;
  const list = await browser.commands.getAll();
  const next = new Map(list.filter((c) => c.shortcut).map((c) => [c.name, c.shortcut]));
  if ([...next].join() === [...state.shortcuts].join()) return;
  state.shortcuts = next;
  scheduleRender();
}

function listenShortcuts() {
  run(browser.runtime.getPlatformInfo().then((info) => (state.os = info.os)));
  run(loadShortcuts());
  if (browser.commands && browser.commands.onChanged) browser.commands.onChanged.addListener(() => run(loadShortcuts()));
  // Сочетание могли поменять в about:addons, пока панель была не в фокусе.
  window.addEventListener("focus", () => run(loadShortcuts()));
}

// Сочетание для подсказки или "" (не назначено или подсказки выключены).
function keyHint(name) {
  if (!state.settings.shortcutHints) return "";
  let raw = state.shortcuts.get(name) || FIREFOX_KEYS[name] || "";
  // Cmd+M на macOS сворачивает окно — звук там выключает Ctrl+M.
  if (name === "ff-mute" && state.os === "mac") raw = "MacCtrl+M";
  return SidebarSettings.formatShortcut(raw, state.os);
}

function withHint(title, name) {
  const key = keyHint(name);
  return key ? `${title} (${key})` : title;
}

// ---------------------------------------------------------------- контейнеры

const hasContainers = !!browser.contextualIdentities;

// Контейнеры выключены в Firefox — query отказывает, список просто пуст.
async function loadContainers() {
  let list = [];
  try {
    list = await browser.contextualIdentities.query({});
  } catch (err) {}
  state.containers = new Map(list.map((c) => [c.cookieStoreId, c]));
  scheduleRender();
}

function listenContainers() {
  if (!hasContainers) return;
  run(loadContainers());
  const ci = browser.contextualIdentities;
  for (const ev of [ci.onCreated, ci.onUpdated, ci.onRemoved]) if (ev) ev.addListener(() => run(loadContainers()));
}

function shownContainer(tab) {
  return state.settings.containers ? containerOf(tab, state.containers) : null;
}

// Контейнер открытой вкладки не сменить: открываем ту же страницу в нужном
// контейнере на её месте (и в её группе), а старую закрываем. По одной:
// create + remove оставляют индексы следующих вкладок прежними.
async function reopenInContainer(ids, cookieStoreId) {
  for (const id of ids) {
    const tab = state.tabs.get(id);
    const props = reopenProps(tab);
    if (!props || (tab.cookieStoreId || DEFAULT_STORE) === cookieStoreId) continue;
    const created = await browser.tabs.create({
      ...props,
      windowId: state.windowId,
      cookieStoreId,
      index: tab.index + 1,
      active: tab.active,
      pinned: tab.pinned,
    });
    if (isGrouped(tab)) await browser.tabs.group({ tabIds: [created.id], groupId: tab.groupId }).catch(report);
    await browser.tabs.remove(id);
  }
  setSelection([]);
}

// Пункты подменю «в контейнере»: pick(cookieStoreId); current — отметить текущий.
function containerItems(pick, current) {
  const mark = (id) => (current === undefined ? undefined : current === id);
  const items = [{ label: "Без контейнера", colorCode: "", checked: mark(DEFAULT_STORE), action: () => pick(DEFAULT_STORE) }];
  for (const c of state.containers.values()) {
    items.push({ label: c.name, colorCode: c.colorCode, checked: mark(c.cookieStoreId), action: () => pick(c.cookieStoreId) });
  }
  return items;
}

function canUseContainers() {
  return hasContainers && !state.incognito && state.containers.size > 0;
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

// Яркость цвета 0–255 (null — не разобрать).
function luminance(color) {
  colorProbe ??= document.createElement("canvas").getContext("2d");
  colorProbe.fillStyle = "#fff";
  colorProbe.fillStyle = color;
  const m = colorProbe.fillStyle.match(/[\da-f]{2}/gi);
  if (!m || colorProbe.fillStyle[0] !== "#") return null;
  const [r, g, b] = m.map((h) => parseInt(h, 16));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

// Тёмный ли цвет: нужно для color-scheme (полоса прокрутки, поле ввода).
function isDark(color) {
  const lum = luminance(color);
  return lum === null ? null : lum < 128;
}

// Своя тема из настроек (фон, текст, акцент) — поверх темы Firefox.
const OWN_COLOR_VARS = { bg: "--bg", fg: "--fg", accent: "--accent" };
let lastTheme = null;

function applyTheme(theme) {
  lastTheme = theme;
  const colors = (theme && theme.colors) || {};
  const own = (state.settings && state.settings.colors) || {};
  const style = document.documentElement.style;
  for (const [prop, keys] of Object.entries(THEME_VARS)) {
    const value = themeColor(colors, keys);
    if (value) style.setProperty(prop, value);
    else style.removeProperty(prop);
  }
  // Свой фон или текст: линии и меню выводятся из них (цвета темы Firefox
  // для меню и линий к чужому фону не подходят).
  if (own.bg || own.fg) for (const prop of ["--border", "--menu-bg", "--menu-fg"]) style.removeProperty(prop);
  for (const [key, prop] of Object.entries(OWN_COLOR_VARS)) if (own[key]) style.setProperty(prop, own[key]);
  const bg = style.getPropertyValue("--bg");
  const dark = bg ? isDark(bg) : null;
  if (dark === null) style.removeProperty("color-scheme");
  else style.setProperty("color-scheme", dark ? "dark" : "light");
  // Цвет значков на кнопке акцентного цвета (пауза в плеере и т.п.):
  // белый почти всегда — тёмный только на очень светлом акценте.
  const accent = style.getPropertyValue("--accent");
  const lum = accent ? luminance(accent) : null;
  if (lum === null) style.removeProperty("--on-accent");
  else style.setProperty("--on-accent", lum > 200 ? "#111" : "#fff");
  // Новые цвета — разом, без переходов вразнобой.
  const root = document.documentElement;
  root.classList.add("theme-switching");
  requestAnimationFrame(() => requestAnimationFrame(() => root.classList.remove("theme-switching")));
}

function listenTheme() {
  // Свои цвета — сразу, не дожидаясь темы Firefox.
  applyTheme(null);
  if (!browser.theme) return;
  run(browser.theme.getCurrent(state.windowId).then(applyTheme));
  browser.theme.onUpdated.addListener(({ windowId }) => {
    // Событие без windowId — тема сменилась глобально; с чужим окном — не наша.
    if (windowId !== undefined && !ours(windowId)) return;
    run(browser.theme.getCurrent(state.windowId).then(applyTheme));
  });
}
