"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const S = require("../shared/settings.js");

// ---------------------------------------------------------------- normalizeSettings

test("normalizeSettings: пусто или мусор — значения по умолчанию", () => {
  for (const raw of [undefined, null, 42, "x", []]) {
    const s = S.normalizeSettings(raw);
    assert.equal(s.closedShown, true);
    assert.equal(s.closedCount, 10);
    assert.equal(s.duplicates, true);
    assert.deepEqual(s.groupRules, []);
  }
});

test("normalizeSettings: неверные типы и значения не проходят, верные сохраняются", () => {
  const s = S.normalizeSettings({ closedShown: "no", closedCount: 7, duplicates: false, containers: 0, shortcutHints: false });
  assert.equal(s.closedShown, true);
  assert.equal(s.closedCount, 10);
  assert.equal(s.duplicates, false);
  assert.equal(s.containers, true);
  assert.equal(s.shortcutHints, false);
  assert.equal(S.normalizeSettings({ closedCount: 25 }).closedCount, 25);
});

test("normalizeSettings: правила без адреса или группы выбрасываются, цвет по умолчанию — синий", () => {
  const s = S.normalizeSettings({
    groupRules: [
      { pattern: " github.com ", group: " Код ", color: "green" },
      { pattern: "", group: "x" },
      { pattern: "a.com", group: "  " },
      { pattern: "b.com", group: "B", color: "rainbow" },
      null,
    ],
  });
  assert.deepEqual(s.groupRules, [
    { pattern: "github.com", group: "Код", color: "green" },
    { pattern: "b.com", group: "B", color: "blue" },
  ]);
});

// ---------------------------------------------------------------- правила

function matches(pattern, url) {
  return S.matchGroupRule([{ pattern, group: "G", color: "blue" }], url) !== null;
}

test("правило-домен берёт сайт и его поддомены, но не похожие домены", () => {
  assert.ok(matches("github.com", "https://github.com/"));
  assert.ok(matches("github.com", "https://gist.github.com/x"));
  assert.ok(matches("github.com", "http://www.github.com/mozilla/firefox?tab=1#top"));
  assert.ok(!matches("github.com", "https://notgithub.com/"));
  assert.ok(!matches("github.com", "https://github.com.evil.org/"));
});

test("*.домен — только поддомены", () => {
  assert.ok(matches("*.google.com", "https://mail.google.com/"));
  assert.ok(!matches("*.google.com", "https://google.com/"));
});

test("путь — страницы под ним, без «склеенных» соседей", () => {
  assert.ok(matches("github.com/mozilla", "https://github.com/mozilla"));
  assert.ok(matches("github.com/mozilla", "https://github.com/mozilla/gecko-dev/issues"));
  assert.ok(!matches("github.com/mozilla", "https://github.com/mozillaXYZ"));
  assert.ok(!matches("github.com/mozilla", "https://github.com/"));
  assert.ok(matches("github.com/moz*", "https://github.com/mozillaXYZ"));
});

test("звёздочка в середине и в начале", () => {
  assert.ok(matches("docs.*.com", "https://docs.python.com/3/"));
  assert.ok(matches("*/wiki/*", "https://ru.wikipedia.org/wiki/Firefox"));
  assert.ok(!matches("*/wiki/*", "https://ru.wikipedia.org/w/index.php"));
});

test("схема в шаблоне и регистр не мешают; служебные страницы не группируются", () => {
  assert.ok(matches("https://GitHub.com", "https://github.com/x"));
  assert.ok(matches("github.com/Mozilla", "https://github.com/mozilla/x"));
  assert.ok(!matches("github.com", "about:newtab"));
  assert.ok(!matches("github.com", "moz-extension://abc/github.com"));
  assert.ok(!matches("github.com", "не адрес"));
});

test("кириллический домен и путь", () => {
  assert.ok(matches("президент.рф", "https://xn--d1abbgf6aiiy.xn--p1ai/news"));
  assert.ok(matches("ru.wikipedia.org/wiki/Москва", "https://ru.wikipedia.org/wiki/%D0%9C%D0%BE%D1%81%D0%BA%D0%B2%D0%B0"));
});

test("порт: указан в шаблоне — только он, не указан — любой", () => {
  assert.ok(matches("localhost:3000", "http://localhost:3000/app"));
  assert.ok(!matches("localhost:3000", "http://localhost:4000/"));
  assert.ok(!matches("localhost:3000", "http://localhost/"));
  assert.ok(!matches("localhost:3000", "http://localhost:30000/"));
  assert.ok(matches("localhost", "http://localhost:4000/"));
  assert.ok(matches("localhost", "http://localhost/"));
  assert.ok(matches("github.com", "https://github.com:8443/x"));
  assert.ok(matches("github.com/mozilla", "https://github.com:8443/mozilla/x"));
  assert.ok(matches("localhost:3000/app", "http://localhost:3000/app/x"));
  assert.ok(!matches("localhost:3000/app", "http://localhost:4000/app"));
});

test("порт: поддомены по «*.», хост на «*», стандартный порт", () => {
  assert.ok(matches("*.example.com:8080", "http://a.example.com:8080/"));
  assert.ok(!matches("*.example.com:8080", "http://a.example.com:9090/"));
  assert.ok(!matches("*.example.com:8080", "http://a.example.com/"));
  assert.ok(matches("example.*", "http://example.com:9090/x"));
  assert.ok(matches("*:8080", "http://anything.local:8080/"));
  assert.ok(!matches("*:8080", "http://anything.local:18080/"));
  // 443/80 браузер в адресе не показывает.
  assert.ok(matches("example.com:443", "https://example.com/"));
  assert.ok(matches("localhost:03000", "http://localhost:3000/"));
});

test("порт: IPv6 в скобках — двоеточия внутри адреса не порт", () => {
  assert.ok(matches("[::1]", "http://[::1]/"));
  assert.ok(matches("[::1]", "http://[::1]:8080/x"));
  assert.ok(matches("[::1]:8080", "http://[::1]:8080/x"));
  assert.ok(!matches("[::1]:8080", "http://[::1]:9090/"));
  assert.ok(!matches("[::1]:8080", "http://[::1]/"));
  for (const p of ["[::1]", "[::1]:8080", "localhost:3000", "*.example.com:8080"]) assert.equal(S.isValidPattern(p), true, p);
  for (const p of ["[::1", "[::1]x", "::1", "localhost:abc", "localhost:70000", "a:1:2", "*:*"]) assert.equal(S.isValidPattern(p), false, p);
});

test("шаблоны кэшируются: тот же RegExp, неверный — тоже из кэша", () => {
  const a = S.cachedPattern("cache-test.example.com");
  assert.ok(a instanceof RegExp);
  assert.equal(S.cachedPattern("cache-test.example.com"), a);
  assert.equal(S.cachedPattern("cache test"), null);
  assert.equal(S.cachedPattern("cache test"), null);
  // Переполнение кэша не ломает ответы.
  for (let i = 0; i < 600; i++) assert.ok(S.cachedPattern(`site${i}.test`) instanceof RegExp);
  assert.ok(matches("cache-test.example.com", "https://cache-test.example.com/"));
});

test("бессмысленные шаблоны не принимаются", () => {
  for (const p of ["", "   ", "*", "*.*", "a b.com", "/путь"]) assert.equal(S.isValidPattern(p), false, p);
  for (const p of ["github.com", "*.google.com", "*/wiki/*", "localhost", "192.168.1.1"]) assert.equal(S.isValidPattern(p), true, p);
});

test("matchGroupRule: побеждает первое подходящее правило", () => {
  const rules = [
    { pattern: "github.com/mozilla", group: "Mozilla", color: "orange" },
    { pattern: "github.com", group: "Код", color: "green" },
  ];
  assert.equal(S.matchGroupRule(rules, "https://github.com/mozilla/x").group, "Mozilla");
  assert.equal(S.matchGroupRule(rules, "https://github.com/torvalds").group, "Код");
  assert.equal(S.matchGroupRule([], "https://github.com/"), null);
});

test("findRuleGroup: группа окна с тем же названием, без учёта регистра и пробелов", () => {
  const groups = [{ id: 1, title: "Работа" }, { id: 2, title: " код " }];
  assert.equal(S.findRuleGroup(groups, { group: "Код" }).id, 2);
  assert.equal(S.findRuleGroup(groups, { group: "Почта" }), null);
});

// ---------------------------------------------------------------- горячие клавиши

test("formatShortcut: как есть на Linux/Windows, значки на macOS", () => {
  assert.equal(S.formatShortcut("Ctrl+Alt+M", "linux"), "Ctrl+Alt+M");
  assert.equal(S.formatShortcut("Ctrl+Alt+Period", "win"), "Ctrl+Alt+.");
  assert.equal(S.formatShortcut("Command+Shift+M", "mac"), "⌘⇧M");
  assert.equal(S.formatShortcut("MacCtrl+M", "mac"), "⌃M");
  assert.equal(S.formatShortcut("", "linux"), "");
  assert.equal(S.formatShortcut(undefined, "linux"), "");
});

function key(code, mods = {}, keyName = "x") {
  return { code, key: keyName, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...mods };
}

test("shortcutFromEvent: сочетание по физической клавише (работает и в русской раскладке)", () => {
  assert.deepEqual(S.shortcutFromEvent(key("KeyM", { ctrlKey: true, altKey: true }, "ь"), "linux"), { shortcut: "Ctrl+Alt+M" });
  assert.deepEqual(S.shortcutFromEvent(key("Period", { ctrlKey: true, shiftKey: true }, "ю"), "linux"), { shortcut: "Ctrl+Shift+Period" });
  assert.deepEqual(S.shortcutFromEvent(key("F7"), "linux"), { shortcut: "F7" });
  assert.deepEqual(S.shortcutFromEvent(key("KeyK", { metaKey: true }), "mac"), { shortcut: "Command+K" });
});

test("shortcutFromEvent: один модификатор — ждём, без Ctrl/Alt или чужая клавиша — ошибка", () => {
  assert.equal(S.shortcutFromEvent(key("ControlLeft", { ctrlKey: true }, "Control"), "linux"), null);
  assert.ok(S.shortcutFromEvent(key("KeyM", { shiftKey: true }), "linux").error);
  assert.ok(S.shortcutFromEvent(key("Backquote", { ctrlKey: true }), "linux").error);
});
