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

const GROUP_COLORS = ["grey", "blue", "purple", "cyan", "green", "yellow", "orange", "red", "pink"];

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

if (typeof module !== "undefined" && module.exports) {
  module.exports = { NO_GROUP, GROUP_COLORS, isGrouped, buildLayout, iconFor, planDrop, planGroupDrop, groupMembers, computeMoveIndex, rangeBetween, dropZone, mediaRows, mediaPosition, formatTime };
}
