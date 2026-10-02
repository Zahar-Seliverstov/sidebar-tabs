"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createMockBrowser, loadBackground } = require("./mock-browser.js");

function makeWindow(overrides = {}) {
  return {
    id: 1,
    type: "normal",
    incognito: false,
    tabs: [{ id: 1, url: "https://example.com", title: "Example", pinned: false, active: true, status: "complete" }],
    ...overrides,
  };
}

test("captureSession: сохраняет обычные вкладки в storage", async () => {
  const browser = createMockBrowser();
  browser.__windowsGetAllImpl = async () => [makeWindow()];
  const { captureSession, STORAGE_KEY } = loadBackground(browser);

  await captureSession();

  assert.equal(browser.__calls.storageSet.length, 1);
  const saved = browser.__storageData[STORAGE_KEY];
  assert.equal(saved.windows.length, 1);
  assert.equal(saved.windows[0].tabs.length, 1);
  assert.equal(saved.windows[0].tabs[0].url, "https://example.com");
});

test("captureSession: исключает окна инкогнито", async () => {
  const browser = createMockBrowser();
  browser.__windowsGetAllImpl = async () => [makeWindow({ incognito: true })];
  const { captureSession, STORAGE_KEY } = loadBackground(browser);

  await captureSession();

  assert.equal(browser.__calls.storageSet.length, 0);
  assert.equal(browser.__storageData[STORAGE_KEY], undefined);
});

test("captureSession: исключает не-обычные окна (popup/panel/devtools)", async () => {
  const browser = createMockBrowser();
  browser.__windowsGetAllImpl = async () => [makeWindow({ type: "popup" })];
  const { captureSession } = loadBackground(browser);

  await captureSession();

  assert.equal(browser.__calls.storageSet.length, 0);
});

test("captureSession: фильтрует непригодные для восстановления URL внутри окна", async () => {
  const browser = createMockBrowser();
  browser.__windowsGetAllImpl = async () => [
    makeWindow({
      tabs: [
        { id: 1, url: "https://example.com", title: "A", pinned: false, active: true, status: "complete" },
        { id: 2, url: "about:config", title: "B", pinned: false, active: false, status: "complete" },
        { id: 3, url: "moz-extension://x/page.html", title: "C", pinned: false, active: false, status: "complete" },
      ],
    }),
  ];
  const { captureSession, STORAGE_KEY } = loadBackground(browser);

  await captureSession();

  const saved = browser.__storageData[STORAGE_KEY];
  assert.equal(saved.windows[0].tabs.length, 1);
  assert.equal(saved.windows[0].tabs[0].url, "https://example.com");
});

test("captureSession: не сохраняет about:blank в процессе загрузки (переходное состояние)", async () => {
  const browser = createMockBrowser();
  browser.__windowsGetAllImpl = async () => [
    makeWindow({
      tabs: [
        { id: 1, url: "https://example.com", title: "A", pinned: false, active: true, status: "complete" },
        { id: 2, url: "about:blank", title: "", pinned: false, active: false, status: "loading" },
      ],
    }),
  ];
  const { captureSession, STORAGE_KEY } = loadBackground(browser);

  await captureSession();

  const saved = browser.__storageData[STORAGE_KEY];
  assert.equal(saved.windows[0].tabs.length, 1);
  assert.equal(saved.windows[0].tabs[0].url, "https://example.com");
});

test("captureSession: сохраняет уже загруженный about:blank", async () => {
  const browser = createMockBrowser();
  browser.__windowsGetAllImpl = async () => [
    makeWindow({
      tabs: [{ id: 1, url: "about:blank", title: "", pinned: false, active: true, status: "complete" }],
    }),
  ];
  const { captureSession, STORAGE_KEY } = loadBackground(browser);

  await captureSession();

  const saved = browser.__storageData[STORAGE_KEY];
  assert.equal(saved.windows[0].tabs.length, 1);
  assert.equal(saved.windows[0].tabs[0].url, "about:blank");
});

test("captureSession: не пишет в storage, если снимок не изменился", async () => {
  const browser = createMockBrowser();
  browser.__windowsGetAllImpl = async () => [makeWindow()];
  const { captureSession } = loadBackground(browser);

  await captureSession();
  await captureSession();
  await captureSession();

  assert.equal(browser.__calls.storageSet.length, 1);
});

test("captureSession: пишет заново, если снимок изменился", async () => {
  const browser = createMockBrowser();
  let title = "Example";
  browser.__windowsGetAllImpl = async () => [
    makeWindow({ tabs: [{ id: 1, url: "https://example.com/" + title, title, pinned: false, active: true, status: "complete" }] }),
  ];
  const { captureSession } = loadBackground(browser);

  await captureSession();
  title = "Changed";
  await captureSession();

  assert.equal(browser.__calls.storageSet.length, 2);
});

test("captureSession: не считает снимок сохранённым, если запись в storage упала (иначе теряем данные навсегда)", async () => {
  const browser = createMockBrowser();
  browser.__windowsGetAllImpl = async () => [makeWindow()];

  let shouldFail = true;
  browser.__storageSetImpl = async () => {
    if (shouldFail) throw new Error("диск переполнен");
  };

  const { captureSession, STORAGE_KEY } = loadBackground(browser);

  await assert.rejects(() => captureSession(), /диск переполнен/);
  assert.equal(browser.__storageData[STORAGE_KEY], undefined);

  // Тот же самый (неизменившийся) снимок должен попытаться записаться снова,
  // а не быть молча пропущен как "уже сохранённый".
  shouldFail = false;
  await captureSession();

  assert.equal(browser.__calls.storageSet.length, 2);
  assert.ok(browser.__storageData[STORAGE_KEY]);
});

test("captureSession: ничего не делает во время восстановления (isRestoring)", async () => {
  const browser = createMockBrowser();
  browser.__windowsGetAllImpl = async () => [makeWindow()];
  const mod = loadBackground(browser);

  // restoreSession выставляет isRestoring=true на время своей работы.
  browser.__windowsCreateImpl = async () => ({
    id: 999,
    type: "normal",
    incognito: false,
    tabs: [{ id: 999, url: "about:newtab", title: "", pinned: false, active: true, status: "complete" }],
  });

  const session = { windows: [{ tabs: [{ url: "https://a.com", title: "A", pinned: false, active: true }] }] };
  const initialWindow = { id: 1, tabs: [{ id: 1 }] };

  const restorePromise = mod.restoreSession(session, initialWindow);
  // Пока восстановление идёт, captureSession должен быть no-op.
  await mod.captureSession();
  assert.equal(browser.__calls.storageSet.length, 0);

  await restorePromise;
  assert.equal(mod._getIsRestoring(), false);
});
