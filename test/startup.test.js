"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createMockBrowser, loadBackground } = require("./mock-browser.js");

function freshTab(id = 1) {
  return { id, url: "about:newtab", title: "", pinned: false, active: true, status: "complete" };
}

function backupSession() {
  return {
    windows: [{ tabs: [{ url: "https://a.com", title: "A", pinned: false, active: true }] }],
    savedAt: Date.now(),
  };
}

test("checkAndRestoreOnStartup: восстанавливает, когда окно 'свежее' и есть резервная копия", async () => {
  const browser = createMockBrowser({ initialStorage: { lastSession: backupSession() } });
  browser.__windowsGetAllImpl = async () => [{ id: 1, type: "normal", incognito: false, tabs: [freshTab(10)] }];
  const { checkAndRestoreOnStartup } = loadBackground(browser);

  await checkAndRestoreOnStartup();

  assert.equal(browser.__calls.tabsUpdate.length, 1);
  assert.equal(browser.__calls.tabsUpdate[0][1].url, "https://a.com");
});

test("checkAndRestoreOnStartup: ничего не восстанавливает без резервной копии", async () => {
  const browser = createMockBrowser();
  browser.__windowsGetAllImpl = async () => [{ id: 1, type: "normal", incognito: false, tabs: [freshTab(10)] }];
  const { checkAndRestoreOnStartup } = loadBackground(browser);

  await checkAndRestoreOnStartup();

  assert.equal(browser.__calls.tabsUpdate.length, 0);
  assert.equal(browser.__calls.tabsCreate.length, 0);
});

test("checkAndRestoreOnStartup: не трогает окно, если вкладка уже не 'свежая' (пользователь уже что-то открыл)", async () => {
  const browser = createMockBrowser({ initialStorage: { lastSession: backupSession() } });
  browser.__windowsGetAllImpl = async () => [
    { id: 1, type: "normal", incognito: false, tabs: [{ id: 10, url: "https://already-browsing.com", title: "", pinned: false, active: true, status: "complete" }] },
  ];
  const { checkAndRestoreOnStartup } = loadBackground(browser);

  await checkAndRestoreOnStartup();

  assert.equal(browser.__calls.tabsUpdate.length, 0);
  assert.equal(browser.__calls.tabsCreate.length, 0);
});

test("checkAndRestoreOnStartup: не трогает окно, если открыто больше одной вкладки", async () => {
  const browser = createMockBrowser({ initialStorage: { lastSession: backupSession() } });
  browser.__windowsGetAllImpl = async () => [{ id: 1, type: "normal", incognito: false, tabs: [freshTab(10), freshTab(11)] }];
  const { checkAndRestoreOnStartup } = loadBackground(browser);

  await checkAndRestoreOnStartup();

  assert.equal(browser.__calls.tabsUpdate.length, 0);
});

test("checkAndRestoreOnStartup: не-обычные окна (devtools/popup) не мешают распознать состояние как 'свежее'", async () => {
  const browser = createMockBrowser({ initialStorage: { lastSession: backupSession() } });
  browser.__windowsGetAllImpl = async () => [
    { id: 1, type: "normal", incognito: false, tabs: [freshTab(10)] },
    { id: 2, type: "devtools", incognito: false, tabs: [{ id: 20, url: "about:devtools-toolbox", title: "", pinned: false, active: true, status: "complete" }] },
  ];
  const { checkAndRestoreOnStartup } = loadBackground(browser);

  await checkAndRestoreOnStartup();

  assert.equal(browser.__calls.tabsUpdate.length, 1, "восстановление должно сработать, несмотря на постороннее devtools-окно");
});

test("checkAndRestoreOnStartup: не восстанавливает при нескольких обычных окнах", async () => {
  const browser = createMockBrowser({ initialStorage: { lastSession: backupSession() } });
  browser.__windowsGetAllImpl = async () => [
    { id: 1, type: "normal", incognito: false, tabs: [freshTab(10)] },
    { id: 2, type: "normal", incognito: false, tabs: [freshTab(20)] },
  ];
  const { checkAndRestoreOnStartup } = loadBackground(browser);

  await checkAndRestoreOnStartup();

  assert.equal(browser.__calls.tabsUpdate.length, 0);
});

test("checkAndRestoreOnStartup: в конце всегда пытается сохранить текущее состояние (runSave), без лишних повторных опросов", async () => {
  const browser = createMockBrowser({ initialStorage: { lastSession: backupSession() } });
  let getAllCalls = 0;
  browser.__windowsGetAllImpl = async () => {
    getAllCalls++;
    return [{ id: 1, type: "normal", incognito: false, tabs: [freshTab(10)] }];
  };
  const { checkAndRestoreOnStartup } = loadBackground(browser);

  await checkAndRestoreOnStartup();

  // Один вызов — сама проверка "свежести" окна; второй — финальный runSave().
  // Во время restoreSession повторного windows.getAll быть не должно: окна и
  // так уже переданы параметрами, а не переопрашиваются заново.
  assert.equal(getAllCalls, 2);
});

test("checkAndRestoreOnStartup: не падает и не логирует восстановление, если проверка бросает ошибку", async () => {
  const browser = createMockBrowser();
  browser.__windowsGetAllImpl = async () => {
    throw new Error("недоступно");
  };
  const bg = loadBackground(browser);

  await assert.doesNotReject(() => bg.checkAndRestoreOnStartup());
  bg._resetState(); // снять таймер повтора сохранения
});
