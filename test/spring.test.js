"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { springEasing } = require("../sidebar/spring.js");

test("springEasing: кривая от 0 до 1, длительность до успокоения", () => {
  const { easing, duration } = springEasing({ stiffness: 520, damping: 42, mass: 1 });
  assert.match(easing, /^linear\(0, .*, 1\)$/);
  const points = easing.slice(7, -1).split(", ").map(Number);
  assert.ok(points.every((p) => Number.isFinite(p)));
  assert.ok(duration > 150 && duration < 1200, String(duration));
});

test("springEasing: мягкая пружина перелетает цель («трещотка»), тугая — нет", () => {
  const max = (o) => Math.max(...springEasing(o).easing.slice(7, -1).split(", ").map(Number));
  assert.ok(max({ stiffness: 420, damping: 24, mass: 0.9 }) > 1.02);
  assert.ok(max({ stiffness: 520, damping: 42, mass: 1 }) <= 1.01);
});

test("springEasing: одинаковые параметры — та же кривая из кэша", () => {
  const o = { stiffness: 300, damping: 30, mass: 1 };
  assert.equal(springEasing(o), springEasing({ ...o }));
});
