"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createMockBrowser, loadBackground } = require("./mock-browser.js");

function placeholderWindow(id = 1, tabId = 1) {
  return { id, tabs: [{ id: tabId, url: "about:newtab", title: "", pinned: false, active: true, status: "complete" }] };
}

test("restoreIntoWindow: переиспользует единственную заглушку под ту вкладку, что была активна (не первую по индексу)", async () => {
  const browser = createMockBrowser();
  const { restoreIntoWindow } = loadBackground(browser);

  const tabsData = [
    { url: "https://a.com", title: "A", pinned: false, active: false },
    { url: "https://b.com", title: "B", pinned: false, active: true },
  ];

  const created = await restoreIntoWindow(1, tabsData, [42]);

  assert.equal(browser.__calls.tabsUpdate.length, 1);
  assert.deepEqual(browser.__calls.tabsUpdate[0], [42, { url: "https://b.com", pinned: false, active: true }]);
  // b.com переиспользован через заглушку — a.com должен быть создан отдельно.
  assert.equal(browser.__calls.tabsCreate.length, 1);
  assert.equal(browser.__calls.tabsCreate[0].url, "https://a.com");

  const reused = created.find((t) => t.reused);
  assert.ok(reused);
  assert.equal(reused.id, 42);
});

test("restoreIntoWindow: реальные страницы создаются discarded, активная и 'свежие' — нет", async () => {
  const browser = createMockBrowser();
  const { restoreIntoWindow } = loadBackground(browser);

  const tabsData = [
    { url: "https://a.com", title: "A", pinned: false, active: true },
    { url: "https://b.com", title: "B", pinned: false, active: false },
    { url: "about:newtab", title: "", pinned: false, active: false },
  ];

  // Без заглушки (placeholderIds пуст), чтобы все три вкладки прошли через tabs.create.
  await restoreIntoWindow(1, tabsData, []);

  const byUrl = Object.fromEntries(browser.__calls.tabsCreate.map((c) => [c.url, c]));
  assert.equal(byUrl["https://a.com"].discarded, false, "активная вкладка не должна быть discarded");
  assert.equal(byUrl["https://b.com"].discarded, true, "неактивная реальная страница должна быть discarded");
  assert.equal(byUrl["about:newtab"].discarded, false, "свежая вкладка никогда не discarded");
});

test("restoreIntoWindow: если tabs.update на заглушке падает, откатывается на create+remove", async () => {
  const browser = createMockBrowser();
  browser.__tabsUpdateImpl = async () => {
    throw new Error("update failed");
  };
  const { restoreIntoWindow } = loadBackground(browser);

  const tabsData = [{ url: "https://a.com", title: "A", pinned: false, active: true }];
  const created = await restoreIntoWindow(1, tabsData, [42]);

  assert.equal(browser.__calls.tabsCreate.length, 1);
  assert.equal(browser.__calls.tabsCreate[0].url, "https://a.com");
  assert.ok(!created.some((t) => t.reused));
});

test("restoreIntoWindow: сбой создания одной вкладки не мешает восстановить остальные", async () => {
  const browser = createMockBrowser();
  browser.__tabsCreateImpl = async (props) => {
    if (props.url === "https://broken.com") throw new Error("boom");
    return { id: Math.floor(Math.random() * 100000), ...props };
  };
  const { restoreIntoWindow } = loadBackground(browser);

  const tabsData = [
    { url: "https://a.com", title: "A", pinned: false, active: true },
    { url: "https://broken.com", title: "B", pinned: false, active: false },
    { url: "https://c.com", title: "C", pinned: false, active: false },
  ];

  const created = await restoreIntoWindow(1, tabsData, []);

  assert.equal(created.length, 2);
  assert.ok(created.some((t) => browser.__calls.tabsCreate.some((c) => c.url === "https://a.com")));
});

test("restoreIntoWindow: активирует нужную вкладку, когда заглушка не переиспользована", async () => {
  const browser = createMockBrowser();
  const { restoreIntoWindow } = loadBackground(browser);

  const tabsData = [
    { url: "https://a.com", title: "A", pinned: false, active: false },
    { url: "https://b.com", title: "B", pinned: false, active: true },
  ];

  const created = await restoreIntoWindow(1, tabsData, []);

  const activateCall = browser.__calls.tabsUpdate.find((c) => c[1].active === true);
  assert.ok(activateCall, "должен быть вызов tabs.update с active:true");
  const bTab = created.find((t) => t.active);
  assert.equal(activateCall[0], bTab.id);
});

test("restoreSession: восстанавливает несколько окон, второе создаёт через windows.create", async () => {
  const browser = createMockBrowser();
  const { restoreSession } = loadBackground(browser);

  const session = {
    windows: [
      { tabs: [{ url: "https://a.com", title: "A", pinned: false, active: true }] },
      { tabs: [{ url: "https://b.com", title: "B", pinned: false, active: true }] },
    ],
  };

  await restoreSession(session, placeholderWindow(1, 10));

  assert.equal(browser.__calls.windowsCreate.length, 1, "для второго окна сессии должно быть создано новое окно");
  const urls = browser.__calls.tabsUpdate.map((c) => c[1].url).concat(browser.__calls.tabsCreate.map((c) => c.url));
  assert.ok(urls.includes("https://a.com"));
  assert.ok(urls.includes("https://b.com"));
});

test("restoreSession: закрывает неиспользованные вкладки-заглушки", async () => {
  const browser = createMockBrowser();
  const { restoreSession } = loadBackground(browser);

  const session = {
    windows: [{ tabs: [{ url: "https://a.com", title: "A", pinned: false, active: true }] }],
  };

  // Два "лишних" placeholder-таба в стартовом окне — заглушка не переиспользуется
  // (реиспользование работает только когда placeholder ровно один).
  const initialWindow = {
    id: 1,
    tabs: [
      { id: 10, url: "about:newtab", title: "", pinned: false, active: true, status: "complete" },
      { id: 11, url: "about:newtab", title: "", pinned: false, active: false, status: "complete" },
    ],
  };

  await restoreSession(session, initialWindow);

  assert.equal(browser.__calls.tabsRemove.length, 1);
  assert.deepEqual(browser.__calls.tabsRemove[0].sort(), [10, 11]);
});

test("restoreSession: сбой восстановления одного окна не должен обрывать восстановление остальных окон сессии", async () => {
  const browser = createMockBrowser();
  let windowsCreateCalls = 0;
  browser.__windowsCreateImpl = async (props, win) => {
    windowsCreateCalls++;
    if (windowsCreateCalls === 1) throw new Error("второе окно не удалось создать");
    return win;
  };
  const { restoreSession } = loadBackground(browser);

  const session = {
    windows: [
      { tabs: [{ url: "https://a.com", title: "A", pinned: false, active: true }] },
      { tabs: [{ url: "https://b.com", title: "B", pinned: false, active: true }] }, // это окно упадёт
      { tabs: [{ url: "https://c.com", title: "C", pinned: false, active: true }] },
    ],
  };

  await restoreSession(session, placeholderWindow(1, 10));

  const restoredUrls = browser.__calls.tabsUpdate.map((c) => c[1].url).filter(Boolean);
  assert.ok(restoredUrls.includes("https://a.com"), "первое окно (без windows.create) должно восстановиться");
  assert.ok(restoredUrls.includes("https://c.com"), "третье окно должно восстановиться, несмотря на сбой второго");
});

test("restoreSession: выставляет и сбрасывает isRestoring, даже если восстановление упало", async () => {
  const browser = createMockBrowser();
  browser.__windowsCreateImpl = async () => {
    throw new Error("не удалось создать окно");
  };
  const mod = loadBackground(browser);

  const session = {
    windows: [
      { tabs: [{ url: "https://a.com", title: "A", pinned: false, active: true }] },
      { tabs: [{ url: "https://b.com", title: "B", pinned: false, active: true }] },
    ],
  };

  assert.equal(mod._getIsRestoring(), false);
  await mod.restoreSession(session, placeholderWindow(1, 10));
  assert.equal(mod._getIsRestoring(), false, "isRestoring обязан сброситься даже после ошибки (finally)");
});
