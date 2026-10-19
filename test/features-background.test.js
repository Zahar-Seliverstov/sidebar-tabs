"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createMockBrowser, loadBackground } = require("./mock-browser.js");

// Маленький «Firefox» для автогруппировки: вкладки и группы окна в памяти,
// tabs.group/tabGroups.update меняют их, как настоящие.
function groupingWorld(tabs, groups = []) {
  const browser = createMockBrowser({ withTabGroups: true });
  const world = { tabs: new Map(tabs.map((t) => [t.id, { windowId: 1, pinned: false, groupId: -1, ...t }])), groups };
  let nextGroup = 100;
  browser.__tabsGetImpl = async (id) => {
    const t = world.tabs.get(id);
    if (!t) throw new Error("Invalid tab ID");
    return { ...t };
  };
  browser.__tabsQueryImpl = async (q = {}) =>
    [...world.tabs.values()].filter((t) => q.pinned === undefined || t.pinned === q.pinned).map((t) => ({ ...t }));
  browser.__tabGroupsQueryImpl = async ({ windowId }) => world.groups.filter((g) => g.windowId === windowId);
  browser.__tabsGroupImpl = async ({ tabIds, groupId, createProperties }) => {
    const gid = groupId !== undefined ? groupId : nextGroup++;
    if (groupId === undefined) world.groups.push({ id: gid, windowId: createProperties.windowId, title: "", color: "grey" });
    for (const id of tabIds) world.tabs.get(id).groupId = gid;
    return gid;
  };
  browser.__tabGroupsUpdateImpl = async (gid, props) => {
    Object.assign(world.groups.find((g) => g.id === gid), props);
    return { id: gid, ...props };
  };
  return { browser, world };
}

const RULES = [
  { pattern: "github.com", group: "Код", color: "green" },
  { pattern: "mail.google.com", group: "Почта", color: "red" },
];

async function withRules(browser, bg, rules = RULES) {
  await bg.settingsReady;
  await browser.storage.local.set({ settings: { groupRules: rules } });
  await bg.seedRuleMatches();
}

// Вкладка перешла по адресу: как onUpdated с changeInfo.url.
async function navigate(browser, world, id, url) {
  world.tabs.get(id).url = url;
  await browser.tabs.onUpdated.emit(id, { url }, { ...world.tabs.get(id) });
}

async function settle(bg) {
  // Очередь правил — цепочка промисов; пара тиков, чтобы она прошла.
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
}

// ---------------------------------------------------------------- автогруппировка

test("автогруппировка: новая вкладка, открывшая сайт правила, попадает в новую группу с названием и цветом", async () => {
  const { browser, world } = groupingWorld([]);
  const bg = loadBackground(browser);
  await withRules(browser, bg);

  world.tabs.set(5, { id: 5, windowId: 1, url: "about:blank", pinned: false, groupId: -1 });
  await browser.tabs.onCreated.emit({ ...world.tabs.get(5) });
  await navigate(browser, world, 5, "https://github.com/mozilla");
  await settle(bg);

  const gid = world.tabs.get(5).groupId;
  assert.notEqual(gid, -1);
  assert.deepEqual(
    world.groups.map((g) => [g.title, g.color]),
    [["Код", "green"]]
  );
  assert.ok(browser.__calls.tabsGroup.every((c) => !c.createProperties || Object.keys(c.createProperties).join() === "windowId"));
  assert.equal(gid, world.groups[0].id);
});

test("автогруппировка: существующая группа окна с тем же названием переиспользуется", async () => {
  const { browser, world } = groupingWorld([{ id: 5, url: "about:blank" }], [{ id: 7, windowId: 1, title: "код", color: "blue" }]);
  const bg = loadBackground(browser);
  await withRules(browser, bg);

  await navigate(browser, world, 5, "https://gist.github.com/x");
  await settle(bg);

  assert.equal(world.tabs.get(5).groupId, 7);
  assert.equal(world.groups.length, 1);
});

test("автогруппировка: две вкладки разом — одна группа, а не две одинаковые", async () => {
  const { browser, world } = groupingWorld([
    { id: 1, url: "about:blank" },
    { id: 2, url: "about:blank" },
  ]);
  const bg = loadBackground(browser);
  await withRules(browser, bg);

  await Promise.all([navigate(browser, world, 1, "https://github.com/a"), navigate(browser, world, 2, "https://github.com/b")]);
  await settle(bg);

  assert.equal(world.groups.length, 1);
  assert.equal(world.tabs.get(1).groupId, world.tabs.get(2).groupId);
});

test("автогруппировка: вкладку, вынутую из группы руками, правило не тянет обратно на том же сайте", async () => {
  const { browser, world } = groupingWorld([{ id: 1, url: "about:blank" }]);
  const bg = loadBackground(browser);
  await withRules(browser, bg);

  await navigate(browser, world, 1, "https://github.com/a");
  await settle(bg);
  assert.notEqual(world.tabs.get(1).groupId, -1);

  world.tabs.get(1).groupId = -1; // пользователь убрал из группы
  await navigate(browser, world, 1, "https://github.com/b");
  await settle(bg);
  assert.equal(world.tabs.get(1).groupId, -1);

  // Ушла на другой сайт и вернулась — это снова «открыла сайт правила».
  await navigate(browser, world, 1, "https://example.com/");
  await navigate(browser, world, 1, "https://github.com/c");
  await settle(bg);
  assert.notEqual(world.tabs.get(1).groupId, -1);
});

test("автогруппировка: вкладки в группе и закреплённые не трогаются", async () => {
  const { browser, world } = groupingWorld(
    [
      { id: 1, url: "about:blank", groupId: 9 },
      { id: 2, url: "about:blank", pinned: true },
    ],
    [{ id: 9, windowId: 1, title: "Своя", color: "pink" }]
  );
  const bg = loadBackground(browser);
  await withRules(browser, bg);

  await navigate(browser, world, 1, "https://github.com/");
  await navigate(browser, world, 2, "https://github.com/");
  await settle(bg);

  assert.equal(world.tabs.get(1).groupId, 9);
  assert.equal(world.tabs.get(2).groupId, -1);
  assert.equal(browser.__calls.tabsGroup.length, 0);
});

test("автогруппировка: вкладки, открытые до запуска фона или до правила, не раскладываются сами", async () => {
  const { browser, world } = groupingWorld([{ id: 1, url: "https://github.com/old" }]);
  const bg = loadBackground(browser);
  await withRules(browser, bg);

  // Переход внутри того же сайта у старой вкладки — правило то же, что было.
  await navigate(browser, world, 1, "https://github.com/old2");
  // Незнакомая вкладка (была до фона) — только запоминается.
  world.tabs.set(2, { id: 2, windowId: 1, url: "https://github.com/x", pinned: false, groupId: -1 });
  await browser.tabs.onUpdated.emit(2, { url: "https://github.com/x" }, { ...world.tabs.get(2) });
  await settle(bg);

  assert.equal(browser.__calls.tabsGroup.length, 0);
});

test("автогруппировка: во время восстановления сессии не вмешивается; без правил ничего не делает", async () => {
  const { browser, world } = groupingWorld([{ id: 1, url: "about:blank" }]);
  const bg = loadBackground(browser);
  await bg.settingsReady;
  await navigate(browser, world, 1, "https://github.com/");
  await settle(bg);
  assert.equal(browser.__calls.tabsGroup.length, 0);

  // Отложенная (восстановленная) вкладка только запоминается.
  await withRules(browser, bg);
  await browser.tabs.onCreated.emit({ id: 3, windowId: 1, url: "https://github.com/", discarded: true, groupId: -1 });
  await settle(bg);
  assert.equal(browser.__calls.tabsGroup.length, 0);
});

test("«Применить к открытым вкладкам»: раскладывает подходящие вкладки вне групп и считает их", async () => {
  const { browser, world } = groupingWorld(
    [
      { id: 1, url: "https://github.com/a" },
      { id: 2, url: "https://mail.google.com/" },
      { id: 3, url: "https://example.com/" },
      { id: 4, url: "https://github.com/b", groupId: 9 },
    ],
    [{ id: 9, windowId: 1, title: "Своя" }]
  );
  const bg = loadBackground(browser);
  await withRules(browser, bg);

  const reply = await browser.runtime.onMessage.handlers[0]({ type: "applyGroupRules" }, {});
  assert.equal(reply, 2);
  assert.equal(world.groups.find((g) => g.id === world.tabs.get(1).groupId).title, "Код");
  assert.equal(world.groups.find((g) => g.id === world.tabs.get(2).groupId).title, "Почта");
  assert.equal(world.tabs.get(3).groupId, -1);
  assert.equal(world.tabs.get(4).groupId, 9);
});

test("«Применить к открытым вкладкам»: правила берутся из storage, даже если onChanged ещё не дошёл", async () => {
  const { browser, world } = groupingWorld([
    { id: 1, url: "https://github.com/a" },
    { id: 2, url: "https://news.example.com/" },
  ]);
  const bg = loadBackground(browser);
  await withRules(browser, bg);
  // Страница настроек записала новые правила, а события об этом фон ещё
  // не получил: в памяти старые.
  browser.__storageData.settings = { groupRules: [{ pattern: "example.com", group: "Новости", color: "yellow" }] };

  const reply = await browser.runtime.onMessage.handlers[0]({ type: "applyGroupRules" }, {});
  assert.equal(reply, 1);
  assert.equal(world.tabs.get(1).groupId, -1);
  assert.equal(world.groups.find((g) => g.id === world.tabs.get(2).groupId).title, "Новости");
  assert.equal(bg._getSettings().groupRules[0].group, "Новости");
});

test("автогруппировка: вкладку сгруппировали, пока правило искало группу, — правило её не уводит", async () => {
  const { browser, world } = groupingWorld([{ id: 5, url: "https://github.com/x" }], [{ id: 7, windowId: 1, title: "Код" }]);
  const bg = loadBackground(browser);
  await withRules(browser, bg);
  // Первый tabs.get — вкладка вне группы; к перепроверке перед tabs.group
  // панель уже положила её в группу 7.
  let gets = 0;
  browser.__tabsGetImpl = async (id) => ({ ...world.tabs.get(id), groupId: ++gets === 1 ? -1 : 7 });

  assert.equal(await bg.applyGroupRule(5), false);
  assert.equal(gets, 2);
  assert.equal(browser.__calls.tabsGroup.length, 0);

  // Без группы — ветка создания группы тоже перепроверяет.
  world.groups.length = 0;
  gets = 0;
  assert.equal(await bg.applyGroupRule(5), false);
  assert.equal(browser.__calls.tabsGroup.length, 0);
});

test("настройки: мусор в storage не ломает фон, изменение подхватывается на лету", async () => {
  const browser = createMockBrowser({ initialStorage: { settings: { groupRules: "nope", duplicates: 3 } } });
  const bg = loadBackground(browser);
  await bg.settingsReady;
  assert.deepEqual(bg._getSettings().groupRules, []);
  assert.equal(bg._getSettings().duplicates, true);

  await browser.storage.local.set({ settings: { groupRules: RULES, duplicates: false } });
  assert.equal(bg._getSettings().groupRules.length, 2);
  assert.equal(bg._getSettings().duplicates, false);
});

// ---------------------------------------------------------------- контейнеры

test("снимок: контейнер вкладки сохраняется, у обычных и приватных — нет поля", async () => {
  const browser = createMockBrowser();
  const { captureWindow } = loadBackground(browser);
  const win = {
    id: 1,
    tabs: [
      { url: "https://a.com", title: "A", status: "complete", cookieStoreId: "firefox-container-2" },
      { url: "https://b.com", title: "B", status: "complete", cookieStoreId: "firefox-default" },
      { url: "https://c.com", title: "C", status: "complete" },
    ],
  };
  const { tabs } = await captureWindow(win);
  assert.equal(tabs[0].cookieStoreId, "firefox-container-2");
  assert.ok(!("cookieStoreId" in tabs[1]));
  assert.ok(!("cookieStoreId" in tabs[2]));
});

test("восстановление: вкладка возвращается в свой контейнер; заглушку под неё не берём", async () => {
  const browser = createMockBrowser();
  const { restoreIntoWindow } = loadBackground(browser);
  const created = await restoreIntoWindow(
    1,
    [
      { url: "https://a.com", title: "A", active: true, cookieStoreId: "firefox-container-2" },
      { url: "https://b.com", title: "B", active: false },
    ],
    [42]
  );
  assert.equal(browser.__calls.tabsUpdate.filter(([id, p]) => id === 42 && p.url).length, 0, "контейнер у заглушки не сменить");
  assert.equal(browser.__calls.tabsCreate.length, 2);
  assert.equal(browser.__calls.tabsCreate[0].cookieStoreId, "firefox-container-2");
  assert.ok(!("cookieStoreId" in browser.__calls.tabsCreate[1]));
  assert.equal(created.length, 2);
});

test("восстановление: контейнера больше нет — вкладка возвращается обычной, а не теряется", async () => {
  const browser = createMockBrowser();
  let nextId = 500;
  browser.__tabsCreateImpl = async (props) => {
    if (props.cookieStoreId) throw new Error("No cookie store exists with ID " + props.cookieStoreId);
    return { id: nextId++, ...props };
  };
  const { restoreIntoWindow } = loadBackground(browser);
  const originalError = console.error;
  console.error = () => {};
  try {
    const created = await restoreIntoWindow(1, [{ url: "https://a.com", title: "A", active: true, cookieStoreId: "firefox-container-9" }], [42]);
    assert.equal(created.length, 1);
    assert.equal(browser.__calls.tabsCreate.at(-1).url, "https://a.com");
    assert.ok(!("cookieStoreId" in browser.__calls.tabsCreate.at(-1)));
  } finally {
    console.error = originalError;
  }
});

// ---------------------------------------------------------------- горячие клавиши

test("команда «микрофон»: выключает все звонки, если хоть один включён, иначе включает все; панели узнают", async () => {
  const browser = createMockBrowser();
  const sent = [];
  browser.__runtimeSendMessageImpl = async (msg) => sent.push(msg);
  browser.tabs.sendMessage = async () => ({ live: true });
  browser.__tabsQueryImpl = async () => [
    { id: 1, sharingState: { microphone: true } },
    { id: 2, sharingState: { microphone: true } },
    { id: 3, sharingState: { microphone: false } },
  ];
  const bg = loadBackground(browser);

  assert.equal(await bg.runCommand("toggle-mic"), true);
  assert.deepEqual(Object.keys(Object.fromEntries(bg._getMicSettings())).sort(), ["1", "2"]);
  assert.ok([...bg._getMicSettings().values()].every((m) => m.muted));
  assert.equal(sent.at(-1).type, "micState");

  await bg.runCommand("toggle-mic");
  assert.equal(bg._getMicSettings().size, 0, "включённый на 100% микрофон не хранится");
  assert.deepEqual(sent.at(-1).mic, {});
});

test("команда «микрофон» без звонков ничего не делает; неизвестная команда — false", async () => {
  const browser = createMockBrowser();
  browser.__tabsQueryImpl = async () => [{ id: 1 }];
  const bg = loadBackground(browser);
  assert.equal(await bg.runCommand("toggle-mic"), false);
  assert.equal(await bg.runCommand("nope"), false);
});

test("команда «закрыть дубликаты»: в окне вкладки, остаётся активная копия", async () => {
  const browser = createMockBrowser();
  browser.__tabsQueryImpl = async (q = {}) =>
    q.windowId !== 4
      ? []
      : [
          { id: 1, index: 0, url: "https://a.com/" },
          { id: 2, index: 1, url: "https://a.com/#x", active: true },
          { id: 3, index: 2, url: "https://b.com/" },
        ];
  const bg = loadBackground(browser);
  assert.equal(await bg.runCommand("close-duplicates", { id: 2, windowId: 4 }), 1);
  assert.deepEqual(browser.__calls.tabsRemove, [[1]]);
});

test("команды плеера: скорость шагает от текущей и уходит играющей вкладке", async () => {
  const browser = createMockBrowser();
  browser.__runtimeSendMessageImpl = async () => {};
  const sent = [];
  const base = { meta: { title: "T" }, playing: true, canPlay: true, actions: ["nexttrack"], position: { duration: 100, position: 1 } };
  browser.tabs.sendMessage = async (tabId, msg, opts) => {
    sent.push([tabId, msg, opts]);
    return { state: { ...base, rate: msg.rate || 1.5, canRate: true }, reacted: true };
  };
  const bg = loadBackground(browser);
  bg.onMediaMessage({ state: { ...base, playing: false, rate: 1, canRate: true } }, { tab: { id: 7, windowId: 1 }, frameId: 0 });
  bg.onMediaMessage({ state: { ...base, rate: 1.5, canRate: true } }, { tab: { id: 8, windowId: 1 }, frameId: 2 });

  await bg.runCommand("speed-up");
  assert.deepEqual(sent.at(-1), [8, { type: "mediaControl", action: "rate", seekTime: undefined, rate: 1.75 }, { frameId: 2 }]);
  await bg.runCommand("media-next");
  assert.equal(sent.at(-1)[1].action, "nexttrack");
});

test("скорость: что прислала страница, проверяется; команда скорости вне пределов отклоняется", async () => {
  const browser = createMockBrowser();
  browser.__runtimeSendMessageImpl = async () => {};
  const bg = loadBackground(browser);
  const s = bg.sanitizeMedia({ rate: 999, canRate: "yes" });
  assert.equal(s.rate, 16);
  assert.equal(s.canRate, false);
  assert.equal(bg.sanitizeMedia({}).rate, 1);
  bg.onMediaMessage({ state: { meta: { title: "T" }, playing: true, canRate: true } }, { tab: { id: 7, windowId: 1 }, frameId: 0 });
  assert.equal(await bg.mediaControl({ tabId: 7, frameId: 0, action: "rate", rate: 100 }), false);
});
