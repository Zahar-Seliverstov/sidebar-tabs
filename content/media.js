"use strict";

/*
 * Плеер в панели: что играет в этом фрейме и как этим управлять.
 *
 * У WebExtension API нет доступа к Media Session страницы, поэтому скрипт
 * встаёт в каждый фрейм на document_start — раньше скриптов сайта — и
 * подменяет в прототипах страницы (wrappedJSObject + exportFunction, как
 * громкость в background.js):
 *   - MediaSession.setActionHandler — запоминаем обработчики сайта
 *     (play/pause/предыдущий/следующий/перемотка), чтобы вызывать их кнопками;
 *   - MediaSession.metadata / playbackState / setPositionState — узнаём трек,
 *     состояние и позицию сразу, как сайт их выставил;
 *   - HTMLMediaElement.play и чтение currentTime — находим плееры вне
 *     документа (new Audio()).
 *
 * Протокол с фоном (background.js) рассчитан на то, что любое сообщение
 * может потеряться, а сам скрипт — умереть без предупреждения:
 *   - "media" — состояние изменилось (не чаще раза в SEND_DELAY_MS);
 *   - то же сообщение раз в HEARTBEAT_MS, пока фрейму есть что показать:
 *     фон выбрасывает фреймы, от которых давно ничего не было;
 *   - "mediaQuery" — фон в любой момент спрашивает текущее состояние;
 *   - "mediaControl" — команда; ответ — когда сайт отреагировал (или вышло
 *     время): состояние ПОСЛЕ неё, чтобы панель показывала то, что произошло
 *     на самом деле, а не то, что ожидалось, и не «откатывала» кнопку, пока
 *     медленный сайт ещё думает.
 *
 * Обновление расширения убивает старую копию скрипта вместе со всем, что
 * она знала, а обработчики сайт выставляет один раз. Поэтому они хранятся
 * ещё и в самой странице (STASH на navigator.mediaSession) — новая копия
 * забирает их оттуда, и кнопки сайта работают без перезагрузки вкладки.
 *
 * Страницы без звука не платят ничего, кроме подмен: сообщений нет, таймеров нет.
 */

(() => {
  if (window.__mtbMedia) return;

  const MAX_ELEMENTS = 32;
  // Короче — звуки интерфейса (уведомления, клики), а не то, что слушают.
  const MIN_DURATION_S = 20;
  const SEND_DELAY_MS = 100;
  // Остановку подтверждаем с задержкой: при смене трека плеер на миг встаёт
  // на паузу (или сайт меняет плеер), и без задержки панель мигала бы.
  const PAUSE_CONFIRM_MS = 450;
  const HEARTBEAT_MS = 10000;
  // Команда: ждём реакции сайта не дольше CONTROL_MAX_MS, проверяя каждые
  // CONTROL_POLL_MS. Смена трека проходит через миг паузы — после неё ещё
  // TRACK_SETTLE_MS, чтобы ответ был «новый трек играет», а не «пауза».
  const CONTROL_MAX_MS = 1500;
  const CONTROL_POLL_MS = 50;
  const TRACK_SETTLE_MS = 300;
  // Перемотка видна сразу — ждём только, чтобы плеер успел её принять.
  const SEEK_SETTLE_MS = 120;
  const STASH = "__mtbMediaHandlers";
  const MEDIA_EVENTS = ["play", "playing", "pause", "ended", "emptied", "durationchange", "ratechange", "seeked", "volumechange"];
  const ACTIONS = ["play", "pause", "previoustrack", "nexttrack", "seekto", "seekbackward", "seekforward", "stop"];

  const M = (window.__mtbMedia = {
    handlers: new Map(),
    // Плееры, о которых знаем, в порядке обнаружения.
    els: new Set(),
    // Когда плеер последний раз запускали (для выбора главного).
    started: new WeakMap(),
    // Плееры, которые хоть раз звучали со звуком: беззвучное автовоспроизведение
    // (превью, «гифки») не показываем, а плеер, который пользователь потом
    // выключил кнопкой сайта, — продолжаем.
    heard: new WeakSet(),
    position: null,
    lastKey: "",
    shown: false,
    wasPlaying: false,
    timer: 0,
    heartbeat: 0,
  });

  const page = window.wrappedJSObject;
  // Скрипт внедрён в уже загруженную страницу (установка или обновление
  // расширения), а не до её скриптов: часть того, что сайт сделал раньше,
  // мы могли не увидеть.
  const late = document.readyState !== "loading";

  // Обработчики сайта, сохранённые прошлой копией скрипта (см. начало файла).
  function pageStash(create) {
    try {
      const ms = page.navigator.mediaSession;
      if (!ms) return null;
      let stash = ms[STASH];
      if (!stash && create) {
        stash = cloneInto({}, window);
        Object.defineProperty(ms, STASH, { value: stash, configurable: true });
      }
      return stash || null;
    } catch (e) {
      return null;
    }
  }

  function restoreHandlers() {
    const stash = pageStash(false);
    if (!stash) return;
    for (const name of ACTIONS) {
      try {
        const fn = stash[name];
        if (typeof fn === "function") M.handlers.set(name, fn);
      } catch (e) {}
    }
  }

  // ---------------------------------------------------------------- плееры

  // Громкость не учитываем: её может обнулить и наш же регулятор вкладки.
  function audibleNow(el) {
    try {
      return !el.paused && !el.ended && !el.muted;
    } catch (e) {
      return false;
    }
  }

  function noteHeard(el) {
    if (audibleNow(el)) M.heard.add(el);
  }

  function longEnough(el) {
    try {
      const d = el.duration;
      return d === Infinity || (Number.isFinite(d) && d >= MIN_DURATION_S);
    } catch (e) {
      return false;
    }
  }

  // Плеер, который стоит показывать: длинный и хоть раз звучал.
  function significant(el) {
    return M.heard.has(el) && longEnough(el);
  }

  function track(el) {
    if (!el || M.els.has(el)) return;
    M.els.add(el);
    for (const type of MEDIA_EVENTS) el.addEventListener(type, onMediaEvent);
    noteHeard(el);
    if (!el.paused) M.started.set(el, performance.now());
    evict();
    schedule();
  }

  // Предел на число плееров — против страниц, создающих тысячи Audio() для
  // звуков. Вытесняются сначала незначимые и стоящие, главный — никогда.
  function evict() {
    if (M.els.size <= MAX_ELEMENTS) return;
    const main = mainElement();
    const victims = [...M.els].filter((el) => el !== main && el.paused && !significant(el));
    const pool = victims.length ? victims : [...M.els].filter((el) => el !== main);
    const victim = pool[0];
    if (!victim) return;
    for (const type of MEDIA_EVENTS) victim.removeEventListener(type, onMediaEvent);
    M.els.delete(victim);
  }

  function onMediaEvent(e) {
    const el = e.currentTarget;
    if (e.type === "play" || e.type === "playing") M.started.set(el, performance.now());
    noteHeard(el);
    schedule(e.type === "seeked");
  }

  // Главный плеер — звучащий; из нескольких звучащих — запущенный последним;
  // ничего не звучит — последний запущенный. Именно «последний запущенный»:
  // многие сайты на каждый трек создают новый плеер, и старый (на паузе) не
  // должен заслонять новый.
  function mainElement() {
    let best = null;
    let bestScore = -Infinity;
    for (const el of M.els) {
      if (!significant(el)) continue;
      const score = (!el.paused && !el.ended ? 1e15 : 0) + (M.started.get(el) || 0);
      if (score > bestScore) {
        bestScore = score;
        best = el;
      }
    }
    return best;
  }

  // ---------------------------------------------------------------- состояние

  function pickArtwork(list) {
    let best = "";
    let bestScore = -1;
    try {
      for (const a of list || []) {
        const src = String(a.src || "");
        if (!/^(https?:|data:image\/)/.test(src)) continue;
        const size = parseInt(String(a.sizes || "").split("x")[0], 10) || 0;
        // Нужна картинка ~48–96 px: наименьшая не мельче 96, иначе самая крупная.
        const score = size >= 96 ? 10000 - size : size;
        if (score > bestScore) {
          bestScore = score;
          best = src;
        }
      }
    } catch (e) {}
    return best;
  }

  function readMetadata() {
    try {
      const m = navigator.mediaSession && navigator.mediaSession.metadata;
      if (!m) return null;
      return {
        title: String(m.title || ""),
        artist: String(m.artist || ""),
        album: String(m.album || ""),
        artwork: pickArtwork(m.artwork),
      };
    } catch (e) {
      return null;
    }
  }

  function declaredState() {
    try {
      return navigator.mediaSession ? String(navigator.mediaSession.playbackState) : "none";
    } catch (e) {
      return "none";
    }
  }

  // null — показывать нечего.
  function snapshot() {
    const meta = readMetadata();
    const el = mainElement();
    const declared = declaredState();
    if (!el && !meta && declared === "none") return null;

    // Состояние самого плеера надёжнее объявленного: многие сайты забывают
    // сбрасывать playbackState. Плеера нет (Web Audio) — верим сайту.
    // Новый трек уже запущен, но длительность ещё грузится — тоже «играет».
    let playing = el ? !el.paused && !el.ended : declared === "playing";
    if (!playing && meta) {
      for (const x of M.els) {
        if (!x.paused && !x.ended && Number.isNaN(x.duration)) playing = true;
      }
    }

    // Позиция — из самого плеера; объявленная сайтом — только без плеера
    // (Web Audio) или для эфира без длительности.
    let position = null;
    try {
      if (el && Number.isFinite(el.duration) && el.duration > 0) {
        position = { duration: el.duration, position: el.currentTime, rate: el.playbackRate };
      }
    } catch (e) {}
    if (!position && M.position && Number.isFinite(M.position.duration) && M.position.duration > 0) {
      const p = M.position;
      const elapsed = playing ? ((Date.now() - p.at) / 1000) * p.rate : 0;
      position = { duration: p.duration, position: Math.min(p.duration, p.position + elapsed), rate: p.rate };
    }

    let muted = false;
    try {
      muted = !!el && el.muted;
    } catch (e) {}

    return {
      meta,
      playing,
      pageMuted: muted,
      actions: ACTIONS.filter((a) => M.handlers.has(a)),
      canPlay: !!el || M.handlers.has("play") || M.handlers.has("pause"),
      canSeek: M.handlers.has("seekto") || !!el,
      position,
      // Поздний скрипт без единого обработчика сайта: кнопки сайта могли
      // быть, но мы их не видели — панель подскажет перезагрузить вкладку.
      late: late && M.handlers.size === 0 && !!meta,
      // Прямая трансляция: у плеера нет конца (радио, стрим).
      live: !position && !!el && el.duration === Infinity,
    };
  }

  function stateKey(state) {
    const p = state && state.position;
    return JSON.stringify(state && [state.meta, state.playing, state.pageMuted, state.actions, state.canPlay, p && Math.round(p.duration), p && p.rate, state && state.live, state && state.late]);
  }

  function send(state) {
    browser.runtime.sendMessage({ type: "media", state }).catch(() => {});
  }

  // Пока фрейму есть что показать — раз в HEARTBEAT_MS подтверждаем, что живы.
  function updateHeartbeat() {
    if (M.shown && !M.heartbeat) {
      M.heartbeat = setInterval(() => send(snapshot()), HEARTBEAT_MS);
    } else if (!M.shown && M.heartbeat) {
      clearInterval(M.heartbeat);
      M.heartbeat = 0;
    }
  }

  // force — отправить, даже если изменилась только позиция (перемотка).
  function schedule(force) {
    if (force) M.lastKey = "";
    if (M.timer) return;
    M.timer = setTimeout(function fire(confirmed) {
      M.timer = 0;
      const state = snapshot();
      if (state && !state.playing && M.wasPlaying && confirmed !== true) {
        M.timer = setTimeout(() => fire(true), PAUSE_CONFIRM_MS);
        return;
      }
      M.wasPlaying = !!(state && state.playing);
      const key = stateKey(state);
      if (key === M.lastKey) return;
      M.lastKey = key;
      // Пустое состояние нужно фону, только если до этого что-то было показано.
      if (!state && !M.shown) return;
      M.shown = !!state;
      updateHeartbeat();
      send(state);
    }, SEND_DELAY_MS);
  }

  // ---------------------------------------------------------------- подмены

  try {
    const xproto = MediaSession.prototype;
    const pproto = page.MediaSession.prototype;

    const setHandler = xproto.setActionHandler;
    pproto.setActionHandler = exportFunction(function (action, handler) {
      const result = setHandler.call(this, action, handler);
      const name = String(action);
      if (typeof handler === "function") M.handlers.set(name, handler);
      else M.handlers.delete(name);
      const stash = pageStash(true);
      try {
        if (stash) stash[name] = typeof handler === "function" ? handler : null;
      } catch (e) {}
      schedule();
      return result;
    }, window);

    const setPosition = xproto.setPositionState;
    pproto.setPositionState = exportFunction(function (st) {
      const result = setPosition.call(this, st);
      try {
        M.position = st
          ? {
              duration: Number(st.duration),
              position: Number(st.position) || 0,
              rate: st.playbackRate === undefined ? 1 : Number(st.playbackRate),
              at: Date.now(),
            }
          : null;
      } catch (e) {
        M.position = null;
      }
      schedule(true);
      return result;
    }, window);

    for (const prop of ["metadata", "playbackState"]) {
      const desc = Object.getOwnPropertyDescriptor(xproto, prop);
      Object.defineProperty(pproto, prop, {
        configurable: true,
        enumerable: true,
        get: exportFunction(function () {
          return desc.get.call(this);
        }, window),
        set: exportFunction(function (v) {
          desc.set.call(this, v);
          schedule();
        }, window),
      });
    }
  } catch (e) {
    // Нет Media Session (необычный фрейм) — остаются сами плееры.
  }

  try {
    const xproto = HTMLMediaElement.prototype;
    const pproto = page.HTMLMediaElement.prototype;
    const play = xproto.play;
    pproto.play = exportFunction(function () {
      track(this);
      return play.call(this);
    }, window);
    // Плеер вне документа, запущенный до появления скрипта (скрипт внедрён
    // в уже открытую страницу), находим по чтению currentTime — плееры
    // читают его постоянно, чтобы рисовать полосу прогресса.
    const ct = Object.getOwnPropertyDescriptor(xproto, "currentTime");
    Object.defineProperty(pproto, "currentTime", {
      configurable: true,
      enumerable: true,
      get: exportFunction(function () {
        if (!M.els.has(this)) track(this);
        return ct.get.call(this);
      }, window),
      set: exportFunction(function (v) {
        ct.set.call(this, v);
      }, window),
    });
  } catch (e) {}

  // Плееры в документе: события медиа не всплывают, но ловятся на погружении.
  window.addEventListener(
    "play",
    (e) => {
      if (e.target instanceof HTMLMediaElement) {
        track(e.target);
        onMediaEvent({ currentTarget: e.target, type: "play" });
      }
    },
    true
  );

  // Скрипт внедрён в уже открытую страницу (после установки/обновления
  // расширения) — подхватываем плееры, что уже есть в документе.
  for (const el of document.querySelectorAll("audio, video")) track(el);
  if (late) {
    restoreHandlers();
    schedule(true);
  }

  window.addEventListener("pagehide", () => {
    if (M.shown) send(null);
    M.shown = false;
    M.lastKey = "";
    updateHeartbeat();
  });
  window.addEventListener("pageshow", (e) => {
    if (e.persisted) schedule(true);
  });

  // ---------------------------------------------------------------- управление

  // Возвращает действие, которое на самом деле выполнялось (toggle → play/pause).
  function control(action, seekTime) {
    const el = mainElement();
    if (action === "toggle") {
      const state = snapshot();
      action = state && state.playing ? "pause" : "play";
    }
    const handler = M.handlers.get(action);
    if (handler) {
      try {
        handler(cloneInto({ action, seekTime }, window));
        return action;
      } catch (e) {
        // Обработчик сайта упал — пробуем напрямую через плеер.
      }
    }
    if (!el) return action;
    try {
      if (action === "play") el.play().catch(() => {});
      else if (action === "pause" || action === "stop") el.pause();
      else if (action === "seekto" && Number.isFinite(seekTime)) el.currentTime = seekTime;
    } catch (e) {}
    return action;
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function trackKey(state) {
    let src = "";
    try {
      const el = mainElement();
      src = el ? String(el.currentSrc || el.src || "") : "";
    } catch (e) {}
    return JSON.stringify([state && state.meta, src]);
  }

  // Ждёт, пока сайт отреагирует на команду; не дождались — отвечаем как
  // есть. Возвращает, отреагировал ли сайт.
  async function awaitReaction(action, before) {
    if (action === "seekto" || action === "seekforward" || action === "seekbackward") {
      await sleep(SEEK_SETTLE_MS);
      return true;
    }
    const isTrack = action === "nexttrack" || action === "previoustrack";
    const beforeTrack = isTrack ? trackKey(before) : "";
    const deadline = Date.now() + CONTROL_MAX_MS;
    while (Date.now() < deadline) {
      const now = snapshot();
      let done;
      if (action === "play") done = !!now && now.playing;
      else if (action === "pause" || action === "stop") done = !now || !now.playing;
      else if (isTrack) done = trackKey(now) !== beforeTrack;
      else done = true;
      if (done) {
        if (isTrack) await sleep(TRACK_SETTLE_MS);
        return true;
      }
      await sleep(CONTROL_POLL_MS);
    }
    return false;
  }

  async function runControl(msg) {
    const before = snapshot();
    const action = control(msg.action, msg.seekTime);
    const reacted = await awaitReaction(action, before);
    // Ответ — фактическое состояние; заодно сбрасываем ключ, чтобы
    // следующее событие точно ушло в фон.
    const state = snapshot();
    M.lastKey = stateKey(state);
    M.wasPlaying = !!(state && state.playing);
    M.shown = !!state;
    updateHeartbeat();
    return { state, reacted };
  }

  browser.runtime.onMessage.addListener((msg) => {
    if (!msg || typeof msg !== "object") return undefined;
    if (msg.type === "mediaQuery") return Promise.resolve({ state: snapshot() });
    if (msg.type === "mediaControl") return runControl(msg);
    return undefined;
  });
})();
