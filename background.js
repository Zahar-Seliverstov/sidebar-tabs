"use strict";

/*
 * Единственная задача этого расширения: держать в browser.storage.local
 * актуальный снимок всех окон/вкладок, чтобы после краша браузера или
 * отключения питания их можно было восстановить. Никакого UI — только фон.
 *
 * persistent: true в manifest.json не случаен: с event page (persistent: false)
 * состояние таймеров дебаунса живёт только в памяти и теряется при выгрузке
 * страницы между событиями — можно потерять уже отложенное, но ещё не
 * выполненное сохранение. Постоянный background page исключает этот риск,
 * это самый надёжный вариант из доступных для MV2.
 */

const STORAGE_KEY = "lastSession";

// Обычный дебаунс: ждём затишья SAVE_DEBOUNCE_MS после последнего события.
// SAVE_MAX_WAIT_MS — страховка от сайтов, которые шлют события непрерывно
// (например часто дёргают onUpdated) — без неё обычный дебаунс с постоянным
// сбросом таймера мог бы никогда не выстрелить. Раз в SAVE_MAX_WAIT_MS
// сохранение форсируется, даже если поток событий не прекращается.
const SAVE_DEBOUNCE_MS = 400;
const SAVE_MAX_WAIT_MS = 2000;
// Запись не удалась (диск, квота) — повтор через столько, не дожидаясь
// следующего изменения вкладок: оно может и не случиться до краша.
const SAVE_RETRY_MS = 5000;
// Подряд неудачных повторов не больше этого: сломалось надолго — дальше
// сохранение запустит следующее изменение вкладок, а не вечный таймер.
const SAVE_RETRY_MAX = 5;

const RESTORABLE_SCHEMES = ["http:", "https:", "file:", "ftp:"];

let saveTimer = null;
let pendingSince = null;
let lastSavedSerialized = null;
let isRestoring = false;
let saveRunning = null;
let saveAgain = false;
let saveRetryTimer = null;
let saveFailures = 0;

// Резервная копия читается сразу при загрузке фона — раньше любой записи.
// Иначе при старте браузера сохранение «одна новая вкладка» могло успеть
// затереть копию до того, как onStartup её прочитает и восстановит.
// Нужна только проверке при старте; если старта не было (фон перезапущен
// обновлением расширения), через минуту отпускаем — не держим снимок в памяти.
let startupStored = browser.storage.local.get(STORAGE_KEY).catch(() => null);
const startupStoredTimer = setTimeout(() => (startupStored = null), 60000);
// Под node (тесты) таймер не должен держать процесс.
if (startupStoredTimer && startupStoredTimer.unref) startupStoredTimer.unref();

function isRestorableUrl(url) {
  if (!url) return false;
  if (looksLikeFreshUrl(url)) return true;
  try {
    const scheme = new URL(url).protocol;
    return RESTORABLE_SCHEMES.includes(scheme);
  } catch (e) {
    return false;
  }
}

function looksLikeFreshUrl(url) {
  return url === "about:newtab" || url === "about:blank" || url === "about:home";
}

// about:blank со статусом "loading" — переходное состояние вкладки за миг до
// настоящей навигации (например window.open() или редирект). Если снимок
// попадёт ровно в этот момент, вкладка "потеряет" реальный адрес и после
// восстановления останется пустой. Уже загруженный (status: "complete")
// about:blank — это осознанно пустая вкладка пользователя, её сохраняем как есть.
function isTransientTab(tab) {
  return tab.url === "about:blank" && tab.status === "loading";
}

// Firefox начиная с некоторой версии поддерживает нативные группы вкладок
// (browser.tabs.group() / browser.tabGroups.*). API относительно новый, поэтому
// везде используется feature-detection — на старом Firefox без этого API снимок
// просто не содержит групп, поведение полностью как раньше, без ошибок.
async function queryGroupsByFirefoxId(windowId) {
  if (!browser.tabGroups || typeof browser.tabGroups.query !== "function") return new Map();
  try {
    const groups = await browser.tabGroups.query({ windowId });
    return new Map(groups.map((g) => [g.id, { title: g.title, color: g.color, collapsed: g.collapsed }]));
  } catch (err) {
    console.error("[sidebar-tabs] failed to read tab groups", err);
    return new Map();
  }
}

// groupId, который Firefox назначает группе, живёт только в рамках текущей
// сессии браузера и после перезапуска ничего не значит — его нельзя сохранять
// напрямую. Вместо этого каждой группе в снимке присваивается локальный
// ключ (0,1,2...), уникальный в пределах окна, на который ссылаются вкладки —
// его мы и используем при восстановлении, создавая группы заново.
async function captureWindow(win) {
  const groupMetaByFirefoxId = await queryGroupsByFirefoxId(win.id);
  const groupKeyByFirefoxId = new Map();
  const groups = [];

  const tabs = (win.tabs || [])
    .filter((tab) => isRestorableUrl(tab.url) && !isTransientTab(tab))
    .map((tab) => {
      const entry = { url: tab.url, title: tab.title, pinned: tab.pinned, active: tab.active };

      const meta = tab.groupId !== undefined && tab.groupId !== -1 ? groupMetaByFirefoxId.get(tab.groupId) : undefined;
      if (meta) {
        if (!groupKeyByFirefoxId.has(tab.groupId)) {
          groupKeyByFirefoxId.set(tab.groupId, groups.length);
          groups.push({ title: meta.title, color: meta.color, collapsed: meta.collapsed });
        }
        entry.groupKey = groupKeyByFirefoxId.get(tab.groupId);
      }

      return entry;
    });

  return { tabs, groups };
}

async function captureSession() {
  if (isRestoring) return;

  const windows = await browser.windows.getAll({ populate: true });

  // popup/panel/devtools-окна — не обычные вкладочные окна, их не сохраняем
  // и не собираемся потом воссоздавать через windows.create() как обычное окно.
  const candidateWindows = windows.filter((win) => !win.incognito && win.type === "normal");

  const snapshot = (await Promise.all(candidateWindows.map((win) => captureWindow(win)))).filter(
    (win) => win.tabs.length > 0
  );

  if (snapshot.length === 0) return;

  // Ничего не изменилось с прошлого сохранения — не пишем лишний раз на диск.
  const serialized = JSON.stringify(snapshot);
  if (serialized === lastSavedSerialized) return;

  await browser.storage.local.set({
    [STORAGE_KEY]: {
      windows: snapshot,
      savedAt: Date.now(),
    },
  });

  // lastSavedSerialized обновляем только ПОСЛЕ успешной записи. Если бы мы
  // помечали снимок как "сохранённый" до await, а storage.local.set затем
  // упал бы (квота, ошибка диска), следующая попытка с тем же снимком тихо
  // считала бы себя уже сохранённой и пропускала запись — расхождение между
  // памятью и диском осталось бы навсегда. Ретрай при сбое произойдёт при
  // следующем реальном изменении вкладок/окон (нет отдельного таймера-подстраховки).
  lastSavedSerialized = serialized;
}

// Сохранения идут строго по одному. Два параллельных снимка могли бы
// записаться в обратном порядке — и на диске остался бы более старый.
// Запрос во время записи не теряется: по её окончании снимок снимается заново.
function runSave() {
  if (saveRunning) {
    saveAgain = true;
    return saveRunning;
  }
  saveRunning = (async () => {
    try {
      do {
        saveAgain = false;
        try {
          await captureSession();
          saveFailures = 0;
        } catch (err) {
          console.error("[sidebar-tabs] save failed", err);
          if (++saveFailures <= SAVE_RETRY_MAX) scheduleSaveRetry();
        }
      } while (saveAgain);
    } finally {
      saveRunning = null;
    }
  })();
  return saveRunning;
}

function scheduleSaveRetry() {
  if (saveRetryTimer) return;
  saveRetryTimer = setTimeout(() => {
    saveRetryTimer = null;
    runSave();
  }, SAVE_RETRY_MS);
}

function scheduleSave() {
  const now = Date.now();
  if (pendingSince === null) pendingSince = now;

  if (saveTimer) clearTimeout(saveTimer);

  const elapsed = now - pendingSince;
  const delay = elapsed >= SAVE_MAX_WAIT_MS ? 0 : Math.min(SAVE_DEBOUNCE_MS, SAVE_MAX_WAIT_MS - elapsed);

  saveTimer = setTimeout(() => {
    saveTimer = null;
    pendingSince = null;
    runSave();
  }, delay);
}

browser.tabs.onCreated.addListener(scheduleSave);
browser.tabs.onRemoved.addListener(scheduleSave);
browser.tabs.onMoved.addListener(scheduleSave);
browser.tabs.onAttached.addListener(scheduleSave);
browser.tabs.onDetached.addListener(scheduleSave);
browser.tabs.onReplaced.addListener(scheduleSave);
// ---------------------------------------------------------------- кэш иконок
//
// Отложенные (discarded) вкладки не знают своей иконки, пока их не загрузишь,
// а грузить их ради иконки — ровно то, чего discarded избегает. Поэтому
// иконка каждого сайта запоминается, пока его вкладка открыта, а панель
// показывает её для незагруженных вкладок того же сайта.
//
// Ключ — hostname: иконка почти всегда общая на сайт, а кэш по полному URL
// промахивался бы на каждой новой странице. Хранится в отдельном ключе
// storage.local, чтобы не раздувать и не дёргать снимок сессии.

const FAVICONS_KEY = "favicons";
const FAVICONS_MAX = 500;
// data:-иконки иногда бывают огромными SVG — такие не кэшируем, чтобы
// кэш оставался маленьким и дешёвым для чтения при открытии панели.
const FAVICON_MAX_LENGTH = 16 * 1024;
// Запись троттлится (не дебаунсится): таймер ставится на первое изменение и
// не сбрасывается последующими — голодания при непрерывной навигации нет.
const FAVICONS_SAVE_MS = 2000;

let favicons = new Map();
let faviconsTimer = null;

function faviconHost(url) {
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:" ? u.hostname : null;
  } catch (e) {
    return null;
  }
}

function isCacheableIcon(icon) {
  return typeof icon === "string" && icon.length <= FAVICON_MAX_LENGTH && /^(https?:|data:image\/)/.test(icon);
}

// Кэш с диска подмешивается под то, что уже успело накопиться в памяти
// с момента запуска: свежие значения важнее сохранённых.
const faviconsLoaded = (async () => {
  try {
    const stored = (await browser.storage.local.get(FAVICONS_KEY))[FAVICONS_KEY];
    if (!stored || typeof stored !== "object") return;
    const merged = new Map(Object.entries(stored));
    for (const [host, icon] of favicons) {
      merged.delete(host);
      merged.set(host, icon);
    }
    favicons = merged;
    trimFavicons();
  } catch (err) {
    console.error("[sidebar-tabs] failed to load favicon cache", err);
  }
})();

function trimFavicons() {
  while (favicons.size > FAVICONS_MAX) favicons.delete(favicons.keys().next().value);
}

function rememberFavicon(tab, icon) {
  // Приватные окна не оставляют следов на диске — и в кэше иконок тоже.
  if (!tab || tab.incognito) return;
  const host = faviconHost(tab.url);
  if (!host || !isCacheableIcon(icon) || favicons.get(host) === icon) return;

  // Map хранит порядок вставки: переставляем в конец, вытесняем самые старые.
  favicons.delete(host);
  favicons.set(host, icon);
  trimFavicons();
  scheduleFaviconsSave();
}

function scheduleFaviconsSave() {
  if (faviconsTimer) return;
  faviconsTimer = setTimeout(async () => {
    faviconsTimer = null;
    await faviconsLoaded;
    try {
      await browser.storage.local.set({ [FAVICONS_KEY]: Object.fromEntries(favicons) });
    } catch (err) {
      console.error("[sidebar-tabs] failed to save favicon cache", err);
    }
  }, FAVICONS_SAVE_MS);
}

// Уже открытые на момент запуска вкладки (включая восстановленные самим
// Firefox, если он знает их иконки) сразу наполняют кэш.
browser.tabs
  .query({})
  .then((tabs) => tabs.forEach((tab) => rememberFavicon(tab, tab.favIconUrl)))
  .catch((err) => console.error("[sidebar-tabs] failed to seed favicon cache", err));

browser.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.favIconUrl) rememberFavicon(tab, changeInfo.favIconUrl);

  // Заголовок намеренно не триггерит сохранение: у некоторых сайтов он меняется
  // непрерывно (счётчики уведомлений и т.п.), а для восстановления не критичен —
  // достаточно того, что он попадёт в снимок при следующем реальном сохранении.
  if (
    changeInfo.status === "complete" ||
    changeInfo.url !== undefined ||
    changeInfo.pinned !== undefined ||
    changeInfo.groupId !== undefined
  ) {
    scheduleSave();
  }
});
browser.windows.onCreated.addListener(scheduleSave);
browser.windows.onRemoved.addListener(scheduleSave);

// Переименование/смена цвета/сворачивание группы не порождают ни одного
// tabs.*-события — без этих подписок такие изменения попадали бы в снимок
// только при следующем постороннем изменении вкладок.
if (browser.tabGroups) {
  for (const name of ["onCreated", "onUpdated", "onRemoved", "onMoved"]) {
    if (browser.tabGroups[name]) browser.tabGroups[name].addListener(scheduleSave);
  }
}

// ---------------------------------------------------------------- громкость вкладок
//
// У WebExtension API нет громкости вкладки — есть только muted. Поэтому
// громкость меняется изнутри страницы. Ничего не внедряется заранее и никуда,
// кроме вкладок, где пользователь сам сдвинул громкость: остальные страницы
// не платят за это ничем.
//
// Требует разрешения <all_urls>. Сначала оно было необязательным и
// запрашивалось из панели при первом использовании, но на практике так и не
// выдавалось — громкость молча не работала.
//
// Громкость вкладки — МНОЖИТЕЛЬ к громкости, которую ставит сам сайт:
// в прототипе HTMLMediaElement страницы (через wrappedJSObject + exportFunction,
// что не зависит от CSP страницы) подменяется свойство volume — сайт видит и
// ставит своё значение, а реально звучит "его значение × наш множитель".
// Поэтому собственный регулятор плеера продолжает работать и не перебивает наш.
//
// Музыкальные сервисы обычно играют через new Audio(), не вставленный в
// документ, — такой плеер не найти поиском по DOM. Его ловим, когда страница
// к нему обращается: play(), volume или currentTime (плееры читают его
// постоянно, чтобы рисовать полосу прогресса).
//
// Проверено в настоящем Firefox (headless-стенд с тестовым расширением):
// плеер в DOM, плеер вне DOM, плеер, созданный после настройки, собственная
// громкость сайта, промис play(), сброс на 100%.
// Не действует на Web Audio (часть игр и редкие плееры).

const tabVolumes = new Map();

// Идемпотентно: повторная инъекция в ту же страницу только меняет множитель.
// Состояние (S) живёт в песочнице content-скриптов расширения, не на странице.
// Элементы держатся в S.els сильными ссылками — ограничено 300 штуками,
// чтобы страница, создающая тысячи Audio() для звуков, не копила память.
function volumeScript(volume) {
  return `(() => {
    const factor = ${JSON.stringify(volume)};
    const S = window.__mtbVol || (window.__mtbVol = { factor: 1, installed: false, els: new Set(), want: new WeakMap() });
    S.factor = factor === null ? 1 : factor;
    const xproto = HTMLMediaElement.prototype;
    // Исходный аксессор запоминается один раз: при повторной инъекции
    // нельзя случайно взять уже подменённый (и умножить дважды).
    const vol = S.vol || (S.vol = Object.getOwnPropertyDescriptor(xproto, "volume"));
    const apply = (el) => {
      try { vol.set.call(el, Math.min(1, Math.max(0, S.want.get(el) * S.factor))); } catch (e) {}
    };
    const track = (el) => {
      if (!el || S.want.has(el)) return;
      try { S.want.set(el, vol.get.call(el)); } catch (e) { return; }
      S.els.add(el);
      if (S.els.size > 300) S.els.delete(S.els.values().next().value);
      apply(el);
    };
    if (!S.installed) {
      S.installed = true;
      const pproto = window.wrappedJSObject.HTMLMediaElement.prototype;
      Object.defineProperty(pproto, "volume", {
        configurable: true,
        enumerable: true,
        get: exportFunction(function () {
          track(this);
          return S.want.has(this) ? S.want.get(this) : vol.get.call(this);
        }, window),
        set: exportFunction(function (v) {
          const n = Number(v);
          if (!(n >= 0 && n <= 1)) return vol.set.call(this, v);
          track(this);
          S.want.set(this, n);
          apply(this);
        }, window),
      });
      const ct = Object.getOwnPropertyDescriptor(xproto, "currentTime");
      Object.defineProperty(pproto, "currentTime", {
        configurable: true,
        enumerable: true,
        get: exportFunction(function () { track(this); return ct.get.call(this); }, window),
        set: exportFunction(function (v) { ct.set.call(this, v); }, window),
      });
      const play = xproto.play;
      pproto.play = exportFunction(function () { track(this); return play.call(this); }, window);
      document.addEventListener("play", (e) => {
        if (e.target instanceof HTMLMediaElement) track(e.target);
      }, true);
    }
    for (const el of document.querySelectorAll("audio, video")) track(el);
    for (const el of S.els) apply(el);
  })();`;
}

async function injectVolume(tabId, volume) {
  try {
    await browser.tabs.executeScript(tabId, { code: volumeScript(volume), allFrames: true, matchAboutBlank: true });
    return true;
  } catch (err) {
    // Служебные страницы (about:, магазин дополнений), нет разрешения,
    // вкладка не загружена — громкость просто не применяется.
    return false;
  }
}

function clampVolume(volume) {
  const v = Number(volume);
  if (!Number.isFinite(v)) return 1;
  return Math.min(1, Math.max(0, Math.round(v * 100) / 100));
}

async function setTabVolume(tabId, volume) {
  const v = clampVolume(volume);
  if (v >= 1) {
    const had = tabVolumes.delete(tabId);
    return had ? injectVolume(tabId, null) : true;
  }
  tabVolumes.set(tabId, v);
  return injectVolume(tabId, v);
}

// Фильтр properties: фон не просыпается на каждую смену заголовка
// (у некоторых сайтов он тикает постоянно) — нужны только эти поля.
browser.tabs.onUpdated.addListener(
  (tabId, changeInfo) => {
    if (!tabVolumes.has(tabId)) return;
    // Перезагрузка/переход сбрасывают песочницу страницы, а "audible" ловит
    // плееры во фреймах, появившихся уже после загрузки.
    if (changeInfo.status === "complete" || changeInfo.audible === true) {
      injectVolume(tabId, tabVolumes.get(tabId));
    }
  },
  { properties: ["status", "audible"] }
);
browser.tabs.onRemoved.addListener((tabId) => tabVolumes.delete(tabId));
browser.tabs.onReplaced.addListener((addedTabId, removedTabId) => {
  if (!tabVolumes.has(removedTabId)) return;
  tabVolumes.set(addedTabId, tabVolumes.get(removedTabId));
  tabVolumes.delete(removedTabId);
});

// ---------------------------------------------------------------- плеер
//
// Что показывает плеер в панели. Два источника, и оба проверяемые:
//
//   1. content/media.js в каждом фрейме сообщает трек, состояние и кнопки
//      сайта ("media"). Сообщение может потеряться, а скрипт — умереть молча
//      (упал фрейм, обновилось расширение, ушли со страницы без pagehide),
//      поэтому:
//        - фрейм, от которого MEDIA_STALE_MS не было ничего (скрипт шлёт
//          подтверждение раз в 10 с, но в фоновой вкладке таймеры страницы
//          Firefox придерживает), сначала переспрашивается ("mediaQuery");
//        - при открытии панели и при любом изменении звука вкладки состояние
//          фреймов тоже перезапрашивается;
//        - выбрасывается фрейм, только когда его скрипта точно нет (Firefox
//          отвечает «некому принять»). Не ответил вовремя — страница просто
//          занята (тяжёлый сайт): строка остаётся, а если фрейм молчит совсем
//          долго (MEDIA_DEAD_MS) — тогда уходит;
//        - после команды кнопки ответом приходит состояние ПОСЛЕ неё — панель
//          показывает то, что произошло, а не то, что ожидалось.
//   2. Firefox сам знает, какая вкладка звучит (tab.audible), — это истина
//      о звуке. Вкладка звучит, а скрипт о ней молчит (Web Audio, страница,
//      куда скрипт не попал) — она всё равно показывается простой строкой
//      (без кнопок сайта, с громкостью и выключением звука).
//
// Всё только в памяти: после перезапуска браузера ничего не играет.

const MEDIA_TEXT_MAX = 300;
const MEDIA_ART_MAX = 64 * 1024;
const MEDIA_ACTIONS = ["play", "pause", "previoustrack", "nexttrack", "seekto", "seekbackward", "seekforward", "stop"];
const MEDIA_BROADCAST_MS = 50;
const MEDIA_DRIFT_S = 1.5;
const MEDIA_VISIBLE_KEYS = ["windowId", "title", "artist", "album", "artwork", "playing", "pageMuted", "canPlay", "canSeek", "late", "live"];
const MEDIA_STALE_MS = 25000;
const MEDIA_DEAD_MS = 90000;
// Ответ на команду content-скрипт шлёт, дождавшись реакции сайта (до 1,5 с).
const MEDIA_CONTROL_TIMEOUT_MS = 4000;
const MEDIA_SWEEP_MS = 5000;
const MEDIA_QUERY_TIMEOUT_MS = 800;
// Сколько держать строку «просто звучащей» вкладки после того, как звук
// пропал: между треками звук на миг стихает, строка не должна мигать.
const AUDIBLE_GRACE_MS = 3000;
// Firefox сообщает «вкладка звучит» раньше, чем скрипт страницы успевает
// прислать трек. Простая строка появляется, только если скрипт молчит
// дольше этого, — иначе на миг возникала бы строка без кнопок и тут же
// сменялась настоящей (а нажатие в ней уходило бы в никуда).
const BASIC_ROW_DELAY_MS = 1200;
// frameId простой строки: настоящих фреймов с таким номером не бывает.
const NO_FRAME = -1;

// "tabId:frameId" → состояние фрейма (последнее, что он сообщил).
const mediaSessions = new Map();
// tabId → { windowId, audible, since, basicShown, quietSince, playedAt }: вкладки, которые
// Firefox считает звучащими (или переставшими звучать меньше AUDIBLE_GRACE_MS назад).
const audibleTabs = new Map();
// Порядок строк в панели (tabId). Постоянный: новая строка встаёт наверх,
// дальше строки не прыгают ни от паузы, ни от смены трека — переставляет
// их только пользователь (перетаскиванием в панели).
let mediaOrder = [];
let mediaBroadcastTimer = null;
let mediaSweepTimer = null;

function mediaText(value) {
  return typeof value === "string" ? value.slice(0, MEDIA_TEXT_MAX) : "";
}

function finiteOr(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

// Данные приходят со страницы — доверять их форме нельзя.
function sanitizeMedia(state) {
  const meta = state.meta && typeof state.meta === "object" ? state.meta : null;
  const art = meta && typeof meta.artwork === "string" ? meta.artwork : "";
  const pos = state.position && typeof state.position === "object" ? state.position : null;
  const duration = pos ? finiteOr(pos.duration, 0) : 0;
  return {
    title: meta ? mediaText(meta.title) : "",
    artist: meta ? mediaText(meta.artist) : "",
    album: meta ? mediaText(meta.album) : "",
    artwork: art.length <= MEDIA_ART_MAX && /^(https?:|data:image\/)/.test(art) ? art : "",
    playing: state.playing === true,
    pageMuted: state.pageMuted === true,
    actions: Array.isArray(state.actions) ? MEDIA_ACTIONS.filter((a) => state.actions.includes(a)) : [],
    canPlay: state.canPlay === true,
    canSeek: state.canSeek === true,
    late: state.late === true,
    live: state.live === true && duration <= 0,
    position:
      duration > 0
        ? {
            duration,
            position: Math.min(duration, Math.max(0, finiteOr(pos.position, 0))),
            rate: finiteOr(pos.rate, 1),
            at: Date.now(),
          }
        : null,
  };
}

// Новое состояние фрейма (из сообщения, ответа на запрос или на команду).
// null/не объект — фрейму больше нечего показывать.
function applyMediaState(tab, frameId, state) {
  const key = tab.id + ":" + frameId;
  if (!state || typeof state !== "object") {
    if (mediaSessions.delete(key)) scheduleMediaBroadcast();
    return;
  }
  const prev = mediaSessions.get(key);
  const entry = { tabId: tab.id, frameId, windowId: tab.windowId, ...sanitizeMedia(state) };
  // playedAt — когда фрейм последний раз играл. Трек, который ни разу не
  // играл (сайт лишь объявил его), не показываем.
  entry.playedAt = entry.playing ? Date.now() : prev ? prev.playedAt : 0;
  entry.seenAt = Date.now();
  mediaSessions.set(key, entry);
  if (mediaChanged(prev, entry)) scheduleMediaBroadcast();
  scheduleMediaSweep();
}

// Позиция, до которой панель сама досчитала бы от прошлого состояния.
function expectedPosition(p, playing, now) {
  return playing ? p.position + ((now - p.at) / 1000) * p.rate : p.position;
}

// Изменилось ли то, что видно в панели. Подтверждения «жив» от фрейма
// (раз в 10 с, с обложкой до 64 КБ) иначе будили бы все открытые панели.
// Позицию панель досчитывает сама — рассылаем, только если она разошлась
// с ожидаемой больше чем на MEDIA_DRIFT_S (перемотка, буферизация).
function mediaChanged(prev, next) {
  if (!prev || (prev.playedAt > 0) !== (next.playedAt > 0)) return true;
  for (const k of MEDIA_VISIBLE_KEYS) {
    if (prev[k] !== next[k]) return true;
  }
  if (prev.actions.join() !== next.actions.join()) return true;
  const a = prev.position;
  const b = next.position;
  if (!a || !b) return a !== b;
  if (a.duration !== b.duration || a.rate !== b.rate) return true;
  return Math.abs(expectedPosition(a, prev.playing, b.at) - b.position) > MEDIA_DRIFT_S;
}

function onMediaMessage(msg, sender) {
  const tab = sender && sender.tab;
  if (!tab || tab.incognito || !Number.isInteger(tab.id)) return;
  applyMediaState(tab, Number.isInteger(sender.frameId) ? sender.frameId : 0, msg.state);
}

// Строки панели: фреймы со скриптом, а для звучащих вкладок без них — простые строки.
function mediaList(now = Date.now()) {
  const rows = [...mediaSessions.values()].filter((s) => s.playedAt > 0);
  const covered = new Set(rows.map((s) => s.tabId));
  for (const [tabId, a] of audibleTabs) {
    if (covered.has(tabId)) continue;
    // Звучит — после задержки. Стихла — только если простую строку уже
    // показывали, пока звучало (пауза между треками). Иначе это остаток от
    // страницы, чей плеер уже ушёл (переход, закрытие плеера), — не показываем.
    if (a.audible) {
      if (now - a.since < BASIC_ROW_DELAY_MS) continue;
      a.basicShown = true;
    } else if (!a.basicShown) {
      continue;
    }
    rows.push({
      tabId,
      frameId: NO_FRAME,
      windowId: a.windowId,
      basic: true,
      title: "",
      artist: "",
      album: "",
      artwork: "",
      playing: a.audible,
      pageMuted: false,
      actions: [],
      canPlay: false,
      canSeek: false,
      position: null,
      playedAt: a.playedAt,
    });
  }
  const present = new Set(rows.map((s) => s.tabId));
  mediaOrder = mediaOrder.filter((id) => present.has(id));
  // Новые — наверх: от старых к свежим, каждая следующая встаёт выше.
  const fresh = rows.filter((s) => !mediaOrder.includes(s.tabId)).sort((a, b) => a.playedAt - b.playedAt);
  for (const s of fresh) if (!mediaOrder.includes(s.tabId)) mediaOrder.unshift(s.tabId);
  return rows.sort((a, b) => mediaOrder.indexOf(a.tabId) - mediaOrder.indexOf(b.tabId) || a.frameId - b.frameId);
}

// Переставить строку вкладки tabId перед строкой вкладки beforeId (null — в конец).
function moveMedia(tabId, beforeId) {
  mediaList();
  if (!mediaOrder.includes(tabId) || tabId === beforeId) return false;
  mediaOrder = mediaOrder.filter((id) => id !== tabId);
  const at = beforeId === null ? -1 : mediaOrder.indexOf(beforeId);
  if (at === -1) mediaOrder.push(tabId);
  else mediaOrder.splice(at, 0, tabId);
  scheduleMediaBroadcast();
  return true;
}

function forgetMediaOfTab(tabId) {
  let changed = audibleTabs.delete(tabId);
  for (const [key, s] of mediaSessions) {
    if (s.tabId === tabId) changed = mediaSessions.delete(key) || changed;
  }
  mediaOrder = mediaOrder.filter((id) => id !== tabId);
  if (changed) scheduleMediaBroadcast();
}

function scheduleMediaBroadcast() {
  if (mediaBroadcastTimer) return;
  mediaBroadcastTimer = setTimeout(() => {
    mediaBroadcastTimer = null;
    // Нет открытых панелей — sendMessage отклоняется, это нормально.
    browser.runtime.sendMessage({ type: "mediaState", sessions: mediaList() }).catch(() => {});
  }, MEDIA_BROADCAST_MS);
}

// Уборка: замолчавшие фреймы и стихшие вкладки. Таймер живёт, только пока
// есть что убирать, — без звука фон не просыпается.
function sweepMedia(now = Date.now()) {
  let changed = false;
  for (const [key, s] of mediaSessions) {
    if (now - s.seenAt > MEDIA_DEAD_MS) changed = mediaSessions.delete(key) || changed;
    else if (now - s.seenAt > MEDIA_STALE_MS) checkSession(s);
  }
  for (const [tabId, a] of audibleTabs) {
    if (!a.audible && now - a.quietSince >= AUDIBLE_GRACE_MS) changed = audibleTabs.delete(tabId) || changed;
  }
  if (changed) scheduleMediaBroadcast();
  return mediaSessions.size > 0 || audibleTabs.size > 0;
}

function scheduleMediaSweep() {
  if (mediaSweepTimer) return;
  mediaSweepTimer = setTimeout(function tick() {
    mediaSweepTimer = null;
    if (sweepMedia()) mediaSweepTimer = setTimeout(tick, MEDIA_SWEEP_MS);
  }, MEDIA_SWEEP_MS);
}

function withTimeout(promise, ms) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => (timer = setTimeout(() => reject(new Error("timeout")), ms))),
  ]).finally(() => clearTimeout(timer));
}

const checking = new Set();

// Перезапрашивает состояние одного фрейма. Ответил — обновляется; скрипта
// нет (Firefox не нашёл получателя) — выбрасывается; не успел ответить —
// остаётся как был: занятая страница не значит умершая.
async function checkSession(s) {
  const key = s.tabId + ":" + s.frameId;
  if (checking.has(key)) return;
  checking.add(key);
  try {
    const reply = await withTimeout(
      browser.tabs.sendMessage(s.tabId, { type: "mediaQuery" }, { frameId: s.frameId }),
      MEDIA_QUERY_TIMEOUT_MS
    );
    // Пока ждали ответа, вкладку могли закрыть — не воскрешаем.
    if (mediaSessions.has(key)) {
      applyMediaState({ id: s.tabId, windowId: s.windowId }, s.frameId, reply && reply.state);
    }
  } catch (err) {
    if (!(err && err.message === "timeout")) applyMediaState({ id: s.tabId }, s.frameId, null);
  } finally {
    checking.delete(key);
  }
}

// Перезапрашивает состояние фреймов (всех или одной вкладки).
async function verifyMedia(tabId) {
  const targets = [...mediaSessions.values()].filter((s) => tabId === undefined || s.tabId === tabId);
  await Promise.all(targets.map(checkSession));
}

async function mediaControl(msg) {
  const key = msg.tabId + ":" + msg.frameId;
  const s = mediaSessions.get(key);
  const action = msg.action === "toggle" || MEDIA_ACTIONS.includes(msg.action) ? msg.action : null;
  if (!s || !action) {
    // Панель могла показать то, чего уже нет, — пусть получит правду.
    scheduleMediaBroadcast();
    return false;
  }
  try {
    const reply = await withTimeout(
      browser.tabs.sendMessage(s.tabId, { type: "mediaControl", action, seekTime: finiteOr(msg.seekTime, undefined) }, { frameId: s.frameId }),
      MEDIA_CONTROL_TIMEOUT_MS
    );
    applyMediaState({ id: s.tabId, windowId: s.windowId }, s.frameId, reply && reply.state);
    // Даже если ничего не изменилось: панель уже показала ожидаемое — исправит.
    scheduleMediaBroadcast();
    // Команда дошла, но сайт за отведённое время ничего не сделал.
    return reply && reply.reacted === false ? "ignored" : true;
  } catch (err) {
    // Скрипт фрейма пропал (страница ушла, а pagehide не дошёл) — забываем;
    // страница зависла — оставляем, но панели сообщаем, что не вышло.
    if (!(err && err.message === "timeout")) applyMediaState({ id: s.tabId }, s.frameId, null);
    scheduleMediaBroadcast();
    return false;
  }
}

function noteAudible(tab) {
  if (!tab || tab.incognito || !Number.isInteger(tab.id)) return;
  const prev = audibleTabs.get(tab.id);
  if (tab.audible) {
    const since = prev ? prev.since : Date.now();
    const basicShown = prev ? !!prev.basicShown : false;
    audibleTabs.set(tab.id, { windowId: tab.windowId, audible: true, since, basicShown, quietSince: 0, playedAt: Date.now() });
    // Простая строка (если скрипт так и промолчит) — по истечении задержки.
    if (!prev) setTimeout(scheduleMediaBroadcast, BASIC_ROW_DELAY_MS + 20);
  } else if (prev && prev.audible) {
    audibleTabs.set(tab.id, { ...prev, audible: false, quietSince: Date.now() });
    // Ровно по истечении паузы, а не на ближайшей плановой уборке.
    setTimeout(() => sweepMedia(), AUDIBLE_GRACE_MS + 50);
  } else {
    return;
  }
  scheduleMediaBroadcast();
  scheduleMediaSweep();
}

browser.tabs.onRemoved.addListener(forgetMediaOfTab);
browser.tabs.onReplaced.addListener((addedTabId, removedTabId) => forgetMediaOfTab(removedTabId));
browser.tabs.onUpdated.addListener(
  (tabId, changeInfo, tab) => {
    if (changeInfo.discarded === true) {
      forgetMediaOfTab(tabId);
      return;
    }
    if (changeInfo.audible !== undefined) {
      noteAudible(tab);
      // Звук появился или пропал — сверяемся со скриптами вкладки.
      verifyMedia(tabId);
    }
  },
  { properties: ["discarded", "audible"] }
);

// Вкладки, которые уже звучат на момент запуска фона.
browser.tabs
  .query({ audible: true })
  .then((tabs) => tabs.forEach(noteAudible))
  .catch((err) => console.error("[sidebar-tabs] failed to query audible tabs", err));

// Скрипт плеера из manifest.json попадает только в страницы, открытые после
// установки. В уже открытые (и после обновления расширения — старые копии
// скрипта при этом отключаются) внедряем его сами, один раз.
async function injectMediaIntoOpenTabs() {
  try {
    const tabs = await browser.tabs.query({ discarded: false, url: ["http://*/*", "https://*/*"] });
    await Promise.allSettled(
      tabs.map((t) =>
        browser.tabs.executeScript(t.id, { file: "/content/media.js", allFrames: true, matchAboutBlank: true, runAt: "document_end" })
      )
    );
  } catch (err) {
    console.error("[sidebar-tabs] failed to inject media script", err);
  }
}

if (browser.runtime.onInstalled) browser.runtime.onInstalled.addListener(injectMediaIntoOpenTabs);

browser.runtime.onMessage.addListener((msg, sender) => {
  if (!msg || typeof msg !== "object") return undefined;
  if (msg.type === "getVolumes") return Promise.resolve(Object.fromEntries(tabVolumes));
  if (msg.type === "setVolume" && Number.isInteger(msg.tabId)) return setTabVolume(msg.tabId, msg.volume);
  if (msg.type === "media") return void onMediaMessage(msg, sender);
  // Панель открылась — сначала сверка, потом ответ: никаких «призраков».
  if (msg.type === "getMedia") return verifyMedia().then(mediaList, mediaList);
  if (msg.type === "mediaMove" && Number.isInteger(msg.tabId)) {
    return Promise.resolve(moveMedia(msg.tabId, Number.isInteger(msg.beforeId) ? msg.beforeId : null));
  }
  if (msg.type === "mediaControl" && Number.isInteger(msg.tabId) && Number.isInteger(msg.frameId)) {
    return mediaControl(msg);
  }
  return undefined;
});

// Восстанавливает набор вкладок в указанном окне. Реальные страницы создаются
// "отложенными" (discarded) — появляются в списке сразу, но не грузятся, пока
// пользователь сам на них не переключится. "Новые вкладки" (about:newtab/blank/home)
// discarded НЕ ставим: у них и так нет контента для ленивой загрузки, а попытка
// создать такую вкладку отложенной иногда тихо отклонялась браузером — вкладка
// просто пропадала при восстановлении без всякой ошибки.
//
// Первая вкладка-заглушка окна (та, что уже открыта на старте) переиспользуется
// через tabs.update вместо create+remove — на один round-trip быстрее и без
// "мигания" лишней вкладкой перед тем, как она закроется.
async function restoreIntoWindow(windowId, tabsData, placeholderIds) {
  // originalIndex у каждого элемента — позиция в исходном tabsData. Нужен,
  // чтобы после создания вкладок можно было сопоставить их с группой, к
  // которой они принадлежали (см. restoreGroupsInWindow) — порядок и состав
  // "remaining" по пути меняется (заглушка выпадает, allSettled может частично
  // упасть), а исходный индекс остаётся единственным надёжным ключом.
  let remaining = tabsData.map((t, originalIndex) => ({ data: t, originalIndex }));
  let baseIndex = placeholderIds.length;
  const createdTabs = [];

  if (placeholderIds.length === 1 && tabsData.length > 0) {
    // Под заглушку берём именно ту вкладку, что была активна на момент сохранения
    // (не обязательно первую по индексу) — иначе после восстановления фокус
    // окажется не там, где был.
    const activeIdx = tabsData.findIndex((t) => t.active);
    const reuseIdx = activeIdx >= 0 ? activeIdx : 0;
    const reuseData = tabsData[reuseIdx];
    try {
      await browser.tabs.update(placeholderIds[0], {
        url: reuseData.url,
        pinned: !!reuseData.pinned,
        active: true,
      });
      createdTabs.push({ id: placeholderIds[0], active: true, reused: true, originalIndex: reuseIdx });
      remaining = remaining.filter((entry) => entry.originalIndex !== reuseIdx);
      baseIndex = 1;
    } catch (err) {
      console.error("[sidebar-tabs] failed to reuse placeholder tab", err);
    }
  }

  const results = await Promise.allSettled(
    remaining.map((entry, j) =>
      browser.tabs.create({
        windowId,
        url: entry.data.url,
        title: entry.data.title || entry.data.url,
        pinned: entry.data.pinned,
        active: false,
        discarded: !entry.data.active && !looksLikeFreshUrl(entry.data.url),
        index: baseIndex + j,
      })
    )
  );

  results.forEach((result, j) => {
    if (result.status === "fulfilled") {
      createdTabs.push({ id: result.value.id, active: remaining[j].data.active, originalIndex: remaining[j].originalIndex });
    } else {
      console.error("[sidebar-tabs] failed to restore tab", remaining[j].data.url, result.reason);
    }
  });

  const toActivate = createdTabs.find((t) => t.active) || createdTabs[0];
  if (toActivate && !toActivate.reused) {
    try {
      await browser.tabs.update(toActivate.id, { active: true });
    } catch (err) {
      // Все вкладки уже созданы — потерять фокус на нужной вкладке хуже,
      // чем не полностью, но не потерять всё окно из-за этой ошибки ниже.
      console.error("[sidebar-tabs] failed to activate restored tab", err);
    }
  }

  return createdTabs;
}

// Воссоздаёт группы вкладок в уже восстановленном окне. groupKey, сохранённый
// в снимке, привязан не к реальному Firefox groupId (тот одноразовый и после
// перезапуска не значит ничего), а к позиции в winData.groups — здесь он
// переводится обратно в id только что созданных вкладок.
async function restoreGroupsInWindow(winData, createdTabs, windowId) {
  if (!winData.groups || winData.groups.length === 0) return;
  if (typeof browser.tabs.group !== "function") return; // старый Firefox без API групп

  const tabIdsByGroupKey = new Map();
  for (const t of createdTabs) {
    const originalTab = winData.tabs[t.originalIndex];
    if (!originalTab || originalTab.groupKey === undefined) continue;
    if (!tabIdsByGroupKey.has(originalTab.groupKey)) tabIdsByGroupKey.set(originalTab.groupKey, []);
    tabIdsByGroupKey.get(originalTab.groupKey).push(t.id);
  }

  for (const [groupKey, tabIds] of tabIdsByGroupKey) {
    const meta = winData.groups[groupKey];
    if (!meta || tabIds.length === 0) continue;
    try {
      // В createProperties Firefox принимает только windowId — любое другое
      // поле (title, color) отклоняет весь вызов, и группа не создаётся.
      // Именно так группы и терялись после перезапуска: название и цвет
      // ставятся отдельным tabGroups.update уже созданной группе.
      const groupId = await browser.tabs.group(
        windowId === undefined ? { tabIds } : { tabIds, createProperties: { windowId } }
      );
      const props = {};
      if (typeof meta.title === "string") props.title = meta.title;
      if (typeof meta.color === "string") props.color = meta.color;
      if (meta.collapsed) props.collapsed = true;
      if (Object.keys(props).length && browser.tabGroups && typeof browser.tabGroups.update === "function") {
        try {
          await browser.tabGroups.update(groupId, props);
        } catch (err) {
          // Группа уже есть — без названия/цвета лучше, чем без группы.
          console.error("[sidebar-tabs] failed to set tab group properties", groupKey, err);
        }
      }
    } catch (err) {
      // Вкладки уже восстановлены и видны пользователю — потерять группировку
      // для них хуже, чем не полностью, но не потерять само окно из-за этого.
      console.error("[sidebar-tabs] failed to restore tab group", groupKey, err);
    }
  }
}

async function restoreSession(session, initialWindow) {
  isRestoring = true;
  try {
    for (let i = 0; i < session.windows.length; i++) {
      const winData = session.windows[i];
      if (winData.tabs.length === 0) continue;

      // Каждое окно восстанавливается независимо: сбой в одном окне (например,
      // не удалось создать browser.windows.create()) не должен обрывать
      // восстановление остальных окон сессии.
      try {
        const targetWindow = i === 0 ? initialWindow : await browser.windows.create({});
        const placeholderIds = (targetWindow.tabs || []).map((t) => t.id);

        const createdTabs = await restoreIntoWindow(targetWindow.id, winData.tabs, placeholderIds);

        const idsToClose = placeholderIds.filter((id) => !createdTabs.some((t) => t.reused && t.id === id));
        if (idsToClose.length > 0 && createdTabs.length > 0) {
          await browser.tabs.remove(idsToClose);
        }

        await restoreGroupsInWindow(winData, createdTabs, targetWindow.id);
      } catch (err) {
        console.error("[sidebar-tabs] failed to restore window", i, err);
      }
    }
  } catch (err) {
    // Страховка сверху: если сами данные сессии повреждены (не массив и т.п.),
    // ошибка возникнет ещё до входа в per-окно try — сюда, а не наружу к вызывающему.
    console.error("[sidebar-tabs] restore failed", err);
  } finally {
    isRestoring = false;
  }
}

// При запуске браузера: если окно выглядит "пустым" (одна новая вкладка) и есть
// сохранённая резервная копия, автоматически разворачиваем её. Storage и текущие
// окна запрашиваются параллельно (не последовательно) — меньше времени до старта
// восстановления, восстановление ощущается быстрее.
async function checkAndRestoreOnStartup() {
  try {
    const early = startupStored;
    startupStored = null;
    const [stored, windows] = await Promise.all([
      (early && (await early)) || browser.storage.local.get(STORAGE_KEY),
      browser.windows.getAll({ populate: true }),
    ]);

    const session = stored[STORAGE_KEY];
    const hasBackup = session && session.windows && session.windows.some((w) => w.tabs.length > 0);

    // Считаем только обычные окна — devtools/popup/panel окно, случайно
    // открытое при старте, не должно мешать признать состояние "свежим".
    const normalWindows = windows.filter((w) => w.type === "normal");
    const singleFreshWindow =
      normalWindows.length === 1 &&
      (normalWindows[0].tabs || []).length <= 1 &&
      (normalWindows[0].tabs || []).every((t) => looksLikeFreshUrl(t.url));

    if (singleFreshWindow && hasBackup) {
      await restoreSession(session, normalWindows[0]);
    }
  } catch (err) {
    console.error("[sidebar-tabs] auto-restore check failed", err);
  }

  runSave();
}

browser.runtime.onStartup.addListener(checkAndRestoreOnStartup);

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    STORAGE_KEY,
    SAVE_DEBOUNCE_MS,
    SAVE_MAX_WAIT_MS,
    RESTORABLE_SCHEMES,
    isRestorableUrl,
    looksLikeFreshUrl,
    isTransientTab,
    captureWindow,
    captureSession,
    runSave,
    scheduleSave,
    restoreIntoWindow,
    restoreGroupsInWindow,
    restoreSession,
    checkAndRestoreOnStartup,
    FAVICONS_KEY,
    FAVICONS_MAX,
    FAVICONS_SAVE_MS,
    FAVICON_MAX_LENGTH,
    faviconHost,
    rememberFavicon,
    _faviconsLoaded: faviconsLoaded,
    setTabVolume,
    clampVolume,
    volumeScript,
    _getTabVolumes: () => tabVolumes,
    onMediaMessage,
    applyMediaState,
    mediaList,
    mediaControl,
    verifyMedia,
    sweepMedia,
    noteAudible,
    sanitizeMedia,
    moveMedia,
    MEDIA_BROADCAST_MS,
    MEDIA_STALE_MS,
    MEDIA_DEAD_MS,
    AUDIBLE_GRACE_MS,
    BASIC_ROW_DELAY_MS,
    NO_FRAME,
    _getMediaSessions: () => mediaSessions,
    _getFavicons: () => favicons,
    _getIsRestoring: () => isRestoring,
    _getLastSavedSerialized: () => lastSavedSerialized,
    SAVE_RETRY_MS,
    SAVE_RETRY_MAX,
    mediaChanged,
    _resetState: () => {
      isRestoring = false;
      lastSavedSerialized = null;
      pendingSince = null;
      favicons = new Map();
      tabVolumes.clear();
      mediaSessions.clear();
      checking.clear();
      audibleTabs.clear();
      mediaOrder = [];
      if (mediaSweepTimer) {
        clearTimeout(mediaSweepTimer);
        mediaSweepTimer = null;
      }
      if (mediaBroadcastTimer) {
        clearTimeout(mediaBroadcastTimer);
        mediaBroadcastTimer = null;
      }
      if (faviconsTimer) {
        clearTimeout(faviconsTimer);
        faviconsTimer = null;
      }
      if (saveTimer) {
        clearTimeout(saveTimer);
        saveTimer = null;
      }
      if (saveRetryTimer) {
        clearTimeout(saveRetryTimer);
        saveRetryTimer = null;
      }
      saveRunning = null;
      saveAgain = false;
      saveFailures = 0;
      startupStored = null;
    },
  };
}
