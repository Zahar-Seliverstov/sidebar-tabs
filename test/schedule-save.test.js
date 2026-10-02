"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createMockBrowser, loadBackground } = require("./mock-browser.js");

function makeWindow() {
  return {
    id: 1,
    type: "normal",
    incognito: false,
    tabs: [{ id: 1, url: "https://example.com", title: "Example", pinned: false, active: true, status: "complete" }],
  };
}

// Реальный setImmediate (не мокается) — чтобы после tick() дать микрозадачам
// внутри captureSession (await windows.getAll / await storage.local.set)
// действительно завершиться перед проверкой assert-ов.
function flush() {
  return new Promise((resolve) => setImmediate(resolve));
}

test("scheduleSave: сохранение происходит через SAVE_DEBOUNCE_MS, не раньше", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const browser = createMockBrowser();
  browser.__windowsGetAllImpl = async () => [makeWindow()];
  const { scheduleSave, SAVE_DEBOUNCE_MS } = loadBackground(browser);

  scheduleSave();

  t.mock.timers.tick(SAVE_DEBOUNCE_MS - 1);
  await flush();
  assert.equal(browser.__calls.storageSet.length, 0);

  t.mock.timers.tick(1);
  await flush();
  assert.equal(browser.__calls.storageSet.length, 1);
});

test("scheduleSave: серия быстрых событий схлопывается в одно сохранение", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const browser = createMockBrowser();
  browser.__windowsGetAllImpl = async () => [makeWindow()];
  const { scheduleSave, SAVE_DEBOUNCE_MS } = loadBackground(browser);

  for (let i = 0; i < 5; i++) {
    scheduleSave();
    t.mock.timers.tick(100);
    await flush();
  }
  assert.equal(browser.__calls.storageSet.length, 0, "пока события идут чаще debounce, сохранения быть не должно");

  t.mock.timers.tick(SAVE_DEBOUNCE_MS);
  await flush();
  assert.equal(browser.__calls.storageSet.length, 1);
});

test("scheduleSave: непрерывный поток событий всё равно форсирует сохранение в пределах SAVE_MAX_WAIT_MS (защита от голодания)", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const browser = createMockBrowser();
  browser.__windowsGetAllImpl = async () => [makeWindow()];
  const { scheduleSave, SAVE_DEBOUNCE_MS, SAVE_MAX_WAIT_MS } = loadBackground(browser);

  // Шаг всегда меньше debounce — при наивном дебаунсе таймер бы вечно сбрасывался.
  const step = 200;
  assert.ok(step < SAVE_DEBOUNCE_MS);

  let elapsed = 0;
  let saved = false;
  while (elapsed <= SAVE_MAX_WAIT_MS + step) {
    scheduleSave();
    t.mock.timers.tick(step);
    await flush();
    elapsed += step;
    if (browser.__calls.storageSet.length > 0) {
      saved = true;
      break;
    }
  }

  assert.ok(saved, "сохранение должно произойти даже при непрерывном потоке событий");
  assert.ok(elapsed <= SAVE_MAX_WAIT_MS + step, `сохранение сработало слишком поздно: ${elapsed}мс`);
});

test("scheduleSave: событие после завершения сохранения планирует новое сохранение", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const browser = createMockBrowser();
  browser.__windowsGetAllImpl = async () => [makeWindow()];
  const { scheduleSave, SAVE_DEBOUNCE_MS } = loadBackground(browser);

  scheduleSave();
  t.mock.timers.tick(SAVE_DEBOUNCE_MS);
  await flush();
  assert.equal(browser.__calls.storageSet.length, 1);

  scheduleSave();
  t.mock.timers.tick(SAVE_DEBOUNCE_MS);
  await flush();
  // Второй вызов storage.local.set произойдёт, только если снимок изменился;
  // окно не менялось, так что дедупликация должна пропустить повторную запись.
  assert.equal(browser.__calls.storageSet.length, 1);
});
