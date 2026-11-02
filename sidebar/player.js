"use strict";

/*
 * Плеер внизу панели: строки «что играет», пульт трека (позиция, кнопки,
 * подсказки), скорость воспроизведения и барабан для нескольких плееров.
 * Общие состояние и функции — в sidebar.js (обычные скрипты делят одну
 * глобальную область, порядок подключения — в sidebar.html).
 */

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
// пружина (spring.js) доводит его до строки с лёгким перелётом — «трещотка».

const PLAYER_TICK_MS = 500;
// Шаг барабана в градусах и высота строки задают его радиус: строки
// касаются друг друга краями, как грани настоящего барабана.
const WHEEL_STEP_DEG = 26;
const WHEEL_ROW_H = 34;
const WHEEL_RADIUS = WHEEL_ROW_H / 2 / Math.tan((WHEEL_STEP_DEG / 2) * (Math.PI / 180));
const WHEEL_VISIBLE = 2.6;
const WHEEL_SPRING = { stiffness: 420, damping: 24, mass: 0.9 };
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

  // Кнопки плагинов («в мою музыку» и т. п.) — про этот трек, рядом с ним.
  const plugins = document.createElement("span");
  plugins.className = "pr-plugins";
  const vol = makeVolumeControl("pr-vol vexp");
  const play = button("pl-btn pl-play", "toggle", "play", "");

  el.append(art, text, plugins, vol, play, bar);
  el._p = { img, title, sub, fill, bar, plugins, vol, play };
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

  updatePluginButtons(p.plugins, s);
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
function sendMediaControl(s, action, seekTime, rate) {
  if (action === "rate") {
    s.rate = rate;
  } else if (action === "toggle" && s.canPlay) {
    if (s.position) s.position = { ...s.position, position: mediaPosition(s.position, s.playing, Date.now()), at: Date.now() };
    s.playing = !s.playing;
  } else if (action === "seekto" && s.position) {
    s.position = { ...s.position, position: seekTime, at: Date.now() };
  } else if (action.startsWith("plugin:") && s.plugins) {
    const key = action.slice(7);
    s.plugins = { ...s.plugins, [key]: !s.plugins[key] };
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
  browser.runtime.sendMessage({ type: "mediaControl", tabId: s.tabId, frameId: s.frameId, action, seekTime, rate }).then(done, (err) => {
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
  setOff($dkPlay, s.canPlay, withHint(s.playing ? "Пауза" : "Играть", "media-toggle"), noSite);
  setOff($dkPrev, s.actions.includes("previoustrack"), withHint("Предыдущий трек", "media-prev"), noSite || "Этот сайт не даёт переключать треки извне");
  setOff($dkNext, s.actions.includes("nexttrack"), withHint("Следующий трек", "media-next"), noSite || "Этот сайт не даёт переключать треки извне");
  updateRate(s);
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

// Кнопки плагинов строки — те, что страница объявила доступными для этого трека.
function updatePluginButtons(box, s) {
  const keys = Object.keys(s.plugins || {}).filter(pluginButton);
  if ([...box.children].map((b) => b.dataset.key).join() !== keys.join()) {
    box.textContent = "";
    for (const key of keys) {
      const btn = button("pl-btn pr-plugin", "plugin:" + key, "plugin", "");
      btn.dataset.key = key;
      btn._v = {};
      box.append(btn);
    }
  }
  for (const btn of box.children) {
    const b = pluginButton(btn.dataset.key);
    const on = s.plugins[btn.dataset.key] === true;
    if (setIfChanged(btn, "on", on)) btn.classList.toggle("on", on);
    const icon = on ? b.activeIcon : b.icon;
    if (setIfChanged(btn, "icon", icon)) btn.style.setProperty("--icon", `url(${JSON.stringify(icon)})`);
    const title = on ? b.activeTitle : b.title;
    if (setIfChanged(btn, "title", title)) btn.title = title;
  }
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
  else if (act === "rate") openRateMenu(s);
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

// ---------------------------------------------------------------- скорость
//
// Значок «1×» справа от полосы позиции: клик — меню скоростей, колесо на
// себя (вниз) — быстрее на 0,25×, от себя — медленнее (как громкость).
// Ставится прямо плееру страницы, поэтому есть только у настоящего
// <audio>/<video>; следующий трек того же сайта получает ту же скорость.

const $deckRate = document.getElementById("deck-rate");
$deckRate.dataset.act = "rate";

function updateRate(s) {
  $deckRate.hidden = !s.canRate;
  if (!s.canRate) return;
  const rate = Number.isFinite(s.rate) ? s.rate : 1;
  const text = formatRate(rate);
  if ($deckRate.textContent !== text) $deckRate.textContent = text;
  $deckRate.classList.toggle("changed", Math.abs(rate - 1) > 0.001);
  const keys = [keyHint("speed-up") && "быстрее " + keyHint("speed-up"), keyHint("speed-down") && "медленнее " + keyHint("speed-down")].filter(Boolean);
  const tip = "Скорость воспроизведения. Клик — выбрать, колесо — ±0,25×" + (keys.length ? ` (${keys.join(", ")})` : "");
  if ($deckRate.title !== tip) $deckRate.title = tip;
}

function setRate(s, rate) {
  if (Math.abs((s.rate || 1) - rate) < 0.001) return;
  sendMediaControl(s, "rate", undefined, rate);
}

function openRateMenu(s) {
  const r = $deckRate.getBoundingClientRect();
  const current = Number.isFinite(s.rate) ? s.rate : 1;
  const presets = RATE_PRESETS.includes(current) ? RATE_PRESETS : [...RATE_PRESETS, current].sort((a, b) => a - b);
  // Узкий столбик плашек; выбранная — в цвете акцента.
  const chips = presets.map((rate) => ({
    label: formatRate(rate),
    on: Math.abs(rate - current) < 0.001,
    title: rate === 1 ? withHint("Обычная скорость", "speed-reset") : "",
    action: () => setRate(s, rate),
  }));
  openMenu([{ head: "Скорость" }, { chips }], r.left, r.top);
  $menu.classList.add("compact");
  // Над значком, правым краем к нему.
  $menu.style.left = Math.max(4, Math.min(r.right - $menu.offsetWidth, innerWidth - $menu.offsetWidth - 4)) + "px";
  $menu.style.top = Math.max(4, r.top - 6 - $menu.offsetHeight) + "px";
}

$deckRate.addEventListener(
  "wheel",
  (e) => {
    const s = deckSession;
    if (!s || !s.canRate || !e.deltaY) return;
    e.preventDefault();
    setRate(s, stepRate(Number.isFinite(s.rate) ? s.rate : 1, e.deltaY > 0 ? 1 : -1));
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
// .spinning — пока барабан крутится: строки на время поворота становятся
// отдельными слоями (will-change), в покое — нет.
const wheelPos = new SidebarSpring.Spring(
  0,
  WHEEL_SPRING,
  () => layoutWheel(),
  () => $player.classList.remove("spinning")
);
let wheelTarget = 0;
let wheelCenterTab = null;
let wheelPixels = 0;

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
  wheelPos.stop();
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
  $player.classList.add("spinning");
  wheelPos.to(target);
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
    } else if (msg && msg.type === "micState" && msg.mic && typeof msg.mic === "object") {
      // Микрофон переключили горячей клавишей (или из панели другого окна).
      state.mic = new Map(Object.entries(msg.mic).map(([id, m]) => [Number(id), m]));
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
