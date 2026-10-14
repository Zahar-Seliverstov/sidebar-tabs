#!/usr/bin/env node
"use strict";

/*
 * Сквозные тесты плеера в настоящем Firefox (без зависимостей).
 *
 *   npm run e2e                       — все сценарии
 *   npm run e2e -- next pause         — только сценарии, в названии которых есть эти слова
 *   FIREFOX=/путь/к/firefox npm run e2e
 *
 * Что делает: копирует расширение во временную папку, дописывает в фон
 * e2e/hook.js, ставит копию во временный профиль (без подписи — нужен
 * Firefox Developer Edition / Nightly), запускает Firefox без окна,
 * поднимает HTTP-сервер с e2e/pages и прогоняет сценарии: открывает
 * страницы, жмёт кнопки плеера, проверяет, что фон показывает правду.
 *
 * Звук. Признак «вкладка звучит» (tab.audible) Firefox ставит, только когда
 * звук реально уходит в аудиосистему. Поэтому, если есть pactl
 * (PulseAudio/PipeWire), на время тестов создаётся пустой выход
 * (module-null-sink), и тестовый Firefox играет в него — динамики и
 * наушники молчат, системный выход по умолчанию не меняется. Без pactl
 * звук глушится внутри Firefox, а сценарии про tab.audible пропускаются.
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { spawn } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..");
const PAGES = path.join(__dirname, "pages");
const FIREFOX = process.env.FIREFOX || "firefox-developer-edition";
const EXT_ID = "minimal-tab-bar@local.ext";
const SHIP = ["manifest.json", "background.js", "content", "sidebar", "icons", "plugins"];
const STEP_TIMEOUT_MS = 6000;

// ---------------------------------------------------------------- сервер

let latest = null;
const commands = [];
const results = new Map();
const pageLog = [];
let nextCmdId = 1;

const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8" };

function readBody(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => resolve(data));
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname === "/hook/state") {
    latest = JSON.parse(await readBody(req));
    return res.end("ok");
  }
  if (url.pathname === "/hook/cmd") {
    res.setHeader("content-type", "application/json");
    return res.end(JSON.stringify(commands.shift() || {}));
  }
  if (url.pathname === "/hook/result") {
    const r = JSON.parse(await readBody(req));
    results.set(r.id, r);
    return res.end("ok");
  }
  if (url.pathname === "/hook/error") {
    console.error("  [hook]", await readBody(req));
    return res.end("ok");
  }
  if (url.pathname === "/page-log") {
    pageLog.push(decodeURIComponent(url.search.slice(1)));
    return res.end("ok");
  }
  const file = path.join(PAGES, path.normalize(url.pathname).replace(/^(\.\.[/\\])+/, ""));
  if (!file.startsWith(PAGES) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.statusCode = 404;
    return res.end("not found");
  }
  res.setHeader("content-type", TYPES[path.extname(file)] || "application/octet-stream");
  fs.createReadStream(file).pipe(res);
});

// ---------------------------------------------------------------- управление

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function cmd(op, args = {}) {
  const id = nextCmdId++;
  commands.push({ id, op, ...args });
  const start = Date.now();
  while (!results.has(id)) {
    if (Date.now() - start > STEP_TIMEOUT_MS) throw new Error(`команда ${op} не выполнена за ${STEP_TIMEOUT_MS} мс`);
    await sleep(20);
  }
  const r = results.get(id);
  results.delete(id);
  if (!r.ok) throw new Error(`${op}: ${r.error}`);
  return r.value;
}

// Ждёт, пока predicate(состояние) не вернёт истину; describe — что ждём (для ошибки).
async function waitFor(describe, predicate, timeout = STEP_TIMEOUT_MS) {
  const start = Date.now();
  let last;
  while (Date.now() - start < timeout) {
    if (latest) {
      last = latest;
      const value = predicate(latest);
      if (value) return value;
    }
    await sleep(50);
  }
  const audible = last ? last.tabs.filter((t) => t.audible).map((t) => t.id) : [];
  throw new Error(`не дождались: ${describe}\n    последние строки плеера: ${JSON.stringify(summary(last))}\n    звучащие вкладки: ${JSON.stringify(audible)}`);
}

// Утверждение, которое должно держаться всё время в течение ms (против мигания).
async function holds(describe, predicate, ms) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (latest && !predicate(latest)) {
      throw new Error(`нарушено: ${describe}\n    строки плеера: ${JSON.stringify(summary(latest))}`);
    }
    await sleep(40);
  }
}

function summary(state) {
  return state ? state.sessions.map((s) => ({ tab: s.tabId, frame: s.frameId, title: s.title, playing: s.playing, basic: !!s.basic, late: !!s.late, actions: s.actions, plugins: s.plugins })) : null;
}

const rowsOf = (state, tabId) => state.sessions.filter((s) => s.tabId === tabId);
const rowOf = (state, tabId) => rowsOf(state, tabId)[0];

let origin;
const page = (name, query = "") => `${origin}/${name}.html${query ? "?" + query : ""}`;

async function openPage(name, query) {
  return cmd("open", { url: page(name, query) });
}

// ---------------------------------------------------------------- сценарии

const scenarios = [];
// needsAudible — сценарий опирается на tab.audible (нужен пустой аудиовыход).
const scenario = (name, fn, opts = {}) => scenarios.push({ name, fn, ...opts });

scenario("плеер вне документа с треком и кнопками сайта: строка с названием, играет, есть «следующий»", async () => {
  const tab = await openPage("player", "mode=detached&meta=1&handlers=1");
  const row = await waitFor("строка играющего трека", (s) => {
    const r = rowOf(s, tab);
    return r && r.playing && r.title === "Трек 1" && r;
  });
  if (!row.actions.includes("nexttrack")) throw new Error("нет кнопки «следующий»: " + row.actions);
  await cmd("close", { tabId: tab });
});

scenario("пауза и воспроизведение кнопкой: состояние из ответа страницы", async () => {
  const tab = await openPage("player", "mode=detached&meta=1&handlers=1");
  const row = await waitFor("играет", (s) => rowOf(s, tab)?.playing && rowOf(s, tab));
  const ok = await cmd("control", { tabId: tab, frameId: row.frameId, action: "toggle" });
  if (!ok) throw new Error("команда не дошла до страницы");
  await waitFor("на паузе", (s) => rowOf(s, tab)?.playing === false);
  await holds("остаётся на паузе", (s) => rowOf(s, tab)?.playing === false, 1200);
  await cmd("control", { tabId: tab, frameId: row.frameId, action: "toggle" });
  await waitFor("снова играет", (s) => rowOf(s, tab)?.playing === true);
  await cmd("close", { tabId: tab });
});

scenario("следующий трек новым плеером: название меняется, плеер не «встаёт на паузу»", async () => {
  const tab = await openPage("player", "mode=detached&meta=1&handlers=1&newPerTrack=1");
  const row = await waitFor("играет", (s) => rowOf(s, tab)?.playing && rowOf(s, tab));
  await cmd("control", { tabId: tab, frameId: row.frameId, action: "nexttrack" });
  await waitFor("трек 2", (s) => rowOf(s, tab)?.title === "Трек 2");
  await holds("трек 2 играет без мигания паузы", (s) => rowOf(s, tab)?.playing === true, 1500);
  await cmd("close", { tabId: tab });
});

scenario("следующий трек в том же плеере (смена src)", async () => {
  const tab = await openPage("player", "mode=dom&meta=1&handlers=1");
  const row = await waitFor("играет", (s) => rowOf(s, tab)?.playing && rowOf(s, tab));
  await cmd("control", { tabId: tab, frameId: row.frameId, action: "nexttrack" });
  await waitFor("трек 2", (s) => rowOf(s, tab)?.title === "Трек 2");
  await holds("трек 2 играет", (s) => rowOf(s, tab)?.playing === true, 1500);
  await cmd("close", { tabId: tab });
});

scenario("страница сама ставит на паузу — панель это видит", async () => {
  const tab = await openPage("player", "mode=detached&meta=1&handlers=1");
  await waitFor("играет", (s) => rowOf(s, tab)?.playing);
  await cmd("page", { tabId: tab, fn: "pause" });
  await waitFor("на паузе", (s) => rowOf(s, tab)?.playing === false);
  await cmd("close", { tabId: tab });
});

scenario("выключение звука кнопкой сайта: строка остаётся", async () => {
  const tab = await openPage("player", "mode=dom&meta=1&handlers=1");
  await waitFor("играет", (s) => rowOf(s, tab)?.playing);
  await cmd("page", { tabId: tab, fn: "mute" });
  await sleep(800);
  await holds("строка на месте и играет", (s) => rowOf(s, tab)?.playing === true, 1000);
  await cmd("close", { tabId: tab });
});

scenario("сайт игнорирует команду: панель показывает правду (играет), а не ожидание", async () => {
  const tab = await openPage("player", "mode=detached&meta=1&handlers=1&ignore=1");
  const row = await waitFor("играет", (s) => rowOf(s, tab)?.playing && rowOf(s, tab));
  await cmd("control", { tabId: tab, frameId: row.frameId, action: "toggle" });
  await holds("всё ещё играет", (s) => rowOf(s, tab)?.playing === true, 1500);
  await cmd("close", { tabId: tab });
});

scenario("плеер в документе без Media Session: строка, пауза работает напрямую", async () => {
  const tab = await openPage("player", "mode=dom");
  const row = await waitFor("играет", (s) => rowOf(s, tab)?.playing && !rowOf(s, tab).basic && rowOf(s, tab));
  await cmd("control", { tabId: tab, frameId: row.frameId, action: "toggle" });
  await waitFor("на паузе", (s) => rowOf(s, tab)?.playing === false);
  await cmd("close", { tabId: tab });
});

scenario("уход со страницы: строка исчезает", async () => {
  const tab = await openPage("player", "mode=detached&meta=1&handlers=1");
  await waitFor("играет", (s) => rowOf(s, tab)?.playing);
  await cmd("navigate", { tabId: tab, url: page("blank") });
  await waitFor("строки нет", (s) => rowsOf(s, tab).length === 0);
  await holds("и не появляется", (s) => rowsOf(s, tab).length === 0, 1500);
  await cmd("close", { tabId: tab });
});

scenario("закрытие вкладки: строка исчезает", async () => {
  const tab = await openPage("player", "mode=dom&meta=1");
  await waitFor("играет", (s) => rowOf(s, tab)?.playing);
  await cmd("close", { tabId: tab });
  await waitFor("строки нет", (s) => rowsOf(s, tab).length === 0);
});

scenario("выгрузка вкладки: строка исчезает", async () => {
  const tab = await openPage("player", "mode=dom&meta=1");
  await waitFor("играет", (s) => rowOf(s, tab)?.playing);
  await cmd("discard", { tabId: tab });
  await waitFor("строки нет", (s) => rowsOf(s, tab).length === 0);
  await cmd("close", { tabId: tab });
});

scenario("служебный: Firefox видит звук вкладки (tab.audible)", async () => {
  const tab = await openPage("player", "mode=dom&meta=1");
  await waitFor("вкладка звучит", (s) => s.tabs.find((t) => t.id === tab)?.audible);
  await cmd("close", { tabId: tab });
}, { needsAudible: true });

scenario("короткие звуки интерфейса не показываются", async () => {
  const tab = await openPage("sfx");
  await sleep(2500);
  await holds("нет настоящей строки", (s) => !rowsOf(s, tab).some((r) => !r.basic), 1000);
  await cmd("close", { tabId: tab });
});

scenario("беззвучное автовоспроизведение (превью) не показывается", async () => {
  const tab = await openPage("player", "mode=video&muted=1&loop=1");
  await sleep(2000);
  await holds("строки нет", (s) => rowsOf(s, tab).length === 0, 1000);
  await cmd("close", { tabId: tab });
});

scenario("Web Audio без плеера: простая строка, пока вкладка звучит; стихла — уходит", async () => {
  const tab = await openPage("webaudio");
  await waitFor("простая строка", (s) => rowOf(s, tab)?.basic && rowOf(s, tab).playing);
  await cmd("page", { tabId: tab, fn: "stop" });
  await waitFor("строка ушла", (s) => rowsOf(s, tab).length === 0, 8000);
  await cmd("close", { tabId: tab });
}, { needsAudible: true });

scenario("плеер внутри пустого (about:blank) фрейма", async () => {
  const tab = await openPage("iframe");
  await waitFor("строка фрейма", (s) => rowsOf(s, tab).some((r) => !r.basic && r.frameId !== 0 && r.playing));
  await cmd("close", { tabId: tab });
});

scenario("открытие панели (getMedia) не показывает «призраков» и сохраняет живые строки", async () => {
  const tab = await openPage("player", "mode=detached&meta=1&handlers=1");
  await waitFor("играет", (s) => rowOf(s, tab)?.playing);
  const list = await cmd("getMedia");
  if (!list.some((r) => r.tabId === tab && r.playing)) throw new Error("живая строка пропала: " + JSON.stringify(list));
  await cmd("close", { tabId: tab });
});

scenario("занятая страница (поток подолгу занят): строка не пропадает при сверке", async () => {
  const tab = await openPage("player", "mode=detached&meta=1&handlers=1&busy=1500");
  await waitFor("играет", (s) => rowOf(s, tab)?.playing);
  for (let i = 0; i < 4; i++) {
    const list = await cmd("getMedia");
    if (!list.some((r) => r.tabId === tab && !r.basic)) throw new Error(`сверка №${i + 1} выбросила живую строку: ` + JSON.stringify(summary({ sessions: list })));
    await sleep(500);
  }
  await cmd("close", { tabId: tab });
});

scenario("медленный сайт: команда ждёт реакции, ответ — уже новое состояние", async () => {
  const tab = await openPage("player", "mode=detached&meta=1&handlers=1&slow=900");
  const row = await waitFor("играет", (s) => rowOf(s, tab)?.playing && rowOf(s, tab));
  await cmd("control", { tabId: tab, frameId: row.frameId, action: "toggle" });
  // Ответ на команду — уже после реакции сайта: сразу «на паузе».
  const now = rowOf(latest, tab);
  await waitFor("на паузе", (s) => rowOf(s, tab)?.playing === false, 600);
  if (now && now.playing) {
    await holds("на паузе без отката", (s) => rowOf(s, tab)?.playing === false, 1000);
  }
  await cmd("close", { tabId: tab });
});

scenario("обновление расширения при играющей музыке: строка возвращается, кнопки сайта честно помечены", async () => {
  const tab = await openPage("player", "mode=detached&meta=1&handlers=1");
  await waitFor("играет с «следующим»", (s) => rowOf(s, tab)?.playing && rowOf(s, tab).actions.includes("nexttrack"));
  const before = latest.at;
  await cmd("reloadExt");
  await waitFor("фон перезапустился", (s) => s.at > before + 500, 15000);
  const row = await waitFor("строка с треком вернулась", (s) => rowOf(s, tab) && !rowOf(s, tab).basic && rowOf(s, tab), 8000);
  if (!row.actions.includes("nexttrack")) {
    throw new Error("кнопки сайта пропали после обновления: " + JSON.stringify(summary({ sessions: [row] })));
  }
  await cmd("control", { tabId: tab, frameId: row.frameId, action: "nexttrack" });
  await waitFor("«следующий» после обновления работает", (s) => rowOf(s, tab)?.title === "Трек 2");
  await cmd("close", { tabId: tab });
});

scenario("обновление расширения: плагин подключается к уже открытой странице сайта", async () => {
  const LIKE = "e2e-like/like";
  const tab = await openPage("player", "mode=dom&meta=1&handlers=1&like=1");
  await waitFor("кнопка плагина", (s) => rowOf(s, tab)?.plugins?.[LIKE] === false);
  const before = latest.at;
  await cmd("reloadExt");
  await waitFor("фон перезапустился", (s) => s.at > before + 500, 15000);
  const row = await waitFor("кнопка плагина вернулась", (s) => rowOf(s, tab)?.plugins?.[LIKE] === false && rowOf(s, tab), 8000).catch((e) => { throw new Error(e.message + "\nDBG " + JSON.stringify(latest.dbg)); });
  await cmd("control", { tabId: tab, frameId: row.frameId, action: "plugin:" + LIKE });
  await waitPage("нажатие дошло до сайта", tab, (st) => st.liked);
  await cmd("close", { tabId: tab });
});

// ---------------------------------------------------------------- сценарии панели
//
// Настоящая панель (sidebar.html) в отдельном окне: проверяем то, что видит
// и нажимает пользователь, а не только состояние фона.

let panelOpened = false;
async function ensurePanel() {
  if (!panelOpened) {
    await cmd("uiOpen");
    panelOpened = true;
  }
}

async function waitUi(describe, predicate, timeout = STEP_TIMEOUT_MS) {
  const start = Date.now();
  let rows;
  while (Date.now() - start < timeout) {
    rows = await cmd("uiPlayer");
    const value = predicate(rows);
    if (value) return value;
    await sleep(80);
  }
  throw new Error(`панель: не дождались: ${describe}\n    строки панели: ${JSON.stringify(rows)}`);
}

async function waitPage(describe, tabId, predicate, timeout = STEP_TIMEOUT_MS) {
  const start = Date.now();
  let st;
  while (Date.now() - start < timeout) {
    st = await cmd("pageState", { tabId });
    if (predicate(st)) return st;
    await sleep(80);
  }
  throw new Error(`страница: не дождались: ${describe}\n    состояние: ${JSON.stringify(st)}`);
}

scenario("панель: кнопка паузы в строке реально ставит страницу на паузу, значок меняется", async () => {
  await ensurePanel();
  const tab = await openPage("player", "mode=detached&meta=1&handlers=1");
  await waitUi("строка с паузой", (rows) => rows.find((r) => r.tab === tab && r.playIcon === "pause" && r.title === "Трек 1"));
  await cmd("uiClick", { selector: `.pr[data-tab="${tab}"] .pl-play` });
  await waitPage("пауза на странице", tab, (st) => st.paused);
  await waitUi("значок «играть»", (rows) => rows.find((r) => r.tab === tab && r.playIcon === "play"));
  await cmd("uiClick", { selector: `.pr[data-tab="${tab}"] .pl-play` });
  await waitPage("снова играет", tab, (st) => !st.paused);
  await waitUi("значок «пауза»", (rows) => rows.find((r) => r.tab === tab && r.playIcon === "pause"));
  await cmd("close", { tabId: tab });
});

scenario("панель: сайт проигнорировал паузу — значок возвращается к правде", async () => {
  await ensurePanel();
  const tab = await openPage("player", "mode=detached&meta=1&handlers=1&ignore=1");
  await waitUi("строка с паузой", (rows) => rows.find((r) => r.tab === tab && r.playIcon === "pause"));
  await cmd("uiClick", { selector: `.pr[data-tab="${tab}"] .pl-play` });
  // Пульт ждёт реакции сайта до 1,5 с, потом показывает правду и говорит, что сайт не отреагировал.
  await waitUi("значок снова «пауза» (играет) и подсказка", (rows) => rows.find((r) => r.tab === tab && r.playIcon === "pause" && !r.pending && /не отреагировал/.test(r.note)), 4000);
  await cmd("close", { tabId: tab });
});

scenario("панель: колесо на себя (вниз) над громкостью — громче, от себя (вверх) — тише", async () => {
  await ensurePanel();
  const tab = await openPage("player", "mode=detached&meta=1&handlers=1");
  await waitUi("строка", (rows) => rows.find((r) => r.tab === tab));
  const sel = `.pr[data-tab="${tab}"] .vexp`;
  await cmd("uiWheel", { selector: sel, deltaY: -100 });
  await sleep(300);
  const quieter = await cmd("tabVolume", { tabId: tab });
  if (Math.abs(quieter - 0.95) > 1e-9) throw new Error("колесо вверх: ожидалось 0.95, стало " + quieter);
  await cmd("uiWheel", { selector: sel, deltaY: 100 });
  await sleep(300);
  const louder = await cmd("tabVolume", { tabId: tab });
  if (louder !== 1) throw new Error("колесо вниз: ожидалось 1, стало " + louder);
  await cmd("close", { tabId: tab });
});

scenario("панель: медленный сайт — значок паузы не откатывается, пока сайт думает", async () => {
  await ensurePanel();
  const tab = await openPage("player", "mode=detached&meta=1&handlers=1&slow=900");
  await waitUi("играет", (rows) => rows.find((r) => r.tab === tab && r.playIcon === "pause"));
  await cmd("uiClick", { selector: `.pr[data-tab="${tab}"] .pl-play` });
  const seen = [];
  const start = Date.now();
  while (Date.now() - start < 2200) {
    const r = (await cmd("uiPlayer")).find((x) => x.tab === tab);
    seen.push(r ? r.playIcon + (r.pending ? "*" : "") : "-");
    await sleep(60);
  }
  const icons = seen.map((x) => x.replace("*", ""));
  const first = icons.indexOf("play");
  if (first === -1 || icons.slice(first).includes("pause")) throw new Error("значок прыгал: " + seen.join(" "));
  if (!seen.some((x) => x.endsWith("*"))) throw new Error("не было видно, что команда выполняется: " + seen.join(" "));
  await waitPage("страница на паузе", tab, (st) => st.paused);
  await cmd("close", { tabId: tab });
});

scenario("панель: недоступная кнопка объясняет, почему", async () => {
  await ensurePanel();
  const tab = await openPage("player", "mode=dom&meta=1");
  await waitUi("строка без «следующего»", (rows) => rows.find((r) => r.tab === tab && r.center && r.nextHidden));
  await cmd("uiClick", { selector: '#deck [data-act="nexttrack"]' });
  await waitUi("подсказка", (rows) => rows.find((r) => r.tab === tab && /не даёт переключать/.test(r.note)));
  await cmd("close", { tabId: tab });
});

scenario("панель: Web Audio — простая строка без кнопок сайта", async () => {
  await ensurePanel();
  const tab = await openPage("webaudio");
  await waitUi("простая строка", (rows) => rows.find((r) => r.tab === tab && r.playHidden && r.prevHidden && r.nextHidden));
  await cmd("close", { tabId: tab });
}, { needsAudible: true });

scenario("панель: закрыли вкладку — строки нет", async () => {
  await ensurePanel();
  const tab = await openPage("player", "mode=dom&meta=1");
  await waitUi("строка", (rows) => rows.find((r) => r.tab === tab));
  await cmd("close", { tabId: tab });
  await waitUi("строки нет", (rows) => !rows.some((r) => r.tab === tab));
});

// ---------------------------------------------------------------- микрофон
//
// Поддельный микрофон Firefox даёт ровный тон, страница mic.html меряет
// громкость того, что получила. Громкость сравниваем с исходной по отношению.

const micOn = (s, tab) => s.tabs.find((t) => t.id === tab)?.mic;

async function openCall(query) {
  const tab = await openPage("mic", query);
  const st = await waitPage("сайт слышит микрофон", tab, (x) => x.rms > 0.01);
  await waitFor("Firefox видит микрофон вкладки", (s) => micOn(s, tab)).catch((e) => {
    throw new Error(e.message + "\n    sharing: " + JSON.stringify(latest.tabs.find((t) => t.id === tab)) + " page: " + JSON.stringify(st));
  });
  return { tab, base: st.rms };
}

scenario("микрофон: тише, выключить, включить — доходит до сайта", async () => {
  const { tab, base } = await openCall();
  if (!(await cmd("setMic", { tabId: tab, volume: 0.3 }))) throw new Error("настройка не применилась");
  await waitPage("в ~0.3 раза тише", tab, (x) => Math.abs(x.rms / base - 0.3) < 0.06);
  await cmd("setMic", { tabId: tab, muted: true });
  await waitPage("тишина", tab, (x) => x.rms < 0.001);
  await cmd("setMic", { tabId: tab, muted: false, volume: 1 });
  await waitPage("снова как было", tab, (x) => Math.abs(x.rms / base - 1) < 0.1);
  await cmd("close", { tabId: tab });
});

scenario("микрофон: для сайта дорожка выглядит настоящей, камера проходит как есть", async () => {
  const { tab } = await openCall("video=1");
  const st = await cmd("pageState", { tabId: tab });
  if (!st.label || !st.deviceId) throw new Error("нет label/deviceId: " + JSON.stringify(st));
  if (st.kinds.join() !== "audio,video") throw new Error("дорожки: " + st.kinds);
  await cmd("close", { tabId: tab });
});

scenario("микрофон: сайт остановил дорожку — микрофон освобождён", async () => {
  const { tab } = await openCall();
  await cmd("page", { tabId: tab, fn: "stop" });
  await waitFor("Firefox больше не видит микрофон", (s) => !micOn(s, tab));
  if (await cmd("setMic", { tabId: tab, volume: 0.5 })) throw new Error("настройка «применилась» к остановленному микрофону");
  await cmd("setMic", { tabId: tab, volume: 1 });
  await cmd("close", { tabId: tab });
});

scenario("микрофон: клон живёт после остановки оригинала, его остановка освобождает микрофон", async () => {
  const { tab, base } = await openCall();
  await cmd("setMic", { tabId: tab, volume: 0.5 });
  await cmd("page", { tabId: tab, fn: "cloneAndStop" });
  await sleep(300);
  await waitPage("клон звучит и слушается громкости", tab, (x) => Math.abs(x.rms / base - 0.5) < 0.08);
  if (!micOn(latest, tab)) throw new Error("микрофон освобождён раньше времени");
  await cmd("page", { tabId: tab, fn: "stop" });
  await waitFor("микрофон освобождён", (s) => !micOn(s, tab));
  await cmd("close", { tabId: tab });
});

scenario("микрофон: настройка вкладки переживает перезагрузку страницы", async () => {
  const { tab, base } = await openCall();
  await cmd("setMic", { tabId: tab, volume: 0.25 });
  await cmd("navigate", { tabId: tab, url: page("mic") + "?again=1" });
  await waitPage("новый захват сразу тише", tab, (x) => x.rms > 0 && Math.abs(x.rms / base - 0.25) < 0.06);
  await cmd("close", { tabId: tab });
});

async function waitControl(describe, selector, predicate) {
  const start = Date.now();
  let c;
  while (Date.now() - start < STEP_TIMEOUT_MS) {
    c = await cmd("uiControl", { selector });
    if (c && predicate(c)) return c;
    await sleep(80);
  }
  throw new Error(`панель: не дождались: ${describe}\n    регулятор: ${JSON.stringify(c)}`);
}

scenario("панель: значок микрофона — клик выключает, колесо меняет громкость, конец звонка прячет", async () => {
  await ensurePanel();
  const { tab, base } = await openCall();
  const sel = `[data-key="t${tab}"] .mic`;
  await waitControl("значок микрофона виден", sel, (c) => c.shown && c.icon === "mic" && !c.muted);
  await cmd("uiClick", { selector: sel + " .vicon" });
  await waitControl("значок «выключен»", sel, (c) => c.icon === "mic-off" && c.muted);
  await waitPage("сайт слышит тишину", tab, (x) => x.rms < 0.001);
  // Колесо от себя у выключенного — остаётся выключенным; на себя — включает на 5%.
  await cmd("uiWheel", { selector: sel + " .vicon", deltaY: 100 });
  await waitControl("включён на 5%", sel, (c) => c.icon === "mic" && c.pct === "5%");
  await waitPage("сайт слышит ~5%", tab, (x) => Math.abs(x.rms / base - 0.05) < 0.03);
  await cmd("page", { tabId: tab, fn: "stop" });
  await waitControl("значок спрятан", sel, (c) => !c.shown);
  await cmd("close", { tabId: tab });
});

scenario("панель: у вкладки со звонком видны и микрофон, и звук", async () => {
  await ensurePanel();
  for (const query of ["play=1", ""]) {
    const { tab } = await openCall(query);
    const row = `[data-key="t${tab}"]`;
    await waitControl("значок микрофона", row + " .mic", (c) => c.shown);
    await waitControl("значок звука (" + (query || "тихий звонок") + ")", row + " .audio", (c) => c.shown);
    await cmd("close", { tabId: tab });
  }
}, { needsAudible: true });

// ---------------------------------------------------------------- плагины

const LIKE = "e2e-like/like";

scenario("плагин: кнопка сайта в строке плеера, нажатие доходит до сайта и возвращает новое состояние", async () => {
  const tab = await openPage("player", "mode=dom&meta=1&handlers=1&like=1");
  const row = await waitFor("строка с кнопкой плагина", (s) => rowOf(s, tab)?.plugins?.[LIKE] === false && rowOf(s, tab));
  if ((await cmd("control", { tabId: tab, frameId: row.frameId, action: "plugin:" + LIKE })) !== true) {
    throw new Error("команда плагина не подтвердилась");
  }
  if (rowOf(latest, tab)?.plugins?.[LIKE] !== true) await waitFor("кнопка активна", (s) => rowOf(s, tab)?.plugins?.[LIKE] === true);
  await waitPage("сайт отметил «нравится»", tab, (st) => st.liked);
  await cmd("close", { tabId: tab });
});

scenario("плагин: выключили — кнопки нет; включили — появляется без перезагрузки страницы", async () => {
  const tab = await openPage("player", "mode=dom&meta=1&handlers=1&like=1");
  await waitFor("кнопка есть", (s) => rowOf(s, tab)?.plugins?.[LIKE] === false);
  await cmd("setPlugin", { plugin: "e2e-like", enabled: false });
  try {
    await waitFor("кнопки нет", (s) => rowOf(s, tab) && !(LIKE in rowOf(s, tab).plugins));
    const other = await openPage("player", "mode=dom&meta=1&handlers=1&like=1");
    await waitFor("строка новой вкладки", (s) => rowOf(s, other)?.playing);
    await holds("в новой вкладке плагин не подключён", (s) => !(LIKE in (rowOf(s, other)?.plugins || {})), 1000);
    await cmd("close", { tabId: other });
  } finally {
    await cmd("setPlugin", { plugin: "e2e-like", enabled: true });
  }
  await waitFor("кнопка вернулась", (s) => rowOf(s, tab)?.plugins?.[LIKE] === false);
  await cmd("close", { tabId: tab });
});

scenario("панель: кнопка плагина в строке плеера — значок плагина, нажатие меняет его", async () => {
  await ensurePanel();
  const tab = await openPage("player", "mode=dom&meta=1&handlers=1&like=1");
  await waitUi("строка в центре", (rows) => rows.find((r) => r.tab === tab && r.center));
  const sel = `.pr[data-tab="${tab}"] [data-key="${LIKE}"]`;
  await waitControlPlain("кнопка в пульте", sel, (b) => b && !b.on && /like\.svg/.test(b.icon) && b.title === "Нравится");
  await cmd("uiClick", { selector: sel });
  await waitControlPlain("кнопка активна", sel, (b) => b && b.on && /liked\.svg/.test(b.icon) && b.title === "Уже нравится");
  await waitPage("сайт отметил", tab, (st) => st.liked);
  await cmd("close", { tabId: tab });
});

const VK = "vk-favorite/add";

for (const [name, query] of [["блок плеера", ""], ["только список треков", "noplayer=1"]]) {
  scenario(`плагин ВК (${name}): кнопка про играющий трек, а не про первую строку`, async () => {
    const tab = await openPage("vk", query);
    const row = await waitFor("кнопка «в мою музыку» не нажата", (s) => rowOf(s, tab)?.plugins?.[VK] === false && rowOf(s, tab));
    await cmd("control", { tabId: tab, frameId: row.frameId, action: "plugin:" + VK });
    const st = await waitPage("Seabird добавлен", tab, (x) => x.Seabird === true);
    if (st["Другой трек"] !== true || st["Ещё один"] !== false) throw new Error("задеты чужие треки: " + JSON.stringify(st));
    await waitFor("кнопка нажата", (s) => rowOf(s, tab)?.plugins?.[VK] === true);
    await cmd("close", { tabId: tab });
  });
}

async function waitControlPlain(describe, selector, predicate) {
  const start = Date.now();
  let b;
  while (Date.now() - start < STEP_TIMEOUT_MS) {
    b = await cmd("uiButton", { selector });
    if (predicate(b)) return b;
    await sleep(80);
  }
  throw new Error(`панель: не дождались: ${describe}\n    кнопка: ${JSON.stringify(b)}`);
}

// ---------------------------------------------------------------- запуск

// Пустой аудиовыход на время тестов. Возвращает функцию удаления или null.
function createNullSink() {
  const { spawnSync } = require("node:child_process");
  const r = spawnSync("pactl", ["load-module", "module-null-sink", "sink_name=tabbar_e2e", "sink_properties=device.description=tab-bar-e2e"], {
    encoding: "utf8",
  });
  if (r.status !== 0) return null;
  const id = r.stdout.trim();
  let removed = false;
  return () => {
    if (removed) return;
    removed = true;
    spawnSync("pactl", ["unload-module", id]);
  };
}

function prepare(nullSink) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tab-bar-e2e-"));
  const ext = path.join(tmp, "ext");
  const profile = path.join(tmp, "profile");
  fs.mkdirSync(ext);
  fs.mkdirSync(path.join(profile, "extensions"), { recursive: true });
  for (const item of SHIP) fs.cpSync(path.join(ROOT, item), path.join(ext, item), { recursive: true });
  fs.copyFileSync(path.join(__dirname, "hook.js"), path.join(ext, "e2e-hook.js"));
  fs.writeFileSync(path.join(ext, "e2e-config.js"), `const E2E_ORIGIN = ${JSON.stringify(origin)};\n`);
  // Тестовый плагин — как настоящий, в папке plugins/ копии расширения.
  fs.cpSync(path.join(__dirname, "plugin"), path.join(ext, "plugins", "e2e-like"), { recursive: true });
  const index = JSON.parse(fs.readFileSync(path.join(ext, "plugins", "index.json"), "utf8"));
  fs.writeFileSync(path.join(ext, "plugins", "index.json"), JSON.stringify([...index, "e2e-like"]));
  // Плагин ВК — ещё и на тестовом сервере (страница vk.html повторяет разметку ВК).
  const vkJson = path.join(ext, "plugins", "vk-favorite", "plugin.json");
  const vk = JSON.parse(fs.readFileSync(vkJson, "utf8"));
  vk.matches.push("http://127.0.0.1/*");
  fs.writeFileSync(vkJson, JSON.stringify(vk));
  const manifest = JSON.parse(fs.readFileSync(path.join(ext, "manifest.json"), "utf8"));
  manifest.background.scripts.push("e2e-config.js", "e2e-hook.js");
  fs.writeFileSync(path.join(ext, "manifest.json"), JSON.stringify(manifest, null, 2));
  // Распакованное расширение: файл-указатель с путём к папке.
  fs.writeFileSync(path.join(profile, "extensions", EXT_ID), ext + "\n");
  fs.writeFileSync(
    path.join(profile, "user.js"),
    [
      ["xpinstall.signatures.required", false],
      ["extensions.autoDisableScopes", 0],
      ["extensions.enabledScopes", 15],
      ["media.autoplay.default", 0],
      ["media.autoplay.blocking_policy", 0],
      ["media.autoplay.block-webaudio", false],
      ["media.cubeb.force_null_context", !nullSink],
      // Микрофон и камера — поддельные (тон и картинка), без запроса разрешения.
      ["media.navigator.streams.fake", true],
      ["media.navigator.permission.fake", true],
      ["permissions.default.microphone", 1],
      ["permissions.default.camera", 1],
      ["browser.shell.checkDefaultBrowser", false],
      ["browser.startup.homepage_override.mstone", "ignore"],
      ["datareporting.policy.dataSubmissionEnabled", false],
      ["toolkit.telemetry.reportingpolicy.firstRun", false],
      ["browser.aboutwelcome.enabled", false],
    ]
      .map(([k, v]) => `user_pref(${JSON.stringify(k)}, ${JSON.stringify(v)});`)
      .join("\n")
  );
  return { tmp, profile };
}

async function main() {
  const filters = process.argv.slice(2).map((f) => f.toLowerCase());
  const selected = scenarios.filter((s) => !filters.length || filters.some((f) => s.name.toLowerCase().includes(f)));

  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  origin = `http://127.0.0.1:${server.address().port}`;
  const removeSink = createNullSink();
  const cleanupSink = () => removeSink && removeSink();
  process.on("SIGINT", () => {
    cleanupSink();
    process.exit(130);
  });
  const { tmp, profile } = prepare(!!removeSink);

  const env = removeSink ? { ...process.env, PULSE_SINK: "tabbar_e2e" } : process.env;
  const ff = spawn(FIREFOX, ["--headless", "--no-remote", "--profile", profile, "about:blank"], { stdio: "ignore", env });
  let failed = 0;
  let skipped = 0;
  try {
    await waitFor("фон расширения отозвался", () => true, 30000);
    for (const s of selected) {
      if (s.needsAudible && !removeSink) {
        skipped++;
        console.log(`  – ${s.name} (пропущен: нет pactl для пустого аудиовыхода)`);
        continue;
      }
      const start = Date.now();
      pageLog.length = 0;
      try {
        await s.fn();
        console.log(`  ✔ ${s.name} (${Date.now() - start} мс)`);
      } catch (err) {
        failed++;
        console.log(`  ✖ ${s.name}\n    ${err.message}`);
        if (pageLog.length) console.log("    журнал страницы:\n      " + pageLog.join("\n      "));
        await cmd("cleanup").catch(() => {});
      }
    }
  } finally {
    ff.kill();
    server.close();
    await sleep(500);
    cleanupSink();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  const ran = selected.length - skipped;
  console.log(`\n${ran - failed} из ${ran} сценариев прошли` + (skipped ? `, ${skipped} пропущено` : ""));
  process.exitCode = failed ? 1 : 0;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
