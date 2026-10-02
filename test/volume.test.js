"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const { createMockBrowser, loadBackground } = require("./mock-browser.js");

function setup() {
  const browser = createMockBrowser();
  const bg = loadBackground(browser);
  bg._resetState();
  return { browser, bg };
}

function sendMessage(browser, msg) {
  const results = browser.runtime.onMessage.handlers.map((fn) => fn(msg, {}));
  return results.find((r) => r !== undefined);
}

function flush() {
  return new Promise((resolve) => setImmediate(resolve));
}

test("setTabVolume: запоминает громкость и внедряет скрипт во все фреймы вкладки", async () => {
  const { browser, bg } = setup();
  assert.equal(await bg.setTabVolume(7, 0.4), true);
  assert.equal(bg._getTabVolumes().get(7), 0.4);
  const [tabId, details] = browser.__calls.tabsExecuteScript[0];
  assert.equal(tabId, 7);
  assert.equal(details.allFrames, true);
  assert.match(details.code, /const factor = 0\.4;/);
});

test("setTabVolume: 100% снимает регулировку и сбрасывает страницу, а без регулировки ничего не внедряет", async () => {
  const { browser, bg } = setup();
  await bg.setTabVolume(7, 1);
  assert.equal(browser.__calls.tabsExecuteScript.length, 0, "нечего сбрасывать — страницу не трогаем");

  await bg.setTabVolume(7, 0.3);
  await bg.setTabVolume(7, 1);
  assert.equal(bg._getTabVolumes().has(7), false);
  assert.match(browser.__calls.tabsExecuteScript[1][1].code, /const factor = null;/);
});

test("setTabVolume: ошибка инъекции (служебная страница, нет разрешения) не бросается наружу", async () => {
  const { browser, bg } = setup();
  browser.__executeScriptImpl = async () => {
    throw new Error("Missing host permission");
  };
  assert.equal(await bg.setTabVolume(7, 0.5), false);
  assert.equal(bg._getTabVolumes().get(7), 0.5, "значение остаётся — применится после перезагрузки страницы");
});

test("clampVolume: мусор и выход за границы", () => {
  const { bg } = setup();
  assert.equal(bg.clampVolume(-1), 0);
  assert.equal(bg.clampVolume(5), 1);
  assert.equal(bg.clampVolume("abc"), 1);
  assert.equal(bg.clampVolume(0.333333), 0.33);
});

test("громкость применяется заново после перезагрузки и при начале звука, но не в чужих вкладках", async () => {
  const { browser, bg } = setup();
  await bg.setTabVolume(7, 0.5);
  browser.__calls.tabsExecuteScript.length = 0;

  await browser.tabs.onUpdated.emit(7, { status: "complete" }, { id: 7 });
  await browser.tabs.onUpdated.emit(7, { audible: true }, { id: 7 });
  await browser.tabs.onUpdated.emit(7, { title: "x" }, { id: 7 });
  await browser.tabs.onUpdated.emit(8, { status: "complete" }, { id: 8 });
  await flush();

  assert.deepEqual(
    browser.__calls.tabsExecuteScript.map(([id]) => id),
    [7, 7]
  );
});

test("закрытая и заменённая вкладка: громкость забывается / переезжает", async () => {
  const { browser, bg } = setup();
  await bg.setTabVolume(7, 0.5);
  await bg.setTabVolume(8, 0.2);
  await browser.tabs.onRemoved.emit(7, {});
  await browser.tabs.onReplaced.emit(9, 8);
  assert.deepEqual(Object.fromEntries(bg._getTabVolumes()), { 9: 0.2 });
});

test("сообщения панели: getVolumes и setVolume; чужие сообщения игнорируются", async () => {
  const { browser } = setup();
  assert.equal(await sendMessage(browser, { type: "setVolume", tabId: 3, volume: 0.25 }), true);
  assert.deepEqual(await sendMessage(browser, { type: "getVolumes" }), { 3: 0.25 });
  assert.equal(sendMessage(browser, { type: "setVolume", tabId: "3", volume: 0.1 }), undefined);
  assert.equal(sendMessage(browser, "junk"), undefined);
  assert.equal(sendMessage(browser, null), undefined);
});

// Упрощённая модель окружения content-скрипта: без Xray страница и песочница
// видят один и тот же прототип, exportFunction — тождественная функция.
// Настоящее поведение (Xray, exportFunction, CSP) проверено на headless-стенде.
function mediaSandbox() {
  class HTMLMediaElement {
    constructor(volume) {
      this._volume = volume;
      this._time = 0;
    }
    get volume() {
      return this._volume;
    }
    set volume(v) {
      if (!(v >= 0 && v <= 1)) throw new RangeError("IndexSizeError");
      this._volume = v;
    }
    get currentTime() {
      return this._time;
    }
    set currentTime(v) {
      this._time = v;
    }
    play() {
      return "played";
    }
  }
  const actual = (el) => Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, "volume") && el._volume;
  const inDom = [];
  const listeners = [];
  const sandbox = {
    HTMLMediaElement,
    exportFunction: (fn) => fn,
    document: {
      querySelectorAll: () => inDom,
      addEventListener: (type, fn) => listeners.push([type, fn]),
    },
  };
  sandbox.window = sandbox;
  sandbox.wrappedJSObject = sandbox;
  vm.createContext(sandbox);
  return { sandbox, HTMLMediaElement, inDom, listeners, actual };
}

test("внедряемый скрипт: громкость — множитель к громкости сайта, для плееров в DOM и вне его", () => {
  const { bg } = setup();
  const env = mediaSandbox();
  const dom = new env.HTMLMediaElement(0.8);
  const detached = new env.HTMLMediaElement(0.8);
  env.inDom.push(dom);

  vm.runInContext(bg.volumeScript(0.5), env.sandbox);
  assert.equal(dom._volume, 0.4, "плеер в DOM находится сразу");
  assert.equal(detached._volume, 0.8, "плеер вне DOM пока неизвестен");

  detached.currentTime; // плееры постоянно читают currentTime — тут он и ловится
  assert.equal(detached._volume, 0.4);
  assert.equal(detached.volume, 0.8, "сайт видит свою громкость, а не итоговую");

  detached.volume = 0.6; // собственный регулятор сайта
  assert.equal(detached._volume, 0.3);

  vm.runInContext(bg.volumeScript(0.25), env.sandbox);
  assert.equal(dom._volume, 0.2);
  assert.equal(detached._volume, 0.15);

  vm.runInContext(bg.volumeScript(null), env.sandbox);
  assert.equal(dom._volume, 0.8, "сброс возвращает громкость сайта");
  assert.equal(detached._volume, 0.6);
});

test("внедряемый скрипт: play() ловит новые плееры и возвращает результат оригинала", () => {
  const { bg } = setup();
  const env = mediaSandbox();
  vm.runInContext(bg.volumeScript(0.5), env.sandbox);

  const late = new env.HTMLMediaElement(1);
  assert.equal(late.play(), "played");
  assert.equal(late._volume, 0.5);
});

test("внедряемый скрипт: повторная инъекция не переопределяет свойства заново и не вешает обработчики", () => {
  const { bg } = setup();
  const env = mediaSandbox();
  vm.runInContext(bg.volumeScript(0.5), env.sandbox);
  const getter = Object.getOwnPropertyDescriptor(env.HTMLMediaElement.prototype, "volume").get;
  vm.runInContext(bg.volumeScript(0.7), env.sandbox);
  assert.equal(Object.getOwnPropertyDescriptor(env.HTMLMediaElement.prototype, "volume").get, getter);
  assert.equal(env.listeners.length, 1);
});

test("внедряемый скрипт: недопустимое значение от сайта даёт ту же ошибку, что и без расширения", () => {
  const { bg } = setup();
  const env = mediaSandbox();
  vm.runInContext(bg.volumeScript(0.5), env.sandbox);
  const el = new env.HTMLMediaElement(1);
  assert.throws(() => {
    el.volume = 2;
  }, RangeError);
});
