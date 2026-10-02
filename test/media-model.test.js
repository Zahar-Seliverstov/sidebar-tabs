"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { mediaRows, mediaPosition, formatTime } = require("../sidebar/model.js");

test("mediaRows: порядок как пришёл, без пересортировки по состоянию", () => {
  const paused = { tabId: 1, playing: false, playedAt: 900 };
  const playing = { tabId: 2, playing: true, playedAt: 100 };
  assert.deepEqual(mediaRows([paused, playing]).map((s) => s.tabId), [1, 2]);
});

test("mediaRows: одна строка на вкладку — играющий фрейм важнее", () => {
  const frameA = { tabId: 1, frameId: 0, playing: false, playedAt: 100 };
  const frameB = { tabId: 1, frameId: 5, playing: true, playedAt: 50 };
  const other = { tabId: 2, playing: false, playedAt: 10 };
  assert.deepEqual(mediaRows([frameA, other, frameB]), [frameB, other]);
  assert.deepEqual(mediaRows(undefined), []);
});

test("mediaPosition: досчитывает позицию по времени и скорости, не выходя за длительность", () => {
  const pos = { duration: 100, position: 10, rate: 2, at: 1000 };
  assert.equal(mediaPosition(pos, true, 4000), 16);
  assert.equal(mediaPosition(pos, false, 4000), 10, "на паузе позиция стоит");
  assert.equal(mediaPosition(pos, true, 1000000), 100);
  assert.equal(mediaPosition(null, true, 0), null);
  assert.equal(mediaPosition({ duration: 0, position: 0, rate: 1, at: 0 }, true, 0), null, "прямой эфир без длительности");
});

test("formatTime: минуты:секунды, часы при необходимости, мусор → 0:00", () => {
  assert.equal(formatTime(0), "0:00");
  assert.equal(formatTime(65.9), "1:05");
  assert.equal(formatTime(3725), "1:02:05");
  assert.equal(formatTime(NaN), "0:00");
  assert.equal(formatTime(-3), "0:00");
});
