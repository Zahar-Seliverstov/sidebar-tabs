"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createMockBrowser, loadBackground } = require("./mock-browser.js");

function setup() {
  const browser = createMockBrowser();
  const bg = loadBackground(browser);
  bg._resetState();
  return { browser, bg };
}

const VALID = {
  name: "Тест",
  matches: ["https://example.com/*"],
  js: ["page.js"],
  buttons: [{ id: "like", title: "Нравится", icon: "a.svg", activeIcon: "b.svg" }],
};

test("parsePlugin: кнопки получают ключ «плагин/кнопка» и адреса значков в папке плагина", () => {
  const { bg } = setup();
  const p = bg.parsePlugin("demo", VALID);
  assert.equal(p.defaultEnabled, true);
  assert.deepEqual(p.buttons, [
    {
      key: "demo/like",
      title: "Нравится",
      activeTitle: "Нравится",
      icon: "moz-extension://test/plugins/demo/a.svg",
      activeIcon: "moz-extension://test/plugins/demo/b.svg",
    },
  ]);
});

test("parsePlugin: файлы вне папки плагина и кнопки с плохим id отбрасываются, без matches/js — ошибка", () => {
  const { bg } = setup();
  const p = bg.parsePlugin("demo", {
    ...VALID,
    js: ["../../background.js", "page.js"],
    buttons: [
      { id: "ok", icon: "a.svg", activeIcon: "../x.svg" },
      { id: "Bad Id", icon: "a.svg" },
      { id: "noicon" },
    ],
  });
  assert.deepEqual(p.js, ["page.js"]);
  assert.deepEqual(p.buttons.map((b) => b.key), ["demo/ok"]);
  assert.equal(p.buttons[0].activeIcon, "moz-extension://test/plugins/demo/a.svg");
  assert.throws(() => bg.parsePlugin("demo", { ...VALID, js: [] }));
  assert.throws(() => bg.parsePlugin("demo", { ...VALID, matches: [] }));
  assert.equal(bg.parsePlugin("demo", { ...VALID, enabled: false }).defaultEnabled, false);
});

test("кнопки от страницы: только кнопки включённых плагинов, значения — строго true/false", () => {
  const { bg } = setup();
  const p = bg.parsePlugin("demo", VALID);
  bg._getPlugins().set("demo", p);
  const raw = { "demo/like": "yes", "demo/other": true, "evil/x": true, __proto__: { "demo/like": true } };
  assert.deepEqual(bg.sanitizePluginButtons({ "demo/like": true }), {}, "плагин выключен — кнопок нет");
  p.enabled = true;
  assert.deepEqual(bg.sanitizePluginButtons(raw), { "demo/like": false });
  assert.deepEqual(bg.sanitizePluginButtons({ "demo/like": true }), { "demo/like": true });
  assert.deepEqual(bg.sanitizePluginButtons(null), {});
  assert.equal(bg.isPluginAction("plugin:demo/like"), true);
  assert.equal(bg.isPluginAction("plugin:demo/other"), false);
  assert.equal(bg.isPluginAction("plugin:evil/x"), false);
  assert.equal(bg.sanitizeMedia({ playing: true, plugins: { "demo/like": true } }).plugins["demo/like"], true);
});
