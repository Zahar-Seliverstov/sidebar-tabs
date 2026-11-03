"use strict";

/*
 * Список вкладок: отрисовка строк (закреплённые, группы, вкладки) с
 * переиспользованием DOM по ключу, плавные перестановки (FLIP) и действия
 * над вкладками и группами.
 * Общие состояние и функции — в sidebar.js (обычные скрипты делят одну
 * глобальную область, порядок подключения — в sidebar.html).
 */

// ---------------------------------------------------------------- отрисовка

let renderQueued = false;

// Без аргумента — полная перерисовка в следующем кадре. С ids — лёгкая:
// только строки этих вкладок и счётчики сверху (косметика: заголовок,
// значок, звук, активная). Полная поглощает лёгкие.
let fullRender = false;
const dirtyTabs = new Set();

function scheduleRender(ids) {
  if (ids) for (const id of ids) dirtyTabs.add(id);
  else fullRender = true;
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    const full = fullRender;
    fullRender = false;
    const dirty = [...dirtyTabs];
    dirtyTabs.clear();
    if (full) render();
    else renderTabs(dirty);
  });
}

function renderTabs(ids) {
  let inPlayer = false;
  for (const id of ids) {
    // Плеер показывает вкладки и других окон — проверяем до списка окна.
    if (!inPlayer && playerRows.some((r) => r.tabId === id)) inPlayer = true;
    const tab = state.tabs.get(id);
    if (!tab) continue;
    const pin = els.get("p" + id);
    if (pin && tab.pinned) updatePin(pin, tab);
    const el = els.get("t" + id);
    if (el && el._row) {
      el._row.tab = tab;
      updateTab(el, el._row);
    }
  }
  scrollToActive();
  renderToolbar();
  if (inPlayer) renderPlayer();
}

// Новая активная вкладка — в зону видимости.
function scrollToActive() {
  let active = null;
  for (const t of state.tabs.values()) if (t.active) active = t;
  if (!active || active.id === state.lastActiveId) return;
  state.lastActiveId = active.id;
  const el = els.get((active.pinned ? "p" : "t") + active.id);
  if (el) el.scrollIntoView({ block: "nearest" });
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
// где она теперь, и пружиной везём её из старого места в новое (Web
// Animations с кривой пружины — на потоке композитора, без JS в кадре).
// Новые строки проявляются, ушедшие гаснут на своём месте, пока соседи
// съезжаются. Только при изменении состава или порядка строк: обычные
// обновления (заголовок, иконка, звук) ничего не измеряют.

const FLIP_SPRING = SidebarSpring.springEasing({ stiffness: 520, damping: 42, mass: 1 });
const FLIP_FADE = { duration: 180, easing: "cubic-bezier(0.2, 0.8, 0.2, 1)" };
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
    // Где строка видна сейчас (с хвостом прежней анимации), потом —
    // анимацию прочь: дальше считаем от положения «как в раскладке».
    before.set(el, el.getBoundingClientRect());
  }
  for (const el of before.keys()) {
    if (el._flip) el._flip.cancel();
    el._flip = null;
  }
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
      el.animate({ opacity: [1, 0], transform: ["none", "scale(0.97)"] }, FLIP_FADE).finished.then(
        () => el.remove(),
        () => el.remove()
      );
    },
  };
}

function finishFlip(flip) {
  if (!flip) return;
  const { view, before } = flip;
  // Сначала все замеры, потом все анимации: чтение и запись вперемешку
  // заставляли бы браузер пересчитывать раскладку на каждой строке.
  const moved = [];
  for (const el of flip.container.children) {
    if (el.dataset.key) moved.push([el, el.getBoundingClientRect()]);
  }
  for (const [el, r] of moved) {
    const was = before.get(el);
    const visible = r.bottom >= view.top && r.top <= view.bottom;
    // Web Animations применяет первый кадр сразу, в этом же кадре, —
    // строка не мелькает на новом месте.
    if (!was) {
      if (visible) el._flip = el.animate({ opacity: [0, 1], transform: ["translateY(-6px)", "none"] }, FLIP_FADE);
      continue;
    }
    const dx = was.left - r.left;
    const dy = was.top - r.top;
    if ((dx || dy) && (visible || (was.bottom >= view.top && was.top <= view.bottom))) {
      el._flip = el.animate({ transform: [`translate(${dx}px, ${dy}px)`, "none"] }, FLIP_SPRING);
    }
  }
}

function render() {
  const all = [...state.tabs.values()];
  const { pinned, rows } = buildLayout(all, state.groups);

  state.dups = new Map();
  state.dupsToClose = [];
  if (state.settings.duplicates) {
    const sets = duplicateSets(all);
    for (const list of sets.values()) for (const t of list) state.dups.set(t.id, list.length - 1);
    state.dupsToClose = duplicatesToClose(all, sets);
  }

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
  scrollToActive();

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
  let tip = tab.url && tab.url !== title ? title + "\n" + tab.url : title;
  const c = shownContainer(tab);
  if (c) tip += `\nКонтейнер «${c.name}»`;
  return tip;
}

// Полоска контейнера: класс ctx и цвет --cc.
function paintContainer(el, tab) {
  const c = shownContainer(tab);
  if (setIfChanged(el, "cc", c ? c.colorCode : "")) {
    el.classList.toggle("ctx", !!c);
    if (c) el.style.setProperty("--cc", c.colorCode);
    else el.style.removeProperty("--cc");
  }
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
  // className перезаписывает классы — полоску контейнера красим заново.
  if (setIfChanged(el, "cls", tabClasses("pin", tab))) {
    el.className = el._v.cls;
    el._v.cc = undefined;
  }
  if (setIfChanged(el, "tip", tooltip(tab))) el.title = el._v.tip;
  setIcon(el.firstChild, iconFor(tab, state.favicons));
  paintContainer(el, tab);
}

// Подпись кнопки действия: видна при наведении на строку. Для мыши
// прозрачна — щелчок по ней засчитывается самой кнопке.
function actionLabel(text) {
  const el = document.createElement("span");
  el.className = "lbl";
  el.textContent = text;
  return el;
}

function makeTab(key) {
  const el = document.createElement("div");
  el.dataset.key = key;
  el.dataset.id = key.slice(1);
  el.draggable = true;
  el._v = {};

  const title = document.createElement("span");
  title.className = "title";
  const dup = document.createElement("span");
  dup.className = "dup";
  dup.dataset.icon = "copy";
  dup.append(actionLabel("Копии"));
  const mic = makeVolumeControl("mic vexp");
  const audio = makeVolumeControl("audio vexp");
  const close = document.createElement("span");
  close.className = "close";
  close.title = "Закрыть вкладку";
  close.dataset.icon = "x";

  el.append(makeIcon(), title, dup, mic, audio, close);
  return el;
}

function updateTab(el, row) {
  el._row = row;
  const tab = row.tab;
  const inGroup = row.groupId !== NO_GROUP;

  const dups = state.dups.get(tab.id) || 0;
  let cls = tabClasses(inGroup ? "tab in-group" : "tab", tab);
  if (dups) cls += " has-dup";
  if (setIfChanged(el, "cls", cls)) {
    el.className = el._v.cls;
    el._v.cc = undefined;
  }
  if (setIfChanged(el, "title", tab.title || tab.url || "")) el.children[1].textContent = el._v.title;
  if (setIfChanged(el, "tip", tooltip(tab))) el.title = el._v.tip;
  setIcon(el.firstChild, iconFor(tab, state.favicons));
  paintContainer(el, tab);

  // Дубликат: значок с подсказкой, клик закрывает остальные копии страницы.
  const dupTip = dups
    ? `Эта страница открыта ещё в ${inTabs(dups)}. Клик — закрыть их, оставить эту`
    : "";
  if (setIfChanged(el, "dupTip", dupTip)) el.children[2].title = dupTip;

  // Значок микрофона — пока вкладка его пишет (это знает сам Firefox).
  const micEl = el.children[3];
  const micShown = usesMic(tab);
  if (setIfChanged(el, "micShown", micShown)) micEl.classList.toggle("shown", micShown);
  if (micShown || micEl.dataset.open !== undefined) updateMicControl(micEl, tab.id);

  // Значок звука показывается, когда вкладка звучит, выключена, у неё
  // изменена громкость (или регулятор открыт из меню) — и всё время звонка:
  // в тихом звонке вкладка не «звучит», а громкость собеседника нужна сразу.
  const audioEl = el.children[4];
  const shown = !!tab.audible || isMuted(tab) || state.volumes.has(tab.id) || micShown;
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
  const add = document.createElement("span");
  add.className = "gadd";
  add.title = "Новая вкладка в группе";
  add.dataset.icon = "plus";

  el.append(chev, title, count, add);
  // Ссылки, а не children[i]: поле переименования встаёт перед названием.
  el._title = title;
  el._count = count;
  return el;
}

function updateGroup(el, row) {
  const g = row.group;
  if (setIfChanged(el, "cls", g.collapsed ? "group collapsed" : "group")) el.className = el._v.cls;
  if (setIfChanged(el, "title", g.title || "")) el._title.textContent = el._v.title;
  if (setIfChanged(el, "count", String(row.count))) el._count.textContent = el._v.count;
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

// Выделение меняет только классы строк — перерисовываем лишь те, что
// вошли в него или вышли.
function setSelection(ids) {
  const next = new Set(ids);
  const changed = [];
  for (const id of state.selected) if (!next.has(id)) changed.push(id);
  for (const id of next) if (!state.selected.has(id)) changed.push(id);
  state.selected = next;
  if (changed.length) scheduleRender(changed);
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
  // Ползунок шлёт это на каждое движение — перерисовываем только эти строки.
  scheduleRender(ids);
  for (const id of ids) {
    browser.runtime.sendMessage({ type: "setVolume", tabId: id, volume }).then((applied) => {
      const had = state.volumeBlocked.has(id);
      if (applied) state.volumeBlocked.delete(id);
      else state.volumeBlocked.add(id);
      if (had !== !applied) scheduleRender();
    }, report);
  }
}

// Микрофон — так же: применяет фон (и content/mic.js), здесь — отображение.
function setMic(ids, change) {
  for (const id of ids) {
    const next = { ...micOf(id), ...change };
    if (next.volume >= 1 && !next.muted) state.mic.delete(id);
    else state.mic.set(id, next);
  }
  scheduleRender(ids);
  for (const id of ids) {
    browser.runtime.sendMessage({ type: "setMic", tabId: id, ...change }).then((applied) => {
      const had = state.micBlocked.has(id);
      if (applied) state.micBlocked.delete(id);
      else state.micBlocked.add(id);
      if (had !== !applied) scheduleRender();
    }, report);
  }
}

// Ползунок шлёт input на каждый пиксель — отправляем не чаще раза в 80 мс,
// но последнее значение не теряется никогда.
const VOLUME_THROTTLE_MS = 80;
let volumeTimer = null;
let volumePending = null;

function sendThrottled(fn, ...args) {
  volumePending = [fn, args];
  if (volumeTimer) return;
  fn(...args);
  volumePending = null;
  volumeTimer = setTimeout(function flush() {
    volumeTimer = null;
    if (volumePending) sendThrottled(volumePending[0], ...volumePending[1]);
  }, VOLUME_THROTTLE_MS);
}

async function newTabInGroup(gid, props = {}) {
  const members = tabsOfGroup(gid);
  const last = members[members.length - 1];
  const tab = await newTab(last ? { ...props, index: last.index + 1 } : props);
  await browser.tabs.group({ tabIds: [tab.id], groupId: gid });
  // В свёрнутой группе новая активная вкладка была бы не видна.
  if (state.groups.get(gid)?.collapsed) await browser.tabGroups.update(gid, { collapsed: false });
}

// Сворачиваем сразу на экране, не дожидаясь ответа Firefox (его событие
// потом лишь подтвердит то же самое).
function toggleCollapsed(gid) {
  const g = state.groups.get(gid);
  if (!g) return;
  const collapsed = !g.collapsed;
  g.collapsed = collapsed;
  scheduleRender();
  run(browser.tabGroups.update(gid, { collapsed }));
}

function startRename(gid) {
  const el = els.get("g" + gid);
  const group = state.groups.get(gid);
  if (!el || el.querySelector(".rename")) return;

  const titleEl = el._title;
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
