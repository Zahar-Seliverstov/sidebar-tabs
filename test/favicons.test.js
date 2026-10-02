"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createMockBrowser, loadBackground } = require("./mock-browser.js");
const { iconFor } = require("../sidebar/model.js");

function flush() {
  return new Promise((resolve) => setImmediate(resolve));
}

function page(url, overrides = {}) {
  return { url, incognito: false, ...overrides };
}

async function load(t, options) {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const browser = createMockBrowser(options);
  const bg = loadBackground(browser);
  await bg._faviconsLoaded;
  bg._resetState();
  return { browser, bg };
}

async function tickSave(t, bg) {
  t.mock.timers.tick(bg.FAVICONS_SAVE_MS);
  await flush();
  await flush();
}

test("favicons: иконка запоминается по hostname и пишется на диск одной записью", async (t) => {
  const { browser, bg } = await load(t);

  bg.rememberFavicon(page("https://github.com/a"), "https://github.com/favicon.ico");
  bg.rememberFavicon(page("https://example.com/"), "data:image/png;base64,AAAA");
  assert.equal(browser.__calls.storageSet.length, 0, "запись отложена, а не на каждое изменение");

  await tickSave(t, bg);

  assert.equal(browser.__calls.storageSet.length, 1);
  assert.deepEqual(browser.__storageData[bg.FAVICONS_KEY], {
    "github.com": "https://github.com/favicon.ico",
    "example.com": "data:image/png;base64,AAAA",
  });
});

test("favicons: троттлинг — непрерывный поток изменений не откладывает запись бесконечно", async (t) => {
  const { browser, bg } = await load(t);

  for (let i = 0; i < 10; i++) {
    bg.rememberFavicon(page(`https://s${i}.com/`), `https://s${i}.com/i.png`);
    t.mock.timers.tick(bg.FAVICONS_SAVE_MS / 4);
    await flush();
    await flush();
  }
  assert.ok(browser.__calls.storageSet.length >= 1);
});

test("favicons: та же иконка повторно не вызывает записи", async (t) => {
  const { browser, bg } = await load(t);
  bg.rememberFavicon(page("https://a.com/1"), "https://a.com/i.png");
  await tickSave(t, bg);
  bg.rememberFavicon(page("https://a.com/2"), "https://a.com/i.png");
  await tickSave(t, bg);
  assert.equal(browser.__calls.storageSet.length, 1);
});

test("favicons: приватные вкладки, служебные страницы и неподходящие иконки не кэшируются", async (t) => {
  const { bg } = await load(t);
  bg.rememberFavicon(page("https://secret.com/", { incognito: true }), "https://secret.com/i.png");
  bg.rememberFavicon(page("about:addons"), "chrome://mozapps/skin/extensions/extension.svg");
  bg.rememberFavicon(page("https://a.com/"), "chrome://global/skin/icons/defaultFavicon.svg");
  bg.rememberFavicon(page("https://b.com/"), "data:text/html,<script>");
  bg.rememberFavicon(page("https://c.com/"), "data:image/svg+xml," + "x".repeat(bg.FAVICON_MAX_LENGTH));
  bg.rememberFavicon(null, "https://x.com/i.png");
  assert.equal(bg._getFavicons().size, 0);
});

test("favicons: при переполнении вытесняются самые давно обновлённые", async (t) => {
  const { bg } = await load(t);
  for (let i = 0; i < bg.FAVICONS_MAX + 3; i++) {
    bg.rememberFavicon(page(`https://s${i}.com/`), `https://s${i}.com/i.png`);
  }
  const hosts = [...bg._getFavicons().keys()];
  assert.equal(hosts.length, bg.FAVICONS_MAX);
  assert.equal(hosts[0], "s3.com");
  assert.equal(hosts[hosts.length - 1], `s${bg.FAVICONS_MAX + 2}.com`);
});

test("favicons: кэш с диска подмешивается, свежие значения из памяти важнее", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const browser = createMockBrowser({
    initialStorage: { favicons: { "a.com": "https://a.com/old.png", "b.com": "https://b.com/i.png" } },
  });
  let releaseGet;
  const realGet = browser.storage.local.get;
  browser.storage.local.get = (key) => new Promise((resolve) => (releaseGet = () => resolve(realGet(key))));

  const bg = loadBackground(browser);
  bg.rememberFavicon(page("https://a.com/"), "https://a.com/new.png");
  releaseGet();
  await bg._faviconsLoaded;

  assert.deepEqual(Object.fromEntries(bg._getFavicons()), {
    "b.com": "https://b.com/i.png",
    "a.com": "https://a.com/new.png",
  });
});

test("favicons: tabs.onUpdated с новой иконкой обновляет кэш", async (t) => {
  const { browser, bg } = await load(t);
  await browser.tabs.onUpdated.emit(1, { favIconUrl: "https://a.com/i.png" }, page("https://a.com/x"));
  assert.equal(bg._getFavicons().get("a.com"), "https://a.com/i.png");
});

test("favicons: при запуске кэш наполняется иконками уже открытых вкладок", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const browser = createMockBrowser();
  browser.__tabsQueryImpl = async () => [page("https://a.com/", { favIconUrl: "https://a.com/i.png" }), page("https://b.com/")];
  const bg = loadBackground(browser);
  await flush();
  assert.deepEqual(Object.fromEntries(bg._getFavicons()), { "a.com": "https://a.com/i.png" });
});

test("iconFor: своя иконка вкладки важнее кэша, кэш — по hostname, иначе пусто", () => {
  const cache = new Map([["a.com", "https://a.com/cached.png"]]);
  assert.equal(iconFor({ url: "https://a.com/x", favIconUrl: "https://a.com/own.png" }, cache), "https://a.com/own.png");
  assert.equal(iconFor({ url: "https://a.com/deep/page?q=1" }, cache), "https://a.com/cached.png");
  assert.equal(iconFor({ url: "https://b.com/" }, cache), "");
  assert.equal(iconFor({ url: "about:newtab" }, cache), "");
  assert.equal(iconFor({ url: "not a url" }, cache), "");
  assert.equal(iconFor({ url: "https://a.com/" }, new Map()), "");
});
