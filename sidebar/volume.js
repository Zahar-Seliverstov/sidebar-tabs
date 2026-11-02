"use strict";

/*
 * Громкость и микрофон вкладок: значки в строках, всплывающий регулятор,
 * колесо мыши. Сами значения держит фон.
 * Общие состояние и функции — в sidebar.js (обычные скрипты делят одну
 * глобальную область, порядок подключения — в sidebar.html).
 */

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
  if (throttled) sendThrottled(setVolume, ids, volume);
  else setVolume(ids, volume);
}

function usesMic(tab) {
  return !!(tab && tab.sharingState && tab.sharingState.microphone);
}

function micOf(id) {
  return state.mic.get(id) || { volume: 1, muted: false };
}

function shownMic(id) {
  const m = micOf(id);
  return m.muted ? 0 : m.volume;
}

function toggleMicMuted(id) {
  setMic([id], { muted: !micOf(id).muted });
}

// Как и со звуком: сдвинуть громкость выключенного микрофона — включить его.
function changeMic(ids, volume, throttled) {
  const change = volume > 0 ? { volume, muted: false } : { volume };
  if (throttled) sendThrottled(setMic, ids, change);
  else setMic(ids, change);
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
  box.addEventListener("wheel", onVolumeWheel, { passive: false });
  return box;
}

// showPct — проценты видны и в свёрнутом виде (у вкладки с изменённой громкостью).
function updateVolumeControl(box, tabId, showPct) {
  const muted = isMuted(tabById(tabId));
  const vol = volumeOf(tabId);
  const blocked = state.volumeBlocked.has(tabId);
  paintControl(box, {
    icon: muted ? "volume-x" : volumeIcon(vol),
    muted,
    blocked,
    tip: blocked
      ? "Эта страница не даёт менять громкость (служебная страница или ещё не загружена)"
      : (muted ? "Звук выключен. " : "") + "Клик — выключить/включить звук, наведите — громкость, колесо — ±5%",
    value: shownVolume(tabId),
    pct: showPct && !muted && vol < 1,
  });
}

function updateMicControl(box, tabId) {
  const m = micOf(tabId);
  const blocked = state.micBlocked.has(tabId);
  paintControl(box, {
    icon: m.muted ? "mic-off" : "mic",
    muted: m.muted,
    blocked,
    tip: blocked
      ? "Микрофон захвачен до установки расширения — перезагрузите страницу, чтобы им управлять"
      : (m.muted ? "Микрофон выключен: сайт слышит тишину. " : "Микрофон. ") +
        "Клик — выключить/включить, наведите — громкость, колесо — ±5%",
    value: shownMic(tabId),
    pct: !m.muted && m.volume < 1,
  });
}

function paintControl(box, p) {
  if (setIfChanged(box, "icon", p.icon)) box.firstChild.dataset.icon = p.icon;
  if (setIfChanged(box, "muted", p.muted)) box.classList.toggle("muted", p.muted);
  if (setIfChanged(box, "blocked", p.blocked)) box.classList.toggle("blocked", p.blocked);
  if (setIfChanged(box, "tip", p.tip)) box.firstChild.title = p.tip;
  const range = box.children[1].firstChild;
  const value = String(Math.round(p.value * 100));
  if (!(sliderHeld && document.activeElement === range) && range.value !== value) range.value = value;
  const pct = box.dataset.open !== undefined || p.pct ? range.value + "%" : "";
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
  if (box.classList.contains("mic")) changeMic([id], Number(e.target.value) / 100, true);
  else changeVolume([id], Number(e.target.value) / 100, true);
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
