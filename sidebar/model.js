"use strict";

/*
 * Чистая логика боковой панели — без DOM и без browser.*, чтобы её можно было
 * покрыть юнит-тестами в node. sidebar.js только исполняет то, что решено здесь.
 *
 * Группы — нативные группы Firefox (tabs.group / tabGroups). Своих групп нет
 * намеренно: так панель и встроенная полоса вкладок всегда показывают одно и
 * то же, а сохранение/восстановление групп уже умеет background.js.
 */

const NO_GROUP = -1;

// Цвета групп — из shared/settings.js (подключается раньше этого файла).
const GROUP_COLORS = (typeof module !== "undefined" && module.exports ? require("../shared/settings.js") : SidebarSettings)
  .GROUP_COLORS;

function isGrouped(tab) {
  return tab.groupId !== undefined && tab.groupId !== NO_GROUP;
}

// Превращает вкладки окна в то, что рисует панель:
//   pinned — закреплённые вкладки (компактная сетка иконок сверху, групп у них не бывает);
//   rows   — плоский список строк: заголовок группы, затем её вкладки.
// Вкладки одной группы в Firefox всегда идут подряд, поэтому заголовок
// вставляется при смене groupId. Свёрнутая группа прячет свои вкладки, кроме
// активной — так же ведёт себя встроенная полоса вкладок.
function buildLayout(tabs, groupsById) {
  const sorted = tabs.filter((t) => !t.hidden).sort((a, b) => a.index - b.index);
  const pinned = [];
  const rows = [];
  let currentHeader = null;

  for (const tab of sorted) {
    if (tab.pinned) {
      pinned.push(tab);
      continue;
    }

    if (!isGrouped(tab)) {
      currentHeader = null;
      rows.push({ kind: "tab", tab, groupId: NO_GROUP });
      continue;
    }

    if (!currentHeader || currentHeader.group.id !== tab.groupId) {
      // Метаданные группы могут ещё не прийти (гонка событий tabs/tabGroups) —
      // рисуем группу с нейтральными значениями, следующий resync их обновит.
      const group = groupsById.get(tab.groupId) || { id: tab.groupId, title: "", color: "grey", collapsed: false };
      currentHeader = { kind: "group", group, count: 0 };
      rows.push(currentHeader);
    }
    currentHeader.count++;

    if (!currentHeader.group.collapsed || tab.active) {
      rows.push({ kind: "tab", tab, groupId: tab.groupId });
    }
  }

  return { pinned, rows };
}

// Иконка для строки: своя, если вкладка её знает, иначе — запомненная
// иконка сайта (кэш ведёт background.js). Так незагруженные (discarded)
// вкладки показывают иконку, не загружаясь.
function iconFor(tab, cache) {
  if (tab.favIconUrl) return tab.favIconUrl;
  if (!cache || cache.size === 0 || !tab.url) return "";
  try {
    const u = new URL(tab.url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return "";
    return cache.get(u.hostname) || "";
  } catch (e) {
    return "";
  }
}

// Решает, что означает бросок перетаскиваемых вкладок. Порядок в панели и
// принадлежность группе задаются одним жестом:
//   before/after вкладки  — встать рядом и принять её группу (или выйти из группы);
//   onto вкладки          — объединиться с ней в группу (новую или её существующую);
//   onto заголовка группы — вступить в эту группу;
//   end (пустое место)    — выйти из групп и уйти в конец окна.
// Возвращает намерение { group, anchor } или null, если бросок бессмысленный.
// Индекс для tabs.move здесь не считается: групповые операции сами двигают
// вкладки, поэтому индекс вычисляется уже после них по свежему состоянию
// (см. computeMoveIndex).
function planDrop(draggedIds, target, tabsById) {
  const dragged = draggedIds.filter((id) => !(target.tabId !== undefined && id === target.tabId && target.zone === "onto"));
  if (dragged.length === 0) return null;

  const draggedTabs = dragged.map((id) => tabsById.get(id)).filter(Boolean);
  const anyPinned = draggedTabs.some((t) => t.pinned);
  const allPinned = draggedTabs.length > 0 && draggedTabs.every((t) => t.pinned);

  if (target.kind === "end") {
    if (anyPinned) return null;
    return { ids: dragged, group: { type: "ungroup" }, anchor: { end: true } };
  }

  if (target.kind === "group") {
    if (anyPinned) return null;
    // Верхний край заголовка — место МЕЖДУ группами: без него нельзя было бы
    // поставить вкладку вне групп между двумя соседними группами.
    if (target.zone === "before") {
      const first = groupMembers(tabsById, target.groupId)[0];
      if (!first || dragged.includes(first.id)) return null;
      return { ids: dragged, group: { type: "ungroup" }, anchor: { tabId: first.id, side: "before" } };
    }
    return { ids: dragged, group: { type: "join", groupId: target.groupId }, anchor: null };
  }

  const targetTab = tabsById.get(target.tabId);
  if (!targetTab) return null;

  // Закреплённые и обычные вкладки живут в разных зонах: Firefox не даёт
  // перемешать их через tabs.move, поэтому такие броски просто игнорируются.
  if (targetTab.pinned) {
    if (!allPinned || target.zone === "onto") return null;
    if (dragged.includes(targetTab.id)) return null;
    return { ids: dragged, group: null, anchor: { tabId: targetTab.id, side: target.zone } };
  }
  if (anyPinned) return null;

  if (target.zone === "onto") {
    const group = isGrouped(targetTab)
      ? { type: "join", groupId: targetTab.groupId }
      : { type: "new", withTabId: targetTab.id };
    return { ids: dragged, group, anchor: { tabId: targetTab.id, side: "after" } };
  }

  if (dragged.includes(targetTab.id)) return null;

  const group = isGrouped(targetTab) ? { type: "join", groupId: targetTab.groupId } : { type: "ungroup" };
  return { ids: dragged, group, anchor: { tabId: targetTab.id, side: target.zone } };
}

function groupMembers(tabsById, groupId) {
  const members = [];
  for (const t of tabsById.values()) if (t.groupId === groupId) members.push(t);
  return members.sort((a, b) => a.index - b.index);
}

// Перенос группы целиком. Группа не может встать внутрь другой группы,
// поэтому любая цель внутри чужой группы "притягивается" к её краю:
// верхняя половина — перед этой группой, нижняя — после неё.
// Возвращает { groupId, memberIds, anchor } или null.
function planGroupDrop(groupId, target, tabsById) {
  const memberIds = groupMembers(tabsById, groupId).map((t) => t.id);

  if (target.kind === "end") return { groupId, memberIds, anchor: { end: true } };

  let otherGroupId;
  let side = target.zone === "after" ? "after" : "before";

  if (target.kind === "group") {
    otherGroupId = target.groupId;
  } else {
    const t = tabsById.get(target.tabId);
    if (!t || t.pinned) return null;
    if (!isGrouped(t)) {
      if (t.groupId === groupId) return null;
      return { groupId, memberIds, anchor: { tabId: t.id, side } };
    }
    otherGroupId = t.groupId;
  }

  if (otherGroupId === groupId) return null;
  const other = groupMembers(tabsById, otherGroupId);
  if (other.length === 0) return null;
  const edge = side === "before" ? other[0] : other[other.length - 1];
  return { groupId, memberIds, anchor: { tabId: edge.id, side } };
}

// Итоговый index для tabs.move(ids, {index}) по свежему списку вкладок окна.
// tabs.move трактует index как позицию ПОСЛЕ изъятия перемещаемых вкладок,
// поэтому из точки вставки вычитаются перемещаемые вкладки, стоящие перед ней.
// null — двигать не нужно (якоря нет или он сам среди перемещаемых).
function computeMoveIndex(tabs, ids, anchor) {
  if (!anchor) return null;
  if (anchor.end) return -1;

  const anchorTab = tabs.find((t) => t.id === anchor.tabId);
  if (!anchorTab || ids.includes(anchorTab.id)) return null;

  const insertAt = anchorTab.index + (anchor.side === "after" ? 1 : 0);
  const idSet = new Set(ids);
  const movedBefore = tabs.filter((t) => idSet.has(t.id) && t.index < insertAt).length;
  return insertAt - movedBefore;
}

// Диапазон для Shift+клика: все вкладки между двумя (включительно) в порядке
// отображения. Порядок строк берётся из уже построенного layout, чтобы
// вкладки свёрнутых групп в диапазон не попадали.
function rangeBetween(orderedIds, fromId, toId) {
  const a = orderedIds.indexOf(fromId);
  const b = orderedIds.indexOf(toId);
  if (a === -1 || b === -1) return b === -1 ? [] : [toId];
  const [lo, hi] = a <= b ? [a, b] : [b, a];
  return orderedIds.slice(lo, hi + 1);
}

// Зона броска по вертикальной позиции курсора внутри строки. Для вкладки:
// верхняя/нижняя четверть — вставка до/после, середина — "на неё" (группировка).
// Для закреплённых иконок зона определяется по горизонтали и "onto" не бывает.
function dropZone(offset, size, allowOnto) {
  if (!allowOnto) return offset < size / 2 ? "before" : "after";
  if (offset < size * 0.25) return "before";
  if (offset > size * 0.75) return "after";
  return "onto";
}

// ---------------------------------------------------------------- дубликаты

const DUP_SCHEMES = ["http:", "https:", "file:", "ftp:"];

// «Та же страница»: адрес без #якоря в том же контейнере (в разных
// контейнерах — разные куки, это разные страницы). Служебные страницы
// (новая вкладка, about:) дубликатами не считаются.
function dupKey(tab) {
  if (!tab || !tab.url) return null;
  let u;
  try {
    u = new URL(tab.url);
  } catch (e) {
    return null;
  }
  if (!DUP_SCHEMES.includes(u.protocol)) return null;
  u.hash = "";
  return (tab.cookieStoreId || "") + " " + u.href;
}

// key → вкладки одной страницы (по порядку в окне), только где их больше одной.
function duplicateSets(tabs) {
  const byKey = new Map();
  for (const t of tabs) {
    if (t.hidden) continue;
    const key = dupKey(t);
    if (key === null) continue;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(t);
  }
  for (const [key, list] of byKey) {
    if (list.length < 2) byKey.delete(key);
    else list.sort((a, b) => a.index - b.index);
  }
  return byKey;
}

// Какую из одинаковых вкладок оставить: закреплённую, затем активную,
// затем загруженную, затем первую по порядку.
function keeperOf(list) {
  const rank = (t) => (t.pinned ? 0 : t.active ? 1 : !t.discarded ? 2 : 3);
  return list.reduce((best, t) => (rank(t) < rank(best) || (rank(t) === rank(best) && t.index < best.index) ? t : best));
}

// Что закрыть, чтобы от каждой страницы осталась одна вкладка. Закреплённые
// не закрываются никогда, даже если их копий несколько. sets — уже
// посчитанный duplicateSets(tabs), чтобы панель не считала его дважды.
function duplicatesToClose(tabs, sets = duplicateSets(tabs)) {
  const ids = [];
  for (const list of sets.values()) {
    const keep = keeperOf(list);
    for (const t of list) if (t !== keep && !t.pinned) ids.push(t.id);
  }
  return ids;
}

// Остальные вкладки той же страницы, что и tab (её саму и закреплённые оставляем).
function duplicatesOf(tab, tabs) {
  const key = dupKey(tab);
  if (key === null) return [];
  return tabs.filter((t) => t.id !== tab.id && !t.hidden && !t.pinned && dupKey(t) === key).map((t) => t.id);
}

// ---------------------------------------------------------------- контейнеры

const DEFAULT_STORE = "firefox-default";

// Контейнер вкладки (из contextualIdentities) или null — обычная вкладка.
function containerOf(tab, containers) {
  const id = tab && tab.cookieStoreId;
  if (!id || id === DEFAULT_STORE || !containers) return null;
  return containers.get(id) || null;
}

// Сменить контейнер у открытой вкладки нельзя — её переоткрывают в нужном.
// Что передать в tabs.create: { url } для обычной страницы, {} для новой
// вкладки, null — так нельзя (about:, file:, страницы расширений
// tabs.create не открывает).
function reopenProps(tab) {
  const url = tab && tab.url;
  if (!url || url === "about:newtab" || url === "about:blank" || url === "about:home") return {};
  return /^(https?|ftp):/i.test(url) ? { url } : null;
}

// ---------------------------------------------------------------- недавно закрытые

// sessions.getRecentlyClosed() → строки блока: вкладки, закрытые в этом окне,
// и закрытые окна целиком — по времени закрытия, свежие сверху.
function closedRows(sessions, windowId, limit) {
  const rows = [];
  for (const s of sessions || []) {
    const at = closedAt(s.lastModified);
    if (s.tab && s.tab.sessionId) {
      if (s.tab.windowId !== undefined && s.tab.windowId !== windowId) continue;
      const t = s.tab;
      rows.push({ kind: "tab", sessionId: t.sessionId, title: t.title || t.url || "", url: t.url || "", favIconUrl: t.favIconUrl || "", closedAt: at });
    } else if (s.window && s.window.sessionId) {
      const tabs = s.window.tabs || [];
      const active = tabs.find((t) => t.active) || tabs[0];
      rows.push({
        kind: "window",
        sessionId: s.window.sessionId,
        title: active ? active.title || active.url || "" : "",
        count: tabs.length,
        favIconUrl: (active && active.favIconUrl) || "",
        url: (active && active.url) || "",
        closedAt: at,
      });
    }
  }
  rows.sort((a, b) => b.closedAt - a.closedAt);
  return rows.slice(0, limit);
}

// Firefox отдаёт миллисекунды, Chrome — секунды; на всякий случай понимаем оба.
function closedAt(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return n < 1e12 ? n * 1000 : n;
}

// «Сколько назад» коротко: «сейчас», «5 мин», «3 ч», «2 дн».
function timeAgo(at, now) {
  if (!at) return "";
  const min = Math.floor((now - at) / 60000);
  if (min < 1) return "сейчас";
  if (min < 60) return min + " мин";
  const h = Math.floor(min / 60);
  if (h < 24) return h + " ч";
  return Math.floor(h / 24) + " дн";
}

// ---------------------------------------------------------------- плеер

// Строки плеера: по одной на вкладку (из нескольких звучащих фреймов
// вкладки — играющий, иначе игравший последним). Порядок — как пришёл из
// фона: там он постоянный и меняется только перетаскиванием.
function mediaRows(sessions) {
  const byTab = new Map();
  for (const s of sessions || []) {
    const best = byTab.get(s.tabId);
    if (!best || better(s, best)) byTab.set(s.tabId, s);
  }
  return [...byTab.values()];
}

function better(a, b) {
  if (a.playing !== b.playing) return a.playing;
  return a.playedAt > b.playedAt;
}

// Позиция трека сейчас: страница присылает её не постоянно, а при событиях,
// между ними панель досчитывает сама по скорости воспроизведения.
function mediaPosition(position, playing, now) {
  if (!position || !(position.duration > 0)) return null;
  const elapsed = playing ? ((now - position.at) / 1000) * (position.rate || 1) : 0;
  return Math.min(position.duration, Math.max(0, position.position + elapsed));
}

function formatTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const total = Math.floor(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

// Скорость воспроизведения: колесо и клавиши шагают по сетке RATE_STEP
// в пределах RATE_MIN…RATE_MAX; меню предлагает RATE_PRESETS.
const RATE_MIN = 0.25;
const RATE_MAX = 4;
const RATE_STEP = 0.25;
const RATE_PRESETS = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3];

// Следующая скорость в сторону dir (+1/-1). С «нестандартной» скорости
// (сайт поставил 1,1) первый шаг приводит на ближайшую точку сетки. Шаг
// зажат в RATE_MIN…RATE_MAX, но не идёт против dir: с 8× «быстрее» остаётся
// 8× (а не 4×), «медленнее» — сразу 4×.
function stepRate(rate, dir) {
  const r = Number.isFinite(rate) && rate > 0 ? rate : 1;
  const grid = r / RATE_STEP;
  const next = (dir > 0 ? Math.floor(grid + 1e-9) + 1 : Math.ceil(grid - 1e-9) - 1) * RATE_STEP;
  const clamped = Math.min(RATE_MAX, Math.max(RATE_MIN, next));
  return dir > 0 ? Math.max(r, clamped) : Math.min(r, clamped);
}

// 1 → «1×», 1.25 → «1,25×».
function formatRate(rate) {
  const r = Number.isFinite(rate) && rate > 0 ? rate : 1;
  return String(Math.round(r * 100) / 100).replace(".", ",") + "×";
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    NO_GROUP,
    GROUP_COLORS,
    isGrouped,
    buildLayout,
    iconFor,
    planDrop,
    planGroupDrop,
    groupMembers,
    computeMoveIndex,
    rangeBetween,
    dropZone,
    dupKey,
    duplicateSets,
    duplicatesToClose,
    duplicatesOf,
    DEFAULT_STORE,
    containerOf,
    reopenProps,
    closedRows,
    timeAgo,
    mediaRows,
    mediaPosition,
    formatTime,
    RATE_MIN,
    RATE_MAX,
    RATE_PRESETS,
    stepRate,
    formatRate,
  };
}
