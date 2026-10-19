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

// Общая логика: в браузере эти файлы подключены в манифесте раньше фона,
// в node (тесты) — берутся через require.
const inNode = typeof module !== "undefined" && module.exports;
const Settings = inNode ? require("./shared/settings.js") : globalThis.SidebarSettings;
const Model = inNode ? require("./sidebar/model.js") : { duplicatesToClose, stepRate, DEFAULT_STORE };

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

function isContainerStore(id) {
  return typeof id === "string" && id !== "" && id !== Model.DEFAULT_STORE && id !== "firefox-private";
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
      // Контейнер Firefox: без него вкладка вернулась бы с чужими куки (не
      // в том аккаунте). Обычные вкладки поле не получают — снимок не растёт.
      if (isContainerStore(tab.cookieStoreId)) entry.cookieStoreId = tab.cookieStoreId;

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

// ---------------------------------------------------------------- микрофон
//
// Громкость и выключение микрофона вкладки применяет content/mic.js (там же —
// как это устроено). Здесь — только настройки: tabId → { volume, muted },
// пока вкладка открыта. Новый захват в любом фрейме спрашивает настройку
// сам ("micGet"), поэтому она переживает и перезагрузку, и новый звонок.

const micSettings = new Map();

function micOf(tabId) {
  return micSettings.get(tabId) || { volume: 1, muted: false };
}

// Ответ — применилось ли: хоть один фрейм вкладки держит живой микрофон.
async function setTabMic(tabId, change) {
  const prev = micOf(tabId);
  const next = {
    volume: change && change.volume !== undefined ? clampVolume(change.volume) : prev.volume,
    muted: change && change.muted !== undefined ? !!change.muted : prev.muted,
  };
  if (next.volume >= 1 && !next.muted) micSettings.delete(tabId);
  else micSettings.set(tabId, next);
  // Микрофон меняют не только из панели (горячая клавиша) — панели узнают.
  browser.runtime.sendMessage({ type: "micState", mic: Object.fromEntries(micSettings) }).catch(() => {});
  try {
    const reply = await browser.tabs.sendMessage(tabId, { type: "micSet", ...next });
    return !!(reply && reply.live);
  } catch (err) {
    return false;
  }
}

browser.tabs.onRemoved.addListener((tabId) => micSettings.delete(tabId));
browser.tabs.onReplaced.addListener((addedTabId, removedTabId) => {
  if (!micSettings.has(removedTabId)) return;
  micSettings.set(addedTabId, micSettings.get(removedTabId));
  micSettings.delete(removedTabId);
});

// ---------------------------------------------------------------- плагины
//
// Плагин — папка plugins/<id>/ внутри расширения (список — plugins/index.json):
//
//   plugin.json  { name, description, matches: [шаблоны URL], js: [файлы],
//                  allFrames?, enabled? (по умолчанию включён),
//                  buttons: [{ id, title, activeTitle?, icon, activeIcon? }] }
//   page.js      поведение кнопок через SidebarTabs (см. content/plugin-api.js)
//
// Кнопки встают в пульт плеера, когда в строке плеера вкладка с сайта
// плагина. Включённые плагины подключаются через contentScripts.register —
// только на своих сайтах; выключенные ничего не стоят. Выключение не
// выгружает уже подключённую копию (это невозможно) — её кнопки просто
// перестают показываться до перезагрузки страницы.

const PLUGIN_ID = /^[a-z0-9-]{1,40}$/;
const PLUGINS_KEY = "pluginsEnabled";
// id → { id, name, description, matches, js, allFrames, buttons, enabled, handle }
const plugins = new Map();
let pluginsReady = null;

function pluginUrl(id, file) {
  return browser.runtime.getURL(`plugins/${id}/${file}`);
}

// plugin.json пишет автор плагина — проверяем форму, лишнее отбрасываем.
function parsePlugin(id, raw) {
  const str = (v) => (typeof v === "string" ? v.slice(0, 200) : "");
  const file = (v) => typeof v === "string" && /^[\w.-]+$/.test(v);
  if (!raw || typeof raw !== "object") throw new Error("plugin.json не объект");
  const matches = Array.isArray(raw.matches) ? raw.matches.filter((m) => typeof m === "string") : [];
  const js = Array.isArray(raw.js) ? raw.js.filter(file) : [];
  if (!matches.length || !js.length) throw new Error("нужны matches и js");
  const buttons = (Array.isArray(raw.buttons) ? raw.buttons : [])
    .filter((b) => b && PLUGIN_ID.test(b.id) && file(b.icon))
    .map((b) => ({
      key: id + "/" + b.id,
      title: str(b.title) || b.id,
      activeTitle: str(b.activeTitle) || str(b.title) || b.id,
      icon: pluginUrl(id, b.icon),
      activeIcon: pluginUrl(id, file(b.activeIcon) ? b.activeIcon : b.icon),
    }));
  return {
    id,
    name: str(raw.name) || id,
    description: str(raw.description),
    matches,
    js,
    allFrames: raw.allFrames === true,
    defaultEnabled: raw.enabled !== false,
    buttons,
    enabled: false,
    handle: null,
  };
}

async function loadPlugins() {
  const index = await (await fetch(browser.runtime.getURL("plugins/index.json"))).json();
  const stored = (await browser.storage.local.get(PLUGINS_KEY))[PLUGINS_KEY] || {};
  for (const id of Array.isArray(index) ? index : []) {
    if (!PLUGIN_ID.test(id) || plugins.has(id)) continue;
    try {
      const p = parsePlugin(id, await (await fetch(pluginUrl(id, "plugin.json"))).json());
      plugins.set(id, p);
      const on = typeof stored[id] === "boolean" ? stored[id] : p.defaultEnabled;
      // И в уже открытые вкладки: фон стартует и после установки/обновления
      // расширения, когда страницы сайта давно открыты (onInstalled на это
      // полагаться нельзя — при перезапуске расширения он не приходит).
      if (on) await enablePlugin(p, true);
    } catch (err) {
      console.error(`[sidebar-tabs] plugin ${id} not loaded`, err);
    }
  }
}

function pluginScripts(p) {
  return ["/content/plugin-api.js", ...p.js.map((f) => `/plugins/${p.id}/${f}`)];
}

// intoOpenTabs — включили из панели: подключаем и в уже открытые вкладки.
async function enablePlugin(p, intoOpenTabs) {
  if (p.enabled) return;
  p.enabled = true;
  p.handle = await browser.contentScripts.register({
    matches: p.matches,
    js: pluginScripts(p).map((file) => ({ file })),
    runAt: "document_idle",
    allFrames: p.allFrames,
  });
  if (intoOpenTabs) await injectPluginIntoOpenTabs(p);
}

// Уже открытые вкладки сайта плагина: contentScripts.register действует
// только на страницы, загруженные после него. Подключиться дважды плагин
// не может: код плагина SidebarTabs выполняет один раз на страницу.
async function injectPluginIntoOpenTabs(p) {
  const tabs = await browser.tabs.query({ url: p.matches, discarded: false });
  for (const t of tabs) {
    // Копия, выключенная раньше, ещё жива — достаточно включить её обратно.
    browser.tabs.sendMessage(t.id, { type: "pluginEnabled", id: p.id, enabled: true }).catch(() => {});
    try {
      const [loaded] = await browser.tabs.executeScript(t.id, {
        code: `!!(window.__mtbPlugins && window.__mtbPlugins.loaded.has(${JSON.stringify(p.id)}))`,
      });
      if (loaded) continue;
      for (const file of pluginScripts(p)) {
        await browser.tabs.executeScript(t.id, { file, allFrames: p.allFrames });
      }
    } catch (err) {
      // Вкладка закрылась или страница служебная — пропускаем.
    }
  }
}

async function disablePlugin(p) {
  if (!p.enabled) return;
  p.enabled = false;
  if (p.handle) await p.handle.unregister().catch(() => {});
  p.handle = null;
  const tabs = await browser.tabs.query({ url: p.matches });
  for (const t of tabs) browser.tabs.sendMessage(t.id, { type: "pluginEnabled", id: p.id, enabled: false }).catch(() => {});
}

async function setPluginEnabled(id, enabled) {
  await pluginsReady;
  const p = plugins.get(id);
  if (!p) return false;
  if (enabled) await enablePlugin(p, true);
  else await disablePlugin(p);
  const stored = (await browser.storage.local.get(PLUGINS_KEY))[PLUGINS_KEY] || {};
  stored[id] = !!enabled;
  await browser.storage.local.set({ [PLUGINS_KEY]: stored });
  // Кнопки выключенного плагина исчезают из плеера сразу.
  for (const s of mediaSessions.values()) s.plugins = sanitizePluginButtons(s.plugins);
  scheduleMediaBroadcast();
  return true;
}

function pluginList() {
  return [...plugins.values()].map((p) => ({
    id: p.id,
    name: p.name,
    description: p.description,
    enabled: p.enabled,
    buttons: p.buttons,
  }));
}

function findPluginButton(key) {
  const p = plugins.get(String(key).split("/")[0]);
  return p && p.enabled ? p.buttons.find((b) => b.key === key) || null : null;
}

function isPluginAction(action) {
  return typeof action === "string" && action.startsWith("plugin:") && !!findPluginButton(action.slice(7));
}

// От страницы: только кнопки включённых плагинов, значения — true/false.
function sanitizePluginButtons(raw) {
  const out = {};
  if (!raw || typeof raw !== "object") return out;
  for (const key of Object.keys(raw).slice(0, 20)) {
    if (findPluginButton(key)) out[key] = raw[key] === true;
  }
  return out;
}

pluginsReady = browser.contentScripts
  ? loadPlugins().catch((err) => console.error("[sidebar-tabs] plugins not loaded", err))
  : Promise.resolve();

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
const MEDIA_VISIBLE_KEYS = ["windowId", "title", "artist", "album", "artwork", "playing", "pageMuted", "canPlay", "canSeek", "late", "live", "rate", "canRate"];
const RATE_LIMITS = [0.0625, 16];
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
    rate: Math.min(RATE_LIMITS[1], Math.max(RATE_LIMITS[0], finiteOr(state.rate, 1))),
    canRate: state.canRate === true,
    plugins: sanitizePluginButtons(state.plugins),
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
  if (JSON.stringify(prev.plugins) !== JSON.stringify(next.plugins)) return true;
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
      rate: 1,
      canRate: false,
      position: null,
      plugins: {},
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
  const rate = finiteOr(msg.rate, NaN);
  const action =
    msg.action === "toggle" || MEDIA_ACTIONS.includes(msg.action) || isPluginAction(msg.action) ||
    (msg.action === "rate" && rate >= RATE_LIMITS[0] && rate <= RATE_LIMITS[1])
      ? msg.action
      : null;
  if (!s || !action) {
    // Панель могла показать то, чего уже нет, — пусть получит правду.
    scheduleMediaBroadcast();
    return false;
  }
  try {
    const reply = await withTimeout(
      browser.tabs.sendMessage(
        s.tabId,
        { type: "mediaControl", action, seekTime: finiteOr(msg.seekTime, undefined), ...(action === "rate" ? { rate } : {}) },
        { frameId: s.frameId }
      ),
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
        ["/content/media.js", "/content/mic.js"].map((file) =>
          browser.tabs.executeScript(t.id, { file, allFrames: true, matchAboutBlank: true, runAt: "document_end" })
        )
      ).flat()
    );
  } catch (err) {
    console.error("[sidebar-tabs] failed to inject media script", err);
  }
}

if (browser.runtime.onInstalled) browser.runtime.onInstalled.addListener(injectMediaIntoOpenTabs);

// ---------------------------------------------------------------- настройки
//
// Меняет их страница настроек (options/), читают фон и панели — каждый сам
// из storage, с подпиской на изменения. См. shared/settings.js.

let settings = Settings.normalizeSettings(null);

const settingsReady = browser.storage.local
  .get(Settings.SETTINGS_KEY)
  .then((stored) => applySettings(stored && stored[Settings.SETTINGS_KEY]))
  .catch((err) => console.error("[sidebar-tabs] failed to read settings", err));

function applySettings(raw) {
  const prevRules = JSON.stringify(settings.groupRules);
  settings = Settings.normalizeSettings(raw);
  if (JSON.stringify(settings.groupRules) !== prevRules) return seedRuleMatches();
  return undefined;
}

if (browser.storage.onChanged) {
  browser.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes[Settings.SETTINGS_KEY]) applySettings(changes[Settings.SETTINGS_KEY].newValue);
  });
}

// ---------------------------------------------------------------- автогруппировка
//
// Правило (адрес → название группы, см. shared/settings.js) срабатывает,
// когда вкладка ОТКРЫВАЕТ подходящую страницу: на переходе, после которого
// вкладке подходит другое правило, чем до него. Поэтому:
//   - вкладку, которую вынули из группы руками, правило обратно не тянет,
//     пока она ходит по тому же сайту;
//   - вкладки, открытые до появления правила, не трогаются (для них есть
//     «Применить к открытым вкладкам» на странице настроек);
//   - вкладка уже в группе (своей или той, куда Firefox поместил ссылку из
//     группы) остаётся, где есть; закреплённые не группируются.
// Группа ищется по названию в окне вкладки, нет такой — создаётся. Операции
// идут по одной: две вкладки одного сайта, открытые разом, попадают в одну
// группу, а не создают две одинаковые.

// tabId → ключ правила, подходившего вкладке в последний раз ("" — никакое).
const ruleMatches = new Map();
let ruleQueue = Promise.resolve();

function hasTabGroups() {
  return typeof browser.tabs.group === "function" && !!browser.tabGroups;
}

function ruleKey(url) {
  const rule = Settings.matchGroupRule(settings.groupRules, url);
  return rule ? rule.pattern + "\n" + rule.group : "";
}

// Запомнить, что подходит открытым вкладкам сейчас, ничего не делая.
async function seedRuleMatches() {
  ruleMatches.clear();
  if (settings.groupRules.length === 0) return;
  try {
    for (const tab of await browser.tabs.query({})) ruleMatches.set(tab.id, ruleKey(tab.url));
  } catch (err) {
    console.error("[sidebar-tabs] failed to read tabs for group rules", err);
  }
}

// created — вкладка только что создана. Вкладка, которой мы ещё не знаем
// и которая не новая (была открыта до запуска фона), только запоминается:
// иначе при старте браузера правила разложили бы всю прошлую сессию.
function onTabUrl(tab, created) {
  if (!tab || !Number.isInteger(tab.id) || settings.groupRules.length === 0) return;
  const known = ruleMatches.has(tab.id);
  const prev = ruleMatches.get(tab.id);
  const key = ruleKey(tab.url);
  ruleMatches.set(tab.id, key);
  // Восстановление сессии воссоздаёт группы само — не вмешиваемся.
  if (!key || isRestoring || (known ? key === prev : !created)) return;
  enqueueGroupRule(tab.id);
}

function enqueueGroupRule(tabId) {
  const run = ruleQueue.then(() => applyGroupRule(tabId));
  ruleQueue = run.catch(() => {});
  return run;
}

// Поместить вкладку в группу её правила. Состояние берётся свежим: пока
// ждали очереди, вкладку могли закрыть, сгруппировать или увести.
async function applyGroupRule(tabId) {
  if (!hasTabGroups()) return false;
  try {
    const tab = await browser.tabs.get(tabId);
    if (tab.pinned || (tab.groupId !== undefined && tab.groupId !== -1)) return false;
    const rule = Settings.matchGroupRule(settings.groupRules, tab.url);
    if (!rule) return false;
    const groups = await browser.tabGroups.query({ windowId: tab.windowId });
    const existing = Settings.findRuleGroup(groups, rule);
    // Пока ждали tabGroups.query, вкладку могли сгруппировать без нас:
    // панель, открывая страницу в другом контейнере, создаёт вкладку
    // и сразу кладёт её в группу исходной — правило не должно её уводить.
    // Поэтому прямо перед tabs.group смотрим на вкладку ещё раз. Гонку это
    // сужает до одного шага, но не убирает: между tabs.get и tabs.group
    // вкладку всё равно могут сгруппировать, а атомарного «сгруппировать,
    // если ещё не в группе» у API нет.
    if (!(await stillUngrouped(tab.id))) return false;
    if (existing) {
      await browser.tabs.group({ tabIds: [tab.id], groupId: existing.id });
      return true;
    }
    // Как и при восстановлении: в createProperties — только windowId,
    // название и цвет ставятся отдельно.
    const groupId = await browser.tabs.group({ tabIds: [tab.id], createProperties: { windowId: tab.windowId } });
    await browser.tabGroups.update(groupId, { title: rule.group, color: rule.color });
    return true;
  } catch (err) {
    // Вкладку закрыли, окно не умеет группы (всплывающее) — не страшно.
    return false;
  }
}

// Вкладка всё ещё не в группе и не закреплена (свежие данные из Firefox).
async function stillUngrouped(tabId) {
  const tab = await browser.tabs.get(tabId);
  return !tab.pinned && (tab.groupId === undefined || tab.groupId === -1);
}

// «Применить к открытым вкладкам»: все незакреплённые вкладки вне групп.
// Ответ — сколько вкладок разложено по группам.
async function applyGroupRulesToOpenTabs() {
  await settingsReady;
  // Страница настроек шлёт сообщение сразу после записи правил, а
  // storage.onChanged может прийти позже него — читаем правила сами.
  // Если они поменялись, applySettings заново запоминает, что подходит
  // открытым вкладкам (seedRuleMatches), — дожидаемся и этого.
  try {
    const stored = await browser.storage.local.get(Settings.SETTINGS_KEY);
    await applySettings(stored && stored[Settings.SETTINGS_KEY]);
  } catch (err) {
    console.error("[sidebar-tabs] failed to read settings", err);
  }
  if (!hasTabGroups() || settings.groupRules.length === 0) return 0;
  const tabs = await browser.tabs.query({ pinned: false });
  let moved = 0;
  for (const tab of tabs) {
    if (tab.groupId !== undefined && tab.groupId !== -1) continue;
    if (!Settings.matchGroupRule(settings.groupRules, tab.url)) continue;
    if (await enqueueGroupRule(tab.id)) moved++;
  }
  return moved;
}

browser.tabs.onUpdated.addListener(
  (tabId, changeInfo, tab) => {
    if (changeInfo.url !== undefined) onTabUrl(tab, false);
  },
  { properties: ["url"] }
);
browser.tabs.onCreated.addListener((tab) => {
  // Отложенная вкладка (восстановление, перенос окна) ничего не открывает.
  if (tab.discarded) {
    if (settings.groupRules.length) ruleMatches.set(tab.id, ruleKey(tab.url));
  } else {
    onTabUrl(tab, true);
  }
});
browser.tabs.onRemoved.addListener((tabId) => ruleMatches.delete(tabId));

// ---------------------------------------------------------------- горячие клавиши
//
// Команды объявлены в manifest.json ("commands"); сочетания пользователь
// меняет на странице настроек или в about:addons. Работают и при закрытой
// панели, поэтому живут здесь, а не в ней.

const COMMANDS = {
  "toggle-mic": toggleCallMic,
  "media-toggle": () => commandMedia("toggle"),
  "media-next": () => commandMedia("nexttrack"),
  "media-prev": () => commandMedia("previoustrack"),
  "speed-up": () => commandRate((r) => Model.stepRate(r, 1)),
  "speed-down": () => commandRate((r) => Model.stepRate(r, -1)),
  "speed-reset": () => commandRate(() => 1),
  "close-duplicates": closeDuplicatesInWindow,
};

function runCommand(name, tab) {
  const fn = COMMANDS[name];
  if (!fn) return Promise.resolve(false);
  return Promise.resolve(fn(tab)).catch((err) => {
    console.error("[sidebar-tabs] command failed", name, err);
    return false;
  });
}

// Микрофон звонка — из любой вкладки: идёт звонок в фоне, а под рукой
// другая страница. Если хоть один микрофон включён — выключаем все, иначе
// включаем все.
async function toggleCallMic() {
  const tabs = (await browser.tabs.query({})).filter((t) => t.sharingState && t.sharingState.microphone);
  if (tabs.length === 0) return false;
  const muted = tabs.some((t) => !micOf(t.id).muted);
  await Promise.all(tabs.map((t) => setTabMic(t.id, { muted })));
  return true;
}

// Строка плеера для команды: играющая, иначе верхняя.
function commandSession(fits) {
  const rows = mediaList().filter((s) => !s.basic && fits(s));
  return rows.find((s) => s.playing) || rows[0] || null;
}

function commandMedia(action) {
  const s = commandSession((x) => (action === "toggle" ? x.canPlay : x.actions.includes(action)));
  if (!s) return false;
  return mediaControl({ tabId: s.tabId, frameId: s.frameId, action });
}

function commandRate(next) {
  const s = commandSession((x) => x.canRate);
  if (!s) return false;
  return mediaControl({ tabId: s.tabId, frameId: s.frameId, action: "rate", rate: next(s.rate) });
}

// Закрыть дубликаты в окне вкладки, где нажали сочетание.
async function closeDuplicatesInWindow(tab) {
  const windowId = tab && Number.isInteger(tab.windowId) ? tab.windowId : (await browser.windows.getLastFocused()).id;
  const ids = Model.duplicatesToClose(await browser.tabs.query({ windowId }));
  if (ids.length) await browser.tabs.remove(ids);
  return ids.length;
}

if (browser.commands && browser.commands.onCommand) browser.commands.onCommand.addListener(runCommand);

browser.runtime.onMessage.addListener((msg, sender) => {
  if (!msg || typeof msg !== "object") return undefined;
  if (msg.type === "getVolumes") return Promise.resolve(Object.fromEntries(tabVolumes));
  if (msg.type === "setVolume" && Number.isInteger(msg.tabId)) return setTabVolume(msg.tabId, msg.volume);
  if (msg.type === "getMic") return Promise.resolve(Object.fromEntries(micSettings));
  if (msg.type === "setMic" && Number.isInteger(msg.tabId)) return setTabMic(msg.tabId, msg);
  if (msg.type === "micGet") return Promise.resolve(sender.tab ? micOf(sender.tab.id) : null);
  if (msg.type === "getPlugins") return pluginsReady.then(pluginList);
  if (msg.type === "setPlugin" && typeof msg.id === "string") return setPluginEnabled(msg.id, msg.enabled === true);
  if (msg.type === "media") return void onMediaMessage(msg, sender);
  // Панель открылась — сначала сверка, потом ответ: никаких «призраков».
  if (msg.type === "getMedia") return verifyMedia().then(mediaList, mediaList);
  if (msg.type === "mediaMove" && Number.isInteger(msg.tabId)) {
    return Promise.resolve(moveMedia(msg.tabId, Number.isInteger(msg.beforeId) ? msg.beforeId : null));
  }
  if (msg.type === "mediaControl" && Number.isInteger(msg.tabId) && Number.isInteger(msg.frameId)) {
    return mediaControl(msg);
  }
  if (msg.type === "applyGroupRules") return applyGroupRulesToOpenTabs();
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

  // Под заглушку берём именно ту вкладку, что была активна на момент сохранения
  // (не обязательно первую по индексу) — иначе после восстановления фокус
  // окажется не там, где был. Вкладку контейнера — нет: контейнер у открытой
  // вкладки не сменить, такую создаём заново.
  const activeIdx = tabsData.findIndex((t) => t.active);
  const reuseIdx = activeIdx >= 0 ? activeIdx : 0;
  if (placeholderIds.length === 1 && tabsData.length > 0 && !isContainerStore(tabsData[reuseIdx].cookieStoreId)) {
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
      createRestoredTab({
        windowId,
        url: entry.data.url,
        title: entry.data.title || entry.data.url,
        pinned: entry.data.pinned,
        active: false,
        discarded: !entry.data.active && !looksLikeFreshUrl(entry.data.url),
        index: baseIndex + j,
        ...(isContainerStore(entry.data.cookieStoreId) ? { cookieStoreId: entry.data.cookieStoreId } : {}),
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

// Контейнер мог исчезнуть (удалили, выключили контейнеры) — тогда вкладка
// возвращается обычной: страница важнее контейнера.
function createRestoredTab(props) {
  return browser.tabs.create(props).catch((err) => {
    if (!props.cookieStoreId) throw err;
    console.error("[sidebar-tabs] container is gone, restoring tab without it", props.cookieStoreId, err);
    const { cookieStoreId, ...rest } = props;
    return browser.tabs.create(rest);
  });
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
    setTabMic,
    _getMicSettings: () => micSettings,
    parsePlugin,
    sanitizePluginButtons,
    isPluginAction,
    _getPlugins: () => plugins,
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
    isContainerStore,
    applySettings,
    settingsReady,
    seedRuleMatches,
    onTabUrl,
    applyGroupRule,
    applyGroupRulesToOpenTabs,
    runCommand,
    _getSettings: () => settings,
    _getRuleMatches: () => ruleMatches,
    _resetState: () => {
      settings = Settings.normalizeSettings(null);
      ruleMatches.clear();
      ruleQueue = Promise.resolve();
      isRestoring = false;
      lastSavedSerialized = null;
      pendingSince = null;
      favicons = new Map();
      tabVolumes.clear();
      micSettings.clear();
      plugins.clear();
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
