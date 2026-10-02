"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createMockBrowser, loadBackground } = require("./mock-browser.js");

function tab(url, groupId, overrides = {}) {
  return { url, title: url, pinned: false, active: false, status: "complete", groupId, ...overrides };
}

test("captureWindow: помечает вкладки ключом группы и собирает метаданные групп", async () => {
  const browser = createMockBrowser({ withTabGroups: true });
  browser.__tabGroupsQueryImpl = async ({ windowId }) => {
    assert.equal(windowId, 1);
    return [
      { id: 55, title: "Work", color: "blue", collapsed: false },
      { id: 56, title: "Reading", color: "red", collapsed: true },
    ];
  };
  const { captureWindow } = loadBackground(browser);

  const win = {
    id: 1,
    tabs: [
      tab("https://a.com", 55, { active: true }),
      tab("https://b.com", 55),
      tab("https://c.com", 56),
      tab("https://d.com", -1),
    ],
  };

  const result = await captureWindow(win);

  assert.equal(result.tabs.length, 4);
  assert.equal(result.tabs[0].groupKey, 0);
  assert.equal(result.tabs[1].groupKey, 0);
  assert.equal(result.tabs[2].groupKey, 1);
  assert.equal(result.tabs[3].groupKey, undefined, "вкладка вне группы (groupId:-1) не должна получать groupKey");

  assert.deepEqual(result.groups, [
    { title: "Work", color: "blue", collapsed: false },
    { title: "Reading", color: "red", collapsed: true },
  ]);
});

test("captureWindow: без API групп (старый Firefox) не падает и просто не размечает группы", async () => {
  const browser = createMockBrowser(); // withTabGroups не включён — как реальный старый Firefox
  const { captureWindow } = loadBackground(browser);

  const win = { id: 1, tabs: [tab("https://a.com", 55, { active: true })] };
  const result = await captureWindow(win);

  assert.equal(result.tabs[0].groupKey, undefined);
  assert.deepEqual(result.groups, []);
});

test("captureWindow: не падает, если tabGroups.query() бросает ошибку", async () => {
  const browser = createMockBrowser({ withTabGroups: true });
  browser.__tabGroupsQueryImpl = async () => {
    throw new Error("недоступно");
  };
  const { captureWindow } = loadBackground(browser);

  const win = { id: 1, tabs: [tab("https://a.com", 55, { active: true })] };
  const result = await captureWindow(win);

  assert.equal(result.tabs[0].groupKey, undefined);
  assert.deepEqual(result.groups, []);
});

test("captureSession: сохраняет группы вместе со снимком", async () => {
  const browser = createMockBrowser({ withTabGroups: true });
  browser.__windowsGetAllImpl = async () => [
    { id: 1, type: "normal", incognito: false, tabs: [tab("https://a.com", 7, { active: true })] },
  ];
  browser.__tabGroupsQueryImpl = async () => [{ id: 7, title: "Work", color: "blue", collapsed: false }];
  const { captureSession, STORAGE_KEY } = loadBackground(browser);

  await captureSession();

  const saved = browser.__storageData[STORAGE_KEY];
  assert.deepEqual(saved.windows[0].groups, [{ title: "Work", color: "blue", collapsed: false }]);
  assert.equal(saved.windows[0].tabs[0].groupKey, 0);
});

test("restoreGroupsInWindow: создаёт группу с правильными вкладками, заголовком и цветом", async () => {
  const browser = createMockBrowser({ withTabGroups: true });
  const { restoreGroupsInWindow } = loadBackground(browser);

  const winData = {
    tabs: [{ url: "https://a.com", groupKey: 0 }, { url: "https://b.com", groupKey: 0 }, { url: "https://c.com" }],
    groups: [{ title: "Work", color: "blue", collapsed: false }],
  };
  const createdTabs = [
    { id: 100, originalIndex: 0 },
    { id: 101, originalIndex: 1 },
    { id: 102, originalIndex: 2 },
  ];

  await restoreGroupsInWindow(winData, createdTabs, 5);

  assert.equal(browser.__calls.tabsGroup.length, 1);
  assert.deepEqual(browser.__calls.tabsGroup[0].tabIds, [100, 101]);
  assert.deepEqual(browser.__calls.tabsGroup[0].createProperties, { windowId: 5 });
  assert.deepEqual(browser.__calls.tabGroupsUpdate[0][1], { title: "Work", color: "blue" });
});

test("restoreGroupsInWindow: сворачивает группу, если в снимке collapsed:true", async () => {
  const browser = createMockBrowser({ withTabGroups: true });
  browser.__tabsGroupImpl = async () => 42;
  const { restoreGroupsInWindow } = loadBackground(browser);

  const winData = {
    tabs: [{ url: "https://a.com", groupKey: 0 }],
    groups: [{ title: "Reading", color: "red", collapsed: true }],
  };

  await restoreGroupsInWindow(winData, [{ id: 100, originalIndex: 0 }]);

  assert.equal(browser.__calls.tabGroupsUpdate.length, 1);
  assert.deepEqual(browser.__calls.tabGroupsUpdate[0], [42, { title: "Reading", color: "red", collapsed: true }]);
});

test("restoreGroupsInWindow: collapsed:false не передаётся (группа и так развёрнута)", async () => {
  const browser = createMockBrowser({ withTabGroups: true });
  const { restoreGroupsInWindow } = loadBackground(browser);

  const winData = {
    tabs: [{ url: "https://a.com", groupKey: 0 }],
    groups: [{ title: "Work", color: "blue", collapsed: false }],
  };

  await restoreGroupsInWindow(winData, [{ id: 100, originalIndex: 0 }]);

  assert.equal(browser.__calls.tabGroupsUpdate.length, 1);
  assert.equal("collapsed" in browser.__calls.tabGroupsUpdate[0][1], false);
});

test("restoreGroupsInWindow: ничего не делает, если групп нет в снимке (в т.ч. старые данные без поля groups)", async () => {
  const browser = createMockBrowser({ withTabGroups: true });
  const { restoreGroupsInWindow } = loadBackground(browser);

  await restoreGroupsInWindow({ tabs: [{ url: "https://a.com" }], groups: [] }, [{ id: 100, originalIndex: 0 }]);
  await restoreGroupsInWindow({ tabs: [{ url: "https://a.com" }] }, [{ id: 100, originalIndex: 0 }]);

  assert.equal(browser.__calls.tabsGroup.length, 0);
});

test("restoreGroupsInWindow: не падает на старом Firefox без tabs.group()", async () => {
  const browser = createMockBrowser(); // без withTabGroups
  const { restoreGroupsInWindow } = loadBackground(browser);

  const winData = {
    tabs: [{ url: "https://a.com", groupKey: 0 }],
    groups: [{ title: "Work", color: "blue", collapsed: false }],
  };

  await assert.doesNotReject(() => restoreGroupsInWindow(winData, [{ id: 100, originalIndex: 0 }]));
});

test("restoreGroupsInWindow: сбой создания одной группы не мешает восстановить остальные и не бросает исключение", async () => {
  const browser = createMockBrowser({ withTabGroups: true });
  browser.__tabsGroupImpl = async (options) => {
    if (options.tabIds.includes(100)) throw new Error("group failed");
    return 99;
  };
  const { restoreGroupsInWindow } = loadBackground(browser);

  const winData = {
    tabs: [{ url: "https://a.com", groupKey: 0 }, { url: "https://b.com", groupKey: 1 }],
    groups: [
      { title: "Broken", color: "red", collapsed: false },
      { title: "OK", color: "blue", collapsed: false },
    ],
  };
  const createdTabs = [{ id: 100, originalIndex: 0 }, { id: 101, originalIndex: 1 }];

  await assert.doesNotReject(() => restoreGroupsInWindow(winData, createdTabs));
  assert.equal(browser.__calls.tabsGroup.length, 2);
});

test("restoreSession: восстанавливает группу вкладок целиком (создание + группировка после создания вкладок)", async () => {
  const browser = createMockBrowser({ withTabGroups: true });
  const { restoreSession } = loadBackground(browser);

  const session = {
    windows: [
      {
        tabs: [
          { url: "https://a.com", title: "A", pinned: false, active: true, groupKey: 0 },
          { url: "https://b.com", title: "B", pinned: false, active: false, groupKey: 0 },
          { url: "https://c.com", title: "C", pinned: false, active: false },
        ],
        groups: [{ title: "Work", color: "blue", collapsed: false }],
      },
    ],
  };

  const initialWindow = {
    id: 1,
    tabs: [{ id: 10, url: "about:newtab", title: "", pinned: false, active: true, status: "complete" }],
  };

  await restoreSession(session, initialWindow);

  assert.equal(browser.__calls.tabsGroup.length, 1);
  assert.equal(browser.__calls.tabsGroup[0].tabIds.length, 2, "в группу должны попасть только a.com и b.com");
  assert.deepEqual(browser.__calls.tabsGroup[0].createProperties, { windowId: 1 });
  assert.deepEqual(browser.__calls.tabGroupsUpdate[0][1], { title: "Work", color: "blue" });
});

test("изменения самих групп (переименование, цвет, сворачивание) планируют сохранение", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const browser = createMockBrowser({ withTabGroups: true });
  browser.__windowsGetAllImpl = async () => [
    { id: 1, type: "normal", incognito: false, tabs: [tab("https://a.com", -1, { active: true })] },
  ];
  const { SAVE_DEBOUNCE_MS } = loadBackground(browser);

  for (const name of ["onCreated", "onUpdated", "onRemoved", "onMoved"]) {
    assert.equal(browser.tabGroups[name].listenerCount, 1, `нет подписки на tabGroups.${name}`);
  }

  browser.tabGroups.onUpdated.emit({ id: 5, windowId: 1, title: "New name" });
  t.mock.timers.tick(SAVE_DEBOUNCE_MS);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(browser.__calls.storageSet.length, 1);
});

test("смена groupId вкладки (tabs.onUpdated) планирует сохранение", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const browser = createMockBrowser({ withTabGroups: true });
  browser.__windowsGetAllImpl = async () => [
    { id: 1, type: "normal", incognito: false, tabs: [tab("https://a.com", -1, { active: true })] },
  ];
  const { SAVE_DEBOUNCE_MS } = loadBackground(browser);

  browser.tabs.onUpdated.emit(1, { groupId: 5 }, {});
  t.mock.timers.tick(SAVE_DEBOUNCE_MS);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(browser.__calls.storageSet.length, 1);
});

test("restoreGroupsInWindow: регрессия — группы реально создаются в Firefox-подобном моке (title/color не в createProperties)", async () => {
  const browser = createMockBrowser({ withTabGroups: true });
  const { restoreGroupsInWindow } = loadBackground(browser);
  const winData = {
    tabs: [
      { url: "https://a.com", groupKey: 0 },
      { url: "https://b.com", groupKey: 1 },
      { url: "https://c.com", groupKey: 1 },
    ],
    groups: [
      { title: "почта", color: "purple", collapsed: false },
      { title: "работа", color: "cyan", collapsed: true },
    ],
  };
  const created = [{ id: 1, originalIndex: 0 }, { id: 2, originalIndex: 1 }, { id: 3, originalIndex: 2 }];
  const errors = [];
  const origError = console.error;
  console.error = (...a) => errors.push(a.join(" "));
  try {
    await restoreGroupsInWindow(winData, created, 7);
  } finally {
    console.error = origError;
  }
  assert.deepEqual(errors, [], "ни одной ошибки создания группы");
  assert.equal(browser.__calls.tabsGroup.length, 2);
  assert.deepEqual(
    browser.__calls.tabGroupsUpdate.map(([, p]) => p),
    [
      { title: "почта", color: "purple" },
      { title: "работа", color: "cyan", collapsed: true },
    ]
  );
});
