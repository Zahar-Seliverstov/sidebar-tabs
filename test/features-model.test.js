"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const M = require("../sidebar/model.js");

function tab(id, index, url, overrides = {}) {
  return { id, index, url, title: `T${id}`, pinned: false, active: false, discarded: false, groupId: M.NO_GROUP, ...overrides };
}

// ---------------------------------------------------------------- дубликаты

test("dupKey: якорь не важен, контейнер важен, служебные страницы не в счёт", () => {
  assert.equal(M.dupKey(tab(1, 0, "https://a.com/x#top")), M.dupKey(tab(2, 1, "https://a.com/x")));
  assert.notEqual(M.dupKey(tab(1, 0, "https://a.com/x?q=1")), M.dupKey(tab(2, 1, "https://a.com/x?q=2")));
  assert.notEqual(
    M.dupKey(tab(1, 0, "https://a.com/", { cookieStoreId: "firefox-container-1" })),
    M.dupKey(tab(2, 1, "https://a.com/", { cookieStoreId: "firefox-container-2" }))
  );
  assert.equal(M.dupKey(tab(1, 0, "about:newtab")), null);
  assert.equal(M.dupKey(tab(1, 0, "moz-extension://x/options.html")), null);
  assert.equal(M.dupKey(tab(1, 0, "")), null);
});

test("duplicateSets: только страницы, открытые больше одного раза; скрытые не считаются", () => {
  const tabs = [
    tab(1, 0, "https://a.com/"),
    tab(2, 1, "https://b.com/"),
    tab(3, 2, "https://a.com/#x"),
    tab(4, 3, "https://b.com/", { hidden: true }),
    tab(5, 4, "about:newtab"),
    tab(6, 5, "about:newtab"),
  ];
  const sets = [...M.duplicateSets(tabs).values()].map((l) => l.map((t) => t.id));
  assert.deepEqual(sets, [[1, 3]]);
});

test("duplicatesToClose: остаётся закреплённая, иначе активная, иначе загруженная, иначе первая", () => {
  const tabs = [
    tab(1, 0, "https://a.com/", { discarded: true }),
    tab(2, 1, "https://a.com/", { active: true }),
    tab(3, 2, "https://b.com/", { discarded: true }),
    tab(4, 3, "https://b.com/"),
    tab(5, 4, "https://c.com/", { pinned: true, discarded: true }),
    tab(6, 5, "https://c.com/"),
    tab(7, 6, "https://d.com/"),
    tab(8, 7, "https://d.com/"),
  ];
  assert.deepEqual(M.duplicatesToClose(tabs).sort((a, b) => a - b), [1, 3, 6, 8]);
});

test("duplicatesToClose: закреплённые не закрываются — ни при активной обычной копии, ни парой", () => {
  const withActive = [tab(1, 0, "https://a.com/", { pinned: true }), tab(2, 1, "https://a.com/", { active: true })];
  assert.deepEqual(M.duplicatesToClose(withActive), [2]);
  const twoPinned = [tab(1, 0, "https://a.com/", { pinned: true }), tab(2, 1, "https://a.com/", { pinned: true, active: true })];
  assert.deepEqual(M.duplicatesToClose(twoPinned), []);
});

test("duplicatesToClose: готовые duplicateSets дают тот же результат", () => {
  const tabs = [
    tab(1, 0, "https://a.com/", { discarded: true }),
    tab(2, 1, "https://a.com/", { active: true }),
    tab(3, 2, "https://b.com/", { pinned: true }),
    tab(4, 3, "https://b.com/"),
    tab(5, 4, "https://c.com/"),
  ];
  assert.deepEqual(M.duplicatesToClose(tabs, M.duplicateSets(tabs)), M.duplicatesToClose(tabs));
  assert.deepEqual(M.duplicatesToClose(tabs, M.duplicateSets(tabs)).sort((a, b) => a - b), [1, 4]);
});

test("duplicatesOf: остальные вкладки той же страницы", () => {
  const tabs = [tab(1, 0, "https://a.com/"), tab(2, 1, "https://a.com/#2"), tab(3, 2, "https://b.com/"), tab(4, 3, "https://a.com/")];
  assert.deepEqual(M.duplicatesOf(tabs[0], tabs), [2, 4]);
  assert.deepEqual(M.duplicatesOf(tabs[2], tabs), []);
  assert.deepEqual(M.duplicatesOf(tab(9, 9, "about:blank"), tabs), []);
});

test("duplicatesOf: закреплённые копии не возвращаются", () => {
  const tabs = [tab(1, 0, "https://a.com/", { pinned: true }), tab(2, 1, "https://a.com/"), tab(3, 2, "https://a.com/")];
  assert.deepEqual(M.duplicatesOf(tabs[1], tabs), [3]);
});

// ---------------------------------------------------------------- контейнеры

test("containerOf: обычная вкладка и неизвестный контейнер — null", () => {
  const containers = new Map([["firefox-container-1", { name: "Работа", colorCode: "#37adff" }]]);
  assert.equal(M.containerOf(tab(1, 0, "https://a.com/", { cookieStoreId: "firefox-container-1" }), containers).name, "Работа");
  assert.equal(M.containerOf(tab(1, 0, "https://a.com/", { cookieStoreId: "firefox-default" }), containers), null);
  assert.equal(M.containerOf(tab(1, 0, "https://a.com/", { cookieStoreId: "firefox-container-9" }), containers), null);
  assert.equal(M.containerOf(tab(1, 0, "https://a.com/"), containers), null);
});

test("reopenProps: обычные страницы переоткрываются, новые вкладки — пустыми, служебные — никак", () => {
  assert.deepEqual(M.reopenProps(tab(1, 0, "https://a.com/x")), { url: "https://a.com/x" });
  assert.deepEqual(M.reopenProps(tab(1, 0, "about:newtab")), {});
  assert.deepEqual(M.reopenProps(tab(1, 0, "about:blank")), {});
  assert.equal(M.reopenProps(tab(1, 0, "about:config")), null);
  assert.equal(M.reopenProps(tab(1, 0, "file:///etc/hosts")), null);
});

// ---------------------------------------------------------------- недавно закрытые

test("closedRows: вкладки этого окна и закрытые окна, свежие сверху, не больше limit", () => {
  const sessions = [
    { lastModified: 1000, tab: { sessionId: "a", windowId: 1, title: "A", url: "https://a.com/" } },
    { lastModified: 3000, tab: { sessionId: "b", windowId: 2, title: "B", url: "https://b.com/" } },
    { lastModified: 2000, window: { sessionId: "w", tabs: [{ title: "X", url: "https://x.com/" }, { title: "Y", url: "https://y.com/", active: true, favIconUrl: "y.ico" }] } },
    { lastModified: 4000, tab: { sessionId: "c", windowId: 1, title: "", url: "https://c.com/" } },
  ];
  const rows = M.closedRows(sessions, 1, 10);
  assert.deepEqual(rows.map((r) => r.sessionId), ["c", "w", "a"]);
  assert.equal(rows[0].title, "https://c.com/");
  assert.deepEqual([rows[1].kind, rows[1].count, rows[1].title, rows[1].favIconUrl], ["window", 2, "Y", "y.ico"]);
  assert.equal(M.closedRows(sessions, 1, 2).length, 2);
  assert.deepEqual(M.closedRows(undefined, 1, 5), []);
});

test("closedRows: время в секундах (как у Chrome) переводится в миллисекунды", () => {
  const rows = M.closedRows([{ lastModified: 1700000000, tab: { sessionId: "a", windowId: 1, url: "https://a.com/" } }], 1, 5);
  assert.equal(rows[0].closedAt, 1700000000000);
});

test("timeAgo: коротко по-русски", () => {
  const now = 10 * 24 * 3600e3;
  assert.equal(M.timeAgo(now - 20e3, now), "сейчас");
  assert.equal(M.timeAgo(now - 5 * 60e3, now), "5 мин");
  assert.equal(M.timeAgo(now - 3 * 3600e3, now), "3 ч");
  assert.equal(M.timeAgo(now - 50 * 3600e3, now), "2 дн");
  assert.equal(M.timeAgo(0, now), "");
});

// ---------------------------------------------------------------- скорость

test("stepRate: шаги по 0,25 в пределах 0,25…4, с нестандартной — на ближайшую точку", () => {
  assert.equal(M.stepRate(1, 1), 1.25);
  assert.equal(M.stepRate(1, -1), 0.75);
  assert.equal(M.stepRate(1.1, 1), 1.25);
  assert.equal(M.stepRate(1.1, -1), 1);
  assert.equal(M.stepRate(4, 1), 4);
  assert.equal(M.stepRate(0.25, -1), 0.25);
  assert.equal(M.stepRate(undefined, 1), 1.25);
});

test("stepRate: за пределами 0,25…4 шаг не уводит в обратную сторону", () => {
  assert.equal(M.stepRate(8, 1), 8);
  assert.equal(M.stepRate(8, -1), 4);
  assert.equal(M.stepRate(0.1, -1), 0.1);
  assert.equal(M.stepRate(0.1, 1), 0.25);
});

// ---------------------------------------------------------------- цвета групп

test("GROUP_COLORS: тот же массив, что в shared/settings.js", () => {
  assert.equal(M.GROUP_COLORS, require("../shared/settings.js").GROUP_COLORS);
});

test("formatRate: десятичная запятая", () => {
  assert.equal(M.formatRate(1), "1×");
  assert.equal(M.formatRate(1.25), "1,25×");
  assert.equal(M.formatRate(0.5), "0,5×");
  assert.equal(M.formatRate(NaN), "1×");
});
