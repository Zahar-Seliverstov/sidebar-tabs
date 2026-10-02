"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createMockBrowser, loadBackground } = require("./mock-browser.js");

// Фон держит таймер уборки, пока есть строки, — после каждого теста гасим,
// иначе процесс node --test не завершится.
let current = null;
test.afterEach(() => {
  if (current) current._resetState();
  current = null;
});

function setup() {
  const browser = createMockBrowser();
  browser.runtime.sendMessage = async (msg) => {
    browser.__broadcasts.push(msg);
  };
  browser.__broadcasts = [];
  browser.__sent = [];
  browser.tabs.sendMessage = async (tabId, msg, opts) => {
    browser.__sent.push([tabId, msg, opts]);
    if (browser.__tabsSendMessageImpl) return browser.__tabsSendMessageImpl(tabId, msg, opts);
  };
  const bg = loadBackground(browser);
  bg._resetState();
  current = bg;
  return { browser, bg };
}

function send(browser, msg, sender = {}) {
  const results = browser.runtime.onMessage.handlers.map((fn) => fn(msg, sender));
  return results.find((r) => r !== undefined);
}

const sender = (tabId, frameId = 0, extra = {}) => ({ tab: { id: tabId, windowId: 1, incognito: false, ...extra }, frameId });

const playingState = {
  meta: { title: "Песня", artist: "Исполнитель", album: "", artwork: "https://x/art.jpg" },
  playing: true,
  actions: ["play", "pause", "nexttrack", "evil"],
  canPlay: true,
  canSeek: true,
  position: { duration: 200, position: 30, rate: 1 },
};

test("media: состояние фрейма сохраняется очищенным и попадает в список", async () => {
  const { browser, bg } = setup();
  send(browser, { type: "media", state: playingState }, sender(5, 0));
  const [s] = bg.mediaList();
  assert.equal(s.tabId, 5);
  assert.equal(s.title, "Песня");
  assert.deepEqual(s.actions, ["play", "pause", "nexttrack"], "неизвестные действия отбрасываются");
  assert.equal(s.position.duration, 200);
  assert.ok(s.playedAt > 0);
  assert.deepEqual(await send(browser, { type: "getMedia" }), bg.mediaList());
});

test("media: трек, который ни разу не играл, не показывается; пауза помнит, когда играл", () => {
  const { browser, bg } = setup();
  send(browser, { type: "media", state: { ...playingState, playing: false } }, sender(5));
  assert.equal(bg.mediaList().length, 0);
  send(browser, { type: "media", state: playingState }, sender(5));
  const playedAt = bg.mediaList()[0].playedAt;
  send(browser, { type: "media", state: { ...playingState, playing: false } }, sender(5));
  assert.equal(bg.mediaList()[0].playedAt, playedAt);
  assert.equal(bg.mediaList()[0].playing, false);
});

test("media: пустое состояние, закрытие и выгрузка вкладки убирают плеер", async () => {
  const { browser, bg } = setup();
  send(browser, { type: "media", state: playingState }, sender(5, 0));
  send(browser, { type: "media", state: playingState }, sender(5, 3));
  send(browser, { type: "media", state: playingState }, sender(6, 0));
  send(browser, { type: "media", state: null }, sender(5, 3));
  assert.equal(bg.mediaList().length, 2);
  await browser.tabs.onRemoved.emit(5, { windowId: 1 });
  assert.deepEqual(bg.mediaList().map((s) => s.tabId), [6]);
  await browser.tabs.onUpdated.emit(6, { discarded: true }, { id: 6 });
  assert.equal(bg.mediaList().length, 0);
});

test("media: приватные вкладки и сообщения не от вкладок игнорируются, мусорная обложка отбрасывается", () => {
  const { browser, bg } = setup();
  send(browser, { type: "media", state: playingState }, sender(5, 0, { incognito: true }));
  send(browser, { type: "media", state: playingState }, {});
  assert.equal(bg.mediaList().length, 0);
  send(browser, { type: "media", state: { ...playingState, meta: { title: 1, artwork: "javascript:alert(1)" } } }, sender(7));
  const [s] = bg.mediaList();
  assert.equal(s.title, "");
  assert.equal(s.artwork, "");
});

test("media: изменения рассылаются панелям одним сообщением", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { browser, bg } = setup();
  send(browser, { type: "media", state: playingState }, sender(5));
  send(browser, { type: "media", state: playingState }, sender(6));
  t.mock.timers.tick(bg.MEDIA_BROADCAST_MS);
  await Promise.resolve();
  assert.equal(browser.__broadcasts.length, 1);
  assert.equal(browser.__broadcasts[0].type, "mediaState");
  assert.equal(browser.__broadcasts[0].sessions.length, 2);
});

test("mediaControl: команда уходит в нужный фрейм; пропавший фрейм забывается", async () => {
  const { browser, bg } = setup();
  send(browser, { type: "media", state: playingState }, sender(5, 3));
  assert.equal(await send(browser, { type: "mediaControl", tabId: 5, frameId: 3, action: "nexttrack" }), true);
  assert.deepEqual(browser.__sent[0], [5, { type: "mediaControl", action: "nexttrack", seekTime: undefined }, { frameId: 3 }]);

  assert.equal(await send(browser, { type: "mediaControl", tabId: 5, frameId: 3, action: "rm -rf" }), false);

  browser.__tabsSendMessageImpl = () => Promise.reject(new Error("no receiver"));
  assert.equal(await send(browser, { type: "mediaControl", tabId: 5, frameId: 3, action: "toggle" }), false);
  assert.equal(bg.mediaList().length, 0);
});

test("media: порядок постоянный — новый наверх, пауза и смена трека его не меняют", () => {
  const { browser, bg } = setup();
  send(browser, { type: "media", state: playingState }, sender(5));
  send(browser, { type: "media", state: playingState }, sender(6));
  send(browser, { type: "media", state: playingState }, sender(7));
  assert.deepEqual(bg.mediaList().map((s) => s.tabId), [7, 6, 5]);
  send(browser, { type: "media", state: { ...playingState, playing: false } }, sender(7));
  send(browser, { type: "media", state: { ...playingState, meta: { title: "Другой трек" } } }, sender(5));
  assert.deepEqual(bg.mediaList().map((s) => s.tabId), [7, 6, 5]);
});

test("mediaMove: перестановка перед другим плеером и в конец; закрытая вкладка выпадает из порядка", async () => {
  const { browser, bg } = setup();
  for (const id of [5, 6, 7]) send(browser, { type: "media", state: playingState }, sender(id));
  assert.equal(await send(browser, { type: "mediaMove", tabId: 5, beforeId: 7 }), true);
  assert.deepEqual(bg.mediaList().map((s) => s.tabId), [5, 7, 6]);
  assert.equal(await send(browser, { type: "mediaMove", tabId: 5, beforeId: null }), true);
  assert.deepEqual(bg.mediaList().map((s) => s.tabId), [7, 6, 5]);
  assert.equal(await send(browser, { type: "mediaMove", tabId: 42, beforeId: null }), false);
  await browser.tabs.onRemoved.emit(6, { windowId: 1 });
  send(browser, { type: "media", state: playingState }, sender(6));
  assert.deepEqual(bg.mediaList().map((s) => s.tabId), [6, 7, 5], "вернувшаяся вкладка — снова новая, наверх");
});

// ---------------------------------------------------------------- надёжность

test("надёжность: давно молчащий фрейм переспрашивается; выбрасывается, только если скрипта нет", async () => {
  const { browser, bg } = setup();
  for (const id of [5, 6, 7]) send(browser, { type: "media", state: playingState }, sender(id));
  browser.__tabsSendMessageImpl = async (tabId, msg) => {
    assert.equal(msg.type, "mediaQuery");
    if (tabId === 5) throw new Error("Could not establish connection. Receiving end does not exist.");
    return { state: playingState }; // 6: жив, просто таймеры фоновой вкладки придержаны
  };
  const now = Date.now();
  bg._getMediaSessions().get("5:0").seenAt = now - bg.MEDIA_STALE_MS - 1;
  bg._getMediaSessions().get("6:0").seenAt = now - bg.MEDIA_STALE_MS - 1;
  bg.sweepMedia(now);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(bg.mediaList().map((s) => s.tabId).sort(), [6, 7]);
  assert.deepEqual(browser.__sent.map(([id]) => id).sort(), [5, 6], "свежий не переспрашивается");
});

test("надёжность: фрейм, молчащий совсем долго (MEDIA_DEAD_MS), уходит без вопросов", () => {
  const { browser, bg } = setup();
  send(browser, { type: "media", state: playingState }, sender(5));
  const now = Date.now();
  bg._getMediaSessions().get("5:0").seenAt = now - bg.MEDIA_DEAD_MS - 1;
  bg.sweepMedia(now);
  assert.deepEqual(bg.mediaList(), []);
});

test("надёжность: при открытии панели состояние перезапрашивается — ответившие обновляются, молчащие выбрасываются", async () => {
  const { browser, bg } = setup();
  send(browser, { type: "media", state: playingState }, sender(5, 0));
  send(browser, { type: "media", state: playingState }, sender(6, 2));
  send(browser, { type: "media", state: playingState }, sender(7, 0));
  browser.__tabsSendMessageImpl = async (tabId, msg) => {
    assert.equal(msg.type, "mediaQuery");
    if (tabId === 5) return { state: { ...playingState, playing: false } };
    if (tabId === 6) throw new Error("Could not establish connection. Receiving end does not exist.");
    return { state: null }; // фрейму больше нечего показывать
  };
  const list = await send(browser, { type: "getMedia" });
  assert.deepEqual(list.map((s) => [s.tabId, s.playing]), [[5, false]]);
  assert.deepEqual(browser.__sent.map(([id, , opts]) => [id, opts.frameId]).sort(), [[5, 0], [6, 2], [7, 0]]);
});

test("надёжность: занятая страница не задерживает открытие панели дольше таймаута и не теряет строку", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { browser, bg } = setup();
  send(browser, { type: "media", state: playingState }, sender(5));
  browser.__tabsSendMessageImpl = () => new Promise(() => {}); // не успевает ответить
  const reply = send(browser, { type: "getMedia" });
  await Promise.resolve();
  t.mock.timers.tick(1000);
  const list = await reply;
  assert.deepEqual(list.map((s) => s.tabId), [5], "занятый фрейм остаётся");
});

test("надёжность: команда зависшей странице — false, но строка остаётся", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { browser, bg } = setup();
  send(browser, { type: "media", state: playingState }, sender(5, 3));
  browser.__tabsSendMessageImpl = () => new Promise(() => {});
  const reply = send(browser, { type: "mediaControl", tabId: 5, frameId: 3, action: "toggle" });
  await Promise.resolve();
  t.mock.timers.tick(5000);
  assert.equal(await reply, false);
  assert.equal(bg.mediaList().length, 1);
});

test("надёжность: после команды показывается фактическое состояние из ответа страницы, даже если оно не изменилось", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { browser, bg } = setup();
  send(browser, { type: "media", state: playingState }, sender(5, 3));
  t.mock.timers.tick(bg.MEDIA_BROADCAST_MS);
  browser.__broadcasts.length = 0;
  // Сайт проигнорировал паузу — продолжает играть.
  browser.__tabsSendMessageImpl = async () => ({ state: playingState });
  assert.equal(await send(browser, { type: "mediaControl", tabId: 5, frameId: 3, action: "toggle" }), true);
  t.mock.timers.tick(bg.MEDIA_BROADCAST_MS);
  assert.equal(browser.__broadcasts.length, 1, "панель получает правду даже без изменений");
  assert.equal(browser.__broadcasts[0].sessions[0].playing, true);

  browser.__tabsSendMessageImpl = async () => ({ state: { ...playingState, playing: false } });
  await send(browser, { type: "mediaControl", tabId: 5, frameId: 3, action: "toggle" });
  assert.equal(bg.mediaList()[0].playing, false);
});

test("надёжность: команда несуществующему плееру — false и рассылка правды", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { browser, bg } = setup();
  assert.equal(await send(browser, { type: "mediaControl", tabId: 9, frameId: 0, action: "toggle" }), false);
  t.mock.timers.tick(bg.MEDIA_BROADCAST_MS);
  assert.equal(browser.__broadcasts.length, 1);
  assert.deepEqual(browser.__broadcasts[0].sessions, []);
});

test("звук без скрипта: звучащая вкладка показывается простой строкой, пока скрипт о ней молчит", async () => {
  const { browser, bg } = setup();
  await browser.tabs.onUpdated.emit(8, { audible: true }, { id: 8, windowId: 1, audible: true, incognito: false });
  assert.deepEqual(bg.mediaList(), [], "сразу — нет: скрипт страницы ещё может отчитаться");
  const later = Date.now() + bg.BASIC_ROW_DELAY_MS;
  let [row] = bg.mediaList(later);
  assert.equal(row.tabId, 8);
  assert.equal(row.frameId, bg.NO_FRAME);
  assert.equal(row.basic, true);
  assert.equal(row.playing, true);
  assert.deepEqual(row.actions, []);

  // Скрипт заговорил — простая строка уступает настоящей.
  send(browser, { type: "media", state: playingState }, sender(8, 0));
  [row] = bg.mediaList(later);
  assert.equal(bg.mediaList(later).length, 1);
  assert.equal(row.frameId, 0);
});

test("звук без скрипта: стихшая вкладка держится AUDIBLE_GRACE_MS (паузы между треками), потом исчезает", async () => {
  const { browser, bg } = setup();
  const tab = { id: 8, windowId: 1, incognito: false };
  await browser.tabs.onUpdated.emit(8, { audible: true }, { ...tab, audible: true });
  const later = Date.now() + bg.BASIC_ROW_DELAY_MS;
  assert.equal(bg.mediaList(later).length, 1, "звучит — простая строка показана");
  await browser.tabs.onUpdated.emit(8, { audible: false }, { ...tab, audible: false });
  const [row] = bg.mediaList(later);
  assert.equal(row.playing, false, "сразу после тишины — строка на паузе, не пропадает");
  const now = Date.now();
  bg.sweepMedia(now + bg.AUDIBLE_GRACE_MS - 10);
  assert.equal(bg.mediaList(later).length, 1);
  bg.sweepMedia(now + bg.AUDIBLE_GRACE_MS + 10);
  assert.equal(bg.mediaList(later).length, 0);
});

test("звук без скрипта: приватные вкладки не показываются; закрытие вкладки убирает строку", async () => {
  const { browser, bg } = setup();
  const later = Date.now() + 10 * bg.BASIC_ROW_DELAY_MS;
  await browser.tabs.onUpdated.emit(8, { audible: true }, { id: 8, windowId: 1, audible: true, incognito: true });
  assert.equal(bg.mediaList(later).length, 0);
  await browser.tabs.onUpdated.emit(9, { audible: true }, { id: 9, windowId: 1, audible: true, incognito: false });
  assert.equal(bg.mediaList(later).length, 1);
  await browser.tabs.onRemoved.emit(9, { windowId: 1 });
  assert.equal(bg.mediaList(later).length, 0);
});

test("звук появился/пропал — состояние скриптов вкладки перезапрашивается", async () => {
  const { browser, bg } = setup();
  send(browser, { type: "media", state: playingState }, sender(5, 0));
  browser.__tabsSendMessageImpl = async () => ({ state: { ...playingState, playing: false } });
  await browser.tabs.onUpdated.emit(5, { audible: false }, { id: 5, windowId: 1, audible: false, incognito: false });
  await new Promise((r) => setImmediate(r));
  assert.equal(browser.__sent[0][1].type, "mediaQuery");
  assert.equal(bg.mediaList()[0].playing, false);
});

test("звук без скрипта: у вкладки, чей плеер ушёл со страницы, тишина не превращается в строку-«призрак»", async () => {
  const { browser, bg } = setup();
  const tab = { id: 8, windowId: 1, incognito: false };
  send(browser, { type: "media", state: playingState }, sender(8, 0));
  await browser.tabs.onUpdated.emit(8, { audible: true }, { ...tab, audible: true });
  const later = Date.now() + 10 * bg.BASIC_ROW_DELAY_MS;
  assert.deepEqual(bg.mediaList(later).map((r) => r.frameId), [0], "звучит, есть настоящая строка — простой нет");
  // Ушли со страницы: скрипт сообщил «нечего показывать», звук пропал.
  send(browser, { type: "media", state: null }, sender(8, 0));
  await browser.tabs.onUpdated.emit(8, { audible: false }, { ...tab, audible: false });
  assert.deepEqual(bg.mediaList(later), []);
});
