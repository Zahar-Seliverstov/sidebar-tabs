"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createMockBrowser, loadBackground } = require("./mock-browser.js");

function load() {
  return loadBackground(createMockBrowser());
}

test("isRestorableUrl: принимает обычные схемы", () => {
  const { isRestorableUrl } = load();
  assert.equal(isRestorableUrl("https://example.com"), true);
  assert.equal(isRestorableUrl("http://example.com"), true);
  assert.equal(isRestorableUrl("file:///home/me/file.txt"), true);
  assert.equal(isRestorableUrl("ftp://example.com/file"), true);
});

test("isRestorableUrl: принимает 'свежие' about:-страницы", () => {
  const { isRestorableUrl } = load();
  assert.equal(isRestorableUrl("about:newtab"), true);
  assert.equal(isRestorableUrl("about:blank"), true);
  assert.equal(isRestorableUrl("about:home"), true);
});

test("isRestorableUrl: отклоняет привилегированные и посторонние схемы", () => {
  const { isRestorableUrl } = load();
  assert.equal(isRestorableUrl("about:config"), false);
  assert.equal(isRestorableUrl("about:addons"), false);
  assert.equal(isRestorableUrl("about:preferences"), false);
  assert.equal(isRestorableUrl("moz-extension://abc-123/page.html"), false);
  assert.equal(isRestorableUrl("chrome://browser/content/browser.xhtml"), false);
  assert.equal(isRestorableUrl("view-source:https://example.com"), false);
  assert.equal(isRestorableUrl("data:text/plain,hi"), false);
});

test("isRestorableUrl: отклоняет пустые/некорректные значения", () => {
  const { isRestorableUrl } = load();
  assert.equal(isRestorableUrl(""), false);
  assert.equal(isRestorableUrl(undefined), false);
  assert.equal(isRestorableUrl(null), false);
  assert.equal(isRestorableUrl("не url вообще"), false);
});

test("looksLikeFreshUrl: только about:newtab/blank/home", () => {
  const { looksLikeFreshUrl } = load();
  assert.equal(looksLikeFreshUrl("about:newtab"), true);
  assert.equal(looksLikeFreshUrl("about:blank"), true);
  assert.equal(looksLikeFreshUrl("about:home"), true);
  assert.equal(looksLikeFreshUrl("https://example.com"), false);
  assert.equal(looksLikeFreshUrl("about:config"), false);
  assert.equal(looksLikeFreshUrl(undefined), false);
});

test("isTransientTab: about:blank в процессе загрузки — переходное состояние", () => {
  const { isTransientTab } = load();
  assert.equal(isTransientTab({ url: "about:blank", status: "loading" }), true);
  assert.equal(isTransientTab({ url: "about:blank", status: "complete" }), false);
  assert.equal(isTransientTab({ url: "https://example.com", status: "loading" }), false);
});
