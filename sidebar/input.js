"use strict";

/*
 * Мышь и клавиатура: щелчки по списку, перетаскивание вкладок и групп,
 * контекстное меню.
 * Общие состояние и функции — в sidebar.js (обычные скрипты делят одну
 * глобальную область, порядок подключения — в sidebar.html).
 */

// ---------------------------------------------------------------- мышь


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

  if ($closed.contains(e.target)) {
    onClosedClick(e);
    return;
  }

  if (e.target.closest(".vexp") && !e.target.closest(".pr:not(.center)")) {
    if (!e.target.classList.contains("vicon")) return;
    if (e.target.closest(".mic")) toggleMicMuted(volumeTargetOf(e.target));
    else toggleMuted(volumeTargetOf(e.target));
    return;
  }
  if ($player.contains(e.target)) {
    onPlayerClick(e);
    return;
  }

  const gid = groupIdOf(e.target);
  if (gid !== null) {
    // Сворачивается сразу, без ожидания двойного щелчка. Второй щелчок
    // двойного ничего не делает, а сам dblclick по имени возвращает
    // группу как была и включает переименование.
    if (e.target.classList.contains("gadd")) run(newTabInGroup(gid));
    else if (e.detail === 1) toggleCollapsed(gid);
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

  if (e.target.classList.contains("dup")) {
    const tab = state.tabs.get(id);
    if (tab) run(browser.tabs.remove(duplicatesOf(tab, [...state.tabs.values()])));
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
  const closedRow = closedRowOf(e.target);
  if (closedRow) {
    run(forgetClosed([closedRow]));
    return;
  }
  const id = tabIdOf(e.target);
  if (id !== null) run(browser.tabs.remove(id));
});

document.addEventListener("dblclick", (e) => {
  if (e.target.tagName === "INPUT") return;
  const gid = groupIdOf(e.target);
  if (gid !== null) {
    if (e.target.closest(".gtitle")) {
      toggleCollapsed(gid);
      startRename(gid);
    }
    return;
  }
  if (e.target === $scroll || e.target.id === "filler" || e.target === $rows) run(newTab());
});

// Колесо над значком звука, регулятором или громкостью плеера — ±5%.
// Слушатель стоит на самих значках (makeVolumeControl), а не на документе:
// непассивный слушатель документа заставлял бы прокрутку списка ждать JS.
function onVolumeWheel(e) {
  const node = elementOf(e.target);
  if (!node) return;
  let ids = null;
  const box = node.closest(".vexp");
  if (box && box.classList.contains("mic")) {
    // Микрофон — только этой вкладки, не всего выделения.
    const id = tabIdOf(box);
    if (id === null) return;
    e.preventDefault();
    changeMic([id], Math.min(1, Math.max(0, Math.round((shownMic(id) + (e.deltaY > 0 ? 0.05 : -0.05)) * 20) / 20)), false);
    return;
  }
  if (box && box.closest(".pr")) ids = box.closest(".pr:not(.center)") ? null : [volumeTargetOf(box)];
  else if (box) ids = targetsFor(tabIdOf(box));
  if (!ids || ids[0] === null) return;
  e.preventDefault();
  // Колесо на себя (вниз) — громче, от себя — тише.
  const next = Math.min(1, Math.max(0, Math.round((shownVolume(ids[0]) + (e.deltaY > 0 ? 0.05 : -0.05)) * 20) / 20));
  changeVolume(ids, next, false);
}

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

// «в 1 вкладке», «в 3 вкладках».
function inTabs(n) {
  return n % 10 === 1 && n % 100 !== 11 ? n + " вкладке" : n + " вкладках";
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
  $menu.classList.remove("compact");
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
    if (item.chips) {
      const box = document.createElement("div");
      box.className = "chips";
      for (const chip of item.chips) {
        const el = document.createElement("button");
        el.type = "button";
        el.className = chip.on ? "chip on" : "chip";
        el.textContent = chip.label;
        if (chip.title) el.title = chip.title;
        el.addEventListener("click", () => {
          closeMenu();
          run(chip.action());
        });
        box.append(el);
      }
      $menu.append(box);
      continue;
    }
    if (item.head) {
      const box = document.createElement("div");
      box.className = "mi-head";
      box.textContent = item.head;
      $menu.append(box);
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
    mi.className = item.danger ? "mi danger" : item.back ? "mi back" : "mi";
    mi.setAttribute("role", "menuitem");
    if (item.back || item.icon) {
      const icon = document.createElement("span");
      icon.className = "mi-icon";
      icon.dataset.icon = item.back ? "chevron-left" : item.icon;
      mi.append(icon);
    }
    if (item.color || item.colorCode !== undefined) {
      const dot = document.createElement("span");
      dot.className = item.colorCode === "" ? "dot none" : "dot";
      if (item.colorCode) dot.style.setProperty("--gc", item.colorCode);
      else if (item.color) setColorVar(dot, item.color);
      mi.append(dot);
    }
    if (item.checked !== undefined) {
      const check = document.createElement("span");
      check.className = "check";
      if (item.checked) check.dataset.icon = "check";
      mi.append(check);
    }
    if (item.title) mi.title = item.title;
    const label = document.createElement("span");
    label.className = "mi-label";
    label.textContent = item.label;
    mi.append(label);
    // Подменю открывается на месте этого же меню, со строкой «назад».
    if (item.submenu) {
      const more = document.createElement("span");
      more.className = "mi-more";
      more.dataset.icon = "chevron-right";
      mi.append(more);
    } else if (item.shortcut) {
      const kbd = document.createElement("span");
      kbd.className = "mi-kbd";
      kbd.textContent = item.shortcut;
      mi.append(kbd);
    }
    mi.addEventListener("click", () => {
      closeMenu();
      if (item.submenu) {
        const back = { label: item.label, back: true, action: () => openMenu(items, x, y) };
        openMenu([back, "-", ...item.submenu()], x, y);
        return;
      }
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
  items.push({
    label: (muted ? "Включить звук" : "Выключить звук") + suffix,
    shortcut: first.active && n === 1 ? keyHint("ff-mute") : "",
    action: () => setMuted(ids, !muted),
  });
  items.push({
    label: "Громкость…",
    action: () => {
      const el = els.get((first.pinned ? "p" : "t") + id);
      if (el && el.querySelector(".audio")) openVolume(el.querySelector(".audio"), true);
    },
  });
  if (n === 1 && usesMic(first)) {
    const m = micOf(id);
    items.push({
      label: m.muted ? "Включить микрофон" : "Выключить микрофон",
      shortcut: keyHint("toggle-mic"),
      action: () => setMic([id], { muted: !m.muted }),
    });
    items.push({
      label: "Громкость микрофона…",
      action: () => {
        const el = els.get((first.pinned ? "p" : "t") + id);
        if (el && el.querySelector(".mic")) openVolume(el.querySelector(".mic"), true);
      },
    });
  }
  items.push("-");
  // Сочетания Firefox действуют на активную вкладку — у неё их и показываем.
  const own = (name) => (first.active && n === 1 ? keyHint(name) : "");
  items.push(
    { label: "Перезагрузить" + suffix, shortcut: own("ff-reload"), action: () => Promise.all(ids.map((x) => browser.tabs.reload(x))) },
    { label: "Дублировать" + suffix, action: () => Promise.all(ids.map((x) => browser.tabs.duplicate(x))) },
    {
      label: (first.pinned ? "Открепить" : "Закрепить") + suffix,
      action: () => Promise.all(ids.map((x) => browser.tabs.update(x, { pinned: !first.pinned }))),
    },
    {
      label: "Выгрузить из памяти" + suffix,
      action: () => browser.tabs.discard(tabs.filter((t) => !t.active).map((t) => t.id)),
    }
  );
  if (canUseContainers() && tabs.some((t) => reopenProps(t))) {
    items.push({
      label: "Открыть в контейнере" + suffix,
      submenu: () => containerItems((store) => reopenInContainer(ids, store), n === 1 ? first.cookieStoreId || DEFAULT_STORE : undefined),
    });
  }
  const dupIds = n === 1 ? duplicatesOf(first, [...state.tabs.values()]) : [];
  items.push("-");
  if (dupIds.length) {
    items.push({ label: `Закрыть дубликаты (${dupIds.length})`, action: () => browser.tabs.remove(dupIds) });
  }
  items.push(
    {
      label: "Закрыть другие вкладки",
      action: () =>
        browser.tabs.remove([...state.tabs.values()].filter((t) => !t.pinned && !ids.includes(t.id)).map((t) => t.id)),
    },
    { label: n > 1 ? `Закрыть вкладки (${n})` : "Закрыть вкладку", danger: true, shortcut: own("ff-close"), action: () => browser.tabs.remove(ids) }
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
    ...(canUseContainers()
      ? [{ label: "Новая вкладка в группе в контейнере", submenu: () => containerItems((store) => newTabInGroup(gid, { cookieStoreId: store })) }]
      : []),
    {
      label: `Выгрузить из памяти (${discardableIds(tabsOfGroup(gid)).length})`,
      action: () => browser.tabs.discard(discardableIds(tabsOfGroup(gid))),
    },
    "-",
    { label: "Разгруппировать", action: () => browser.tabs.ungroup(ids()) },
    { label: "Закрыть группу", danger: true, action: () => browser.tabs.remove(ids()) },
  ];
}

function newTabMenu() {
  const items = [{ label: "Новая вкладка", shortcut: keyHint("ff-new-tab"), action: () => newTab() }];
  if (canUseContainers()) {
    items.push({ label: "Новая вкладка в контейнере", submenu: () => containerItems((store) => newTab({ cookieStoreId: store })) });
  }
  return items;
}

document.addEventListener("contextmenu", (e) => {
  if (e.target.tagName === "INPUT") return;
  e.preventDefault();
  if ($player.contains(e.target) || e.target.closest("#toolbar")) return;
  if ($closed.contains(e.target)) {
    const items = closedMenu(e.target);
    if (items.length) openMenu(items, e.clientX, e.clientY);
    return;
  }
  const gid = groupIdOf(e.target);
  const id = tabIdOf(e.target);
  const items = gid !== null ? groupMenu(gid) : id !== null ? tabMenu(id) : newTabMenu();
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
    // На каждый шаг прокрутки — только если правда есть что закрывать.
    if (!$menu.hidden) closeMenu();
    if (volOpen || volTimer) closeVolume();
  },
  { passive: true }
);
