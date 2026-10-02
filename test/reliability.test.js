"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createMockBrowser, loadBackground } = require("./mock-browser.js");

let current = null;
test.afterEach(() => {
  if (current) current._resetState();
  current = null;
});

function load(browser) {
  current = loadBackground(browser);
  return current;
}

const win = (url, id = 1) => ({
  id,
  type: "normal",
  incognito: false,
  tabs: [{ id: 10, url, title: "", pinned: false, active: true, status: "complete" }],
});

const flush = () => new Promise((resolve) => setImmediate(resolve));

test("старт: резервная копия читается до любой записи — раннее сохранение её не затирает", async () => {
  const backup = { windows: [{ tabs: [{ url: "https://a.com", title: "A", pinned: false, active: true }] }], savedAt: 1 };
  const browser = createMockBrowser({ initialStorage: { lastSession: backup } });
  browser.__windowsGetAllImpl = async () => [win("about:newtab")];
  const bg = load(browser);

  // Сохранение успело раньше onStartup и записало «одну новую вкладку».
  await bg.captureSession();
  assert.equal(browser.__storageData.lastSession.windows[0].tabs[0].url, "about:newtab");

  await bg.checkAndRestoreOnStartup();
  assert.equal(browser.__calls.tabsUpdate.length, 1);
  assert.equal(browser.__calls.tabsUpdate[0][1].url, "https://a.com");
});

test("runSave: записи идут по одной, последним на диске оказывается самый свежий снимок", async () => {
  const browser = createMockBrowser();
  let url = "https://one.com/";
  browser.__windowsGetAllImpl = async () => [win(url)];
  let release;
  let first = true;
  let inFlight = 0;
  let maxInFlight = 0;
  browser.__storageSetImpl = async () => {
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    if (first) {
      first = false;
      await new Promise((r) => (release = r));
    }
    inFlight--;
  };
  const bg = load(browser);

  const done = bg.runSave();
  await flush();
  url = "https://two.com/";
  bg.runSave(); // пока первая запись висит
  release();
  await done;

  assert.equal(maxInFlight, 1);
  assert.equal(browser.__calls.storageSet.length, 2);
  assert.equal(browser.__storageData.lastSession.windows[0].tabs[0].url, "https://two.com/");
});

test("runSave: неудачная запись повторяется сама, без нового изменения вкладок", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const browser = createMockBrowser();
  browser.__windowsGetAllImpl = async () => [win("https://a.com/")];
  let fail = true;
  browser.__storageSetImpl = async () => {
    if (fail) throw new Error("диск");
  };
  const bg = load(browser);

  await bg.runSave();
  assert.equal(browser.__storageData.lastSession, undefined);

  fail = false;
  t.mock.timers.tick(bg.SAVE_RETRY_MS);
  await bg.runSave(); // дождаться повтора, запущенного таймером
  assert.ok(browser.__storageData.lastSession);
});

test("runSave: повторы ограничены — сломанное хранилище не крутит таймер вечно", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const browser = createMockBrowser();
  browser.__windowsGetAllImpl = async () => [win("https://a.com/")];
  browser.__storageSetImpl = async () => {
    throw new Error("диск");
  };
  const bg = load(browser);

  await bg.runSave();
  for (let i = 0; i < bg.SAVE_RETRY_MAX + 3; i++) {
    t.mock.timers.tick(bg.SAVE_RETRY_MS);
    await flush();
    await flush();
  }
  assert.equal(browser.__calls.storageSet.length, 1 + bg.SAVE_RETRY_MAX);
});

test("mediaChanged: подтверждение «жив» без видимых изменений не рассылается", () => {
  const browser = createMockBrowser();
  const { mediaChanged } = load(browser);
  const base = {
    windowId: 1, title: "Песня", artist: "", album: "", artwork: "", playing: true, pageMuted: false,
    canPlay: true, canSeek: true, late: false, live: false, actions: ["play", "pause"], playedAt: 1,
    position: { duration: 200, position: 30, rate: 1, at: 0 },
  };
  const later = (patch) => ({ ...base, position: { ...base.position, position: 40, at: 10000 }, ...patch });

  assert.equal(mediaChanged(undefined, base), true, "новый фрейм");
  assert.equal(mediaChanged(base, later({})), false, "позиция ушла ровно настолько, насколько досчитает панель");
  assert.equal(mediaChanged(base, later({ title: "Другая" })), true);
  assert.equal(mediaChanged(base, later({ playing: false })), true);
  assert.equal(mediaChanged(base, later({ actions: ["play", "pause", "nexttrack"] })), true);
  assert.equal(mediaChanged(base, { ...base, position: { ...base.position, position: 100, at: 10000 } }), true, "перемотка");
  assert.equal(mediaChanged(base, { ...base, position: null }), true);
});
