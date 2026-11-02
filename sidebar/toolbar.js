"use strict";

/*
 * Полоса сверху (сводка и быстрые действия), плагины и блок «Недавно
 * закрытые».
 * Общие состояние и функции — в sidebar.js (обычные скрипты делят одну
 * глобальную область, порядок подключения — в sidebar.html).
 */

// ---------------------------------------------------------------- панель сверху
//
// Сводка (сколько вкладок и сколько из них в памяти), настройки, плагины и
// массовые кнопки: закрыть дубликаты (видна, только когда они есть),
// выгрузить из памяти все вкладки окна и закрыть все вкладки вне групп.
// Выгрузка безопасна и срабатывает сразу; закрытие — со вторым нажатием:
// кнопка краснеет и ждёт 3 секунды. Подписей у кнопок нет — только значок,
// счётчик и подсказка.

const CONFIRM_MS = 3000;
const $tbDiscard = document.getElementById("tb-discard");
const $tbClose = document.getElementById("tb-close-loose");
const $tbSettings = document.getElementById("tb-settings");
const $tbTotal = document.getElementById("tb-total");
const $tbLoaded = document.getElementById("tb-loaded");
const $tbDups = document.getElementById("tb-dups");
const $newTabBtn = document.getElementById("new-tab");
let closeConfirmTimer = 0;

// Что можно выгрузить: не активная (её Firefox не выгружает), не уже
// выгруженная и не звучащая — музыку молча не обрываем.
function isDiscardable(t) {
  return !t.active && !t.discarded && !t.audible;
}

function discardableIds(tabs) {
  return tabs.filter(isDiscardable).map((t) => t.id);
}

function isLoose(t) {
  return !t.pinned && !isGrouped(t);
}

function looseTabIds() {
  return [...state.tabs.values()].filter(isLoose).map((t) => t.id);
}

// Атрибут/текст — только если изменился (тулбар обновляется на каждую
// перерисовку).
function setTitle(el, text) {
  if (el.title !== text) el.title = text;
}

function setText(el, text) {
  if (el.textContent !== text) el.textContent = text;
}

function renderToolbar() {
  // Один проход по вкладкам на все счётчики.
  let loaded = 0;
  let discard = 0;
  let loose = 0;
  for (const t of state.tabs.values()) {
    if (!t.discarded) loaded++;
    if (isDiscardable(t)) discard++;
    if (isLoose(t)) loose++;
  }
  setText($tbTotal, pluralTabs(state.tabs.size));
  setText($tbLoaded, `${loaded} в памяти`);

  // Делать нечего — кнопки нет, как у дубликатов.
  $tbDiscard.hidden = discard === 0;
  setCount($tbDiscard, discard);
  setTitle($tbDiscard, discard ? `Выгрузить из памяти все вкладки (${discard}). Активная и звучащие остаются.` : "Выгружать нечего");

  const dups = state.settings.duplicates ? state.dupsToClose.length : 0;
  $tbDups.hidden = dups === 0;
  setCount($tbDups, dups);
  setTitle($tbDups, withHint(`Закрыть дубликаты (${dups}): от каждой страницы останется одна вкладка`, "close-duplicates"));
  setTitle($newTabBtn, withHint("Новая вкладка (или двойной клик по пустому месту)", "ff-new-tab"));

  $tbClose.hidden = loose === 0;
  if (!loose && $tbClose.classList.contains("confirm")) resetCloseConfirm();
  setCount($tbClose, loose);
  if (!$tbClose.classList.contains("confirm")) {
    setTitle($tbClose, loose ? `Закрыть все вкладки вне групп (${loose})` : "Вкладок вне групп нет");
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
}

function onToolbarClick(e) {
  const btn = e.target.closest("button");
  if (!btn || btn.disabled) return;
  if (btn === $tbSettings) {
    run(browser.runtime.openOptionsPage());
  } else if (btn === $tbDups) {
    run(browser.tabs.remove(duplicatesToClose([...state.tabs.values()])));
  } else if (btn === $tbDiscard) {
    run(browser.tabs.discard(discardableIds([...state.tabs.values()])));
  } else if (btn === $tbClose) {
    if (!btn.classList.contains("confirm")) {
      btn.classList.add("confirm");
      btn.title = "Нажмите ещё раз, чтобы закрыть";
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

// ---------------------------------------------------------------- плагины
//
// Плагины включаются на странице настроек (блок «Плагины»); панель
// перечитывает список, когда он меняется в storage.

const PLUGINS_KEY = "pluginsEnabled";

async function loadPlugins() {
  const list = await browser.runtime.sendMessage({ type: "getPlugins" });
  state.plugins = Array.isArray(list) ? list : [];
  scheduleRender();
}

function pluginButton(key) {
  for (const p of state.plugins) {
    if (!p.enabled) continue;
    const b = p.buttons.find((x) => x.key === key);
    if (b) return b;
  }
  return null;
}

// ---------------------------------------------------------------- недавно закрытые
//
// Блок над плеером: заголовок со счётчиком (клик — свернуть/развернуть,
// запоминается) и список вкладок, закрытых в этом окне, и закрытых окон.
// Клик — вернуть (Firefox восстановит её с историей), средняя кнопка или
// крестик — забыть, корзина в заголовке — забыть всё. Список ведёт сам
// Firefox (sessions), панель его только показывает.

const CLOSED_FETCH = 25;
const CLOSED_TICK_MS = 60000;
const $closed = document.getElementById("closed");
const $closedHead = document.getElementById("closed-head");
const $closedList = document.getElementById("closed-list");
const $closedCount = document.getElementById("closed-count");
const hasSessions = !!(browser.sessions && browser.sessions.getRecentlyClosed);
let closedRowsShown = [];
let closedTimer = 0;
let closedTick = 0;
// Идёт «Очистить список»: каждое forget* — событие sessions.onChanged,
// перечитываем один раз в конце.
let closedClearing = false;

async function loadClosed() {
  state.closed = await browser.sessions.getRecentlyClosed({ maxResults: CLOSED_FETCH });
  renderClosed();
}

function listenClosed() {
  if (!hasSessions) return;
  run(loadClosed());
  // Закрытие пачки вкладок — пачка событий: перечитываем один раз.
  browser.sessions.onChanged.addListener(() => {
    if (closedClearing) return;
    clearTimeout(closedTimer);
    closedTimer = setTimeout(() => run(loadClosed()), 50);
  });
}

function renderClosed() {
  const s = state.settings;
  const rows = hasSessions && s.closedShown ? closedRows(state.closed, state.windowId, s.closedCount) : [];
  closedRowsShown = rows;
  $closed.hidden = rows.length === 0;
  $closed.classList.toggle("open", s.closedOpen);
  $closedCount.textContent = rows.length ? String(rows.length) : "";
  $closedHead.title = (s.closedOpen ? "Свернуть" : "Показать недавно закрытые") + ". " + withHint("Вернуть последнюю закрытую вкладку", "ff-reopen");

  $closedList.textContent = "";
  if (s.closedOpen) {
    const now = Date.now();
    for (const row of rows) $closedList.append(makeClosedRow(row, now));
  }

  // Подписи «5 мин» стареют — раз в минуту обновляем, пока список виден.
  const ticking = s.closedOpen && rows.length > 0;
  if (ticking && !closedTick) closedTick = setInterval(renderClosed, CLOSED_TICK_MS);
  else if (!ticking && closedTick) {
    clearInterval(closedTick);
    closedTick = 0;
  }
}

function makeClosedRow(row, now) {
  const el = document.createElement("div");
  el.className = "ctab " + row.kind;
  el.dataset.sid = row.sessionId;
  const icon = makeIcon();
  setIcon(icon, row.favIconUrl || iconFor({ url: row.url }, state.favicons));
  const title = document.createElement("span");
  title.className = "title";
  title.textContent = row.title || "Без названия";
  el.append(icon, title);
  if (row.kind === "window") {
    const count = document.createElement("span");
    count.className = "wcount";
    count.textContent = String(row.count);
    el.append(count);
    el.title = `Окно: ${pluralTabs(row.count)}. Клик — открыть снова`;
  } else {
    el.title = (row.url && row.url !== row.title ? row.title + "\n" + row.url : row.title) + "\nКлик — открыть снова";
  }
  const ago = document.createElement("span");
  ago.className = "ago";
  ago.textContent = timeAgo(row.closedAt, now);
  const forget = document.createElement("span");
  forget.className = "close";
  forget.dataset.icon = "x";
  forget.title = "Убрать из списка";
  el.append(ago, forget);
  return el;
}

function closedRowOf(node) {
  const el = elementOf(node);
  const rowEl = el && el.closest(".ctab");
  return rowEl ? closedRowsShown.find((r) => r.sessionId === rowEl.dataset.sid) || null : null;
}

function restoreClosed(row) {
  return browser.sessions.restore(row.sessionId);
}

function forgetClosed(rows) {
  return Promise.all(
    rows.map((row) =>
      row.kind === "window"
        ? browser.sessions.forgetClosedWindow(row.sessionId)
        : browser.sessions.forgetClosedTab(state.windowId, row.sessionId)
    )
  );
}

// «Очистить список» — весь список этого окна, а не только показанные строки
// (иначе сразу всплывает следующая порция). getRecentlyClosed отдаёт не
// больше CLOSED_FETCH за раз — забываем порциями, пока есть что; число
// проходов ограничено на случай, если Firefox что-то не забудет.
async function forgetAllClosed() {
  closedClearing = true;
  clearTimeout(closedTimer);
  try {
    for (let i = 0; i < 20; i++) {
      const sessions = await browser.sessions.getRecentlyClosed({ maxResults: CLOSED_FETCH });
      const rows = closedRows(sessions, state.windowId, Infinity);
      if (!rows.length) break;
      await forgetClosed(rows);
    }
  } finally {
    closedClearing = false;
    await loadClosed();
  }
}

function onClosedClick(e) {
  if (e.target.closest("#closed-clear")) {
    run(forgetAllClosed());
    return;
  }
  if ($closedHead.contains(e.target)) {
    run(saveSettings({ closedOpen: !state.settings.closedOpen }));
    renderClosed();
    return;
  }
  const row = closedRowOf(e.target);
  if (!row) return;
  if (e.target.classList.contains("close")) run(forgetClosed([row]));
  else run(restoreClosed(row));
}

function closedMenu(target) {
  const row = closedRowOf(target);
  const items = [];
  if (row) {
    items.push(
      { label: row.kind === "window" ? "Открыть окно снова" : "Открыть снова", action: () => restoreClosed(row) },
      { label: "Убрать из списка", action: () => forgetClosed([row]) },
      "-"
    );
  }
  items.push(
    { label: "Очистить список", danger: true, action: () => forgetAllClosed() },
    { label: "Скрыть блок (вернуть — в настройках)", action: () => saveSettings({ closedShown: false }).then(renderClosed) }
  );
  return items;
}
