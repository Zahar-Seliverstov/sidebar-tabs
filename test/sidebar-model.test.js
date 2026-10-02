"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { buildLayout, planDrop, computeMoveIndex, rangeBetween, dropZone, NO_GROUP } = require("../sidebar/model.js");

function tab(id, index, overrides = {}) {
  return { id, index, url: `https://t${id}.com`, title: `T${id}`, pinned: false, active: false, groupId: NO_GROUP, ...overrides };
}

function byId(tabs) {
  return new Map(tabs.map((t) => [t.id, t]));
}

function groups(...list) {
  return new Map(list.map((g) => [g.id, { title: "", color: "grey", collapsed: false, ...g }]));
}

function shape(rows) {
  return rows.map((r) => (r.kind === "group" ? `g${r.group.id}:${r.count}` : `t${r.tab.id}`));
}

// ---------------------------------------------------------------- buildLayout

test("buildLayout: закреплённые отделяются, остальные идут по index, а не по порядку массива", () => {
  const tabs = [tab(3, 2), tab(1, 0, { pinned: true }), tab(2, 1)];
  const { pinned, rows } = buildLayout(tabs, new Map());
  assert.deepEqual(pinned.map((t) => t.id), [1]);
  assert.deepEqual(shape(rows), ["t2", "t3"]);
});

test("buildLayout: заголовок группы вставляется перед её вкладками и считает их", () => {
  const tabs = [tab(1, 0), tab(2, 1, { groupId: 7 }), tab(3, 2, { groupId: 7 }), tab(4, 3)];
  const { rows } = buildLayout(tabs, groups({ id: 7, title: "Work" }));
  assert.deepEqual(shape(rows), ["t1", "g7:2", "t2", "t3", "t4"]);
  assert.equal(rows[1].group.title, "Work");
});

test("buildLayout: соседние разные группы получают каждая свой заголовок", () => {
  const tabs = [tab(1, 0, { groupId: 7 }), tab(2, 1, { groupId: 8 })];
  const { rows } = buildLayout(tabs, groups({ id: 7 }, { id: 8 }));
  assert.deepEqual(shape(rows), ["g7:1", "t1", "g8:1", "t2"]);
});

test("buildLayout: свёрнутая группа прячет вкладки, кроме активной, но считает все", () => {
  const tabs = [tab(1, 0, { groupId: 7 }), tab(2, 1, { groupId: 7, active: true }), tab(3, 2, { groupId: 7 })];
  const { rows } = buildLayout(tabs, groups({ id: 7, collapsed: true }));
  assert.deepEqual(shape(rows), ["g7:3", "t2"]);
});

test("buildLayout: скрытые вкладки (tab.hidden) не показываются", () => {
  const { rows } = buildLayout([tab(1, 0), tab(2, 1, { hidden: true })], new Map());
  assert.deepEqual(shape(rows), ["t1"]);
});

test("buildLayout: группа без пришедших метаданных рисуется с нейтральными значениями, без падения", () => {
  const { rows } = buildLayout([tab(1, 0, { groupId: 9 })], new Map());
  assert.deepEqual(shape(rows), ["g9:1", "t1"]);
  assert.equal(rows[0].group.color, "grey");
  assert.equal(rows[0].group.collapsed, false);
});

test("buildLayout: не мутирует входной массив", () => {
  const tabs = [tab(2, 1), tab(1, 0)];
  buildLayout(tabs, new Map());
  assert.deepEqual(tabs.map((t) => t.id), [2, 1]);
});

// ---------------------------------------------------------------- planDrop

test("planDrop: бросок на середину вкладки вне группы создаёт новую группу с ней", () => {
  const tabs = byId([tab(1, 0), tab(2, 1)]);
  const plan = planDrop([2], { kind: "tab", tabId: 1, zone: "onto" }, tabs);
  assert.deepEqual(plan.group, { type: "new", withTabId: 1 });
  assert.deepEqual(plan.anchor, { tabId: 1, side: "after" });
});

test("planDrop: бросок на середину вкладки в группе — вступление в её группу", () => {
  const tabs = byId([tab(1, 0, { groupId: 5 }), tab(2, 1)]);
  const plan = planDrop([2], { kind: "tab", tabId: 1, zone: "onto" }, tabs);
  assert.deepEqual(plan.group, { type: "join", groupId: 5 });
});

test("planDrop: before/after вкладки принимают её принадлежность группе", () => {
  const tabs = byId([tab(1, 0, { groupId: 5 }), tab(2, 1), tab(3, 2, { groupId: 5 })]);
  assert.deepEqual(planDrop([3], { kind: "tab", tabId: 2, zone: "before" }, tabs).group, { type: "ungroup" });
  assert.deepEqual(planDrop([2], { kind: "tab", tabId: 1, zone: "after" }, tabs).group, { type: "join", groupId: 5 });
});

test("planDrop: бросок на заголовок группы — вступление без перемещения по якорю", () => {
  const plan = planDrop([2], { kind: "group", groupId: 5 }, byId([tab(2, 0)]));
  assert.deepEqual(plan, { ids: [2], group: { type: "join", groupId: 5 }, anchor: null });
});

test("planDrop: бросок на пустое место — выход из группы и в конец", () => {
  const plan = planDrop([2], { kind: "end" }, byId([tab(2, 0, { groupId: 5 })]));
  assert.deepEqual(plan, { ids: [2], group: { type: "ungroup" }, anchor: { end: true } });
});

test("planDrop: вкладку на саму себя бросить нельзя", () => {
  const tabs = byId([tab(1, 0)]);
  assert.equal(planDrop([1], { kind: "tab", tabId: 1, zone: "onto" }, tabs), null);
  assert.equal(planDrop([1], { kind: "tab", tabId: 1, zone: "before" }, tabs), null);
});

test("planDrop: выделение, брошенное на одну из своих же вкладок, группирует остальные с ней", () => {
  const tabs = byId([tab(1, 0), tab(2, 1), tab(3, 2)]);
  const plan = planDrop([1, 2, 3], { kind: "tab", tabId: 2, zone: "onto" }, tabs);
  assert.deepEqual(plan.ids, [1, 3]);
  assert.deepEqual(plan.group, { type: "new", withTabId: 2 });
});

test("planDrop: закреплённые и обычные вкладки не смешиваются", () => {
  const tabs = byId([tab(1, 0, { pinned: true }), tab(2, 1, { pinned: true }), tab(3, 2)]);
  assert.equal(planDrop([3], { kind: "tab", tabId: 1, zone: "before" }, tabs), null);
  assert.equal(planDrop([1], { kind: "tab", tabId: 3, zone: "after" }, tabs), null);
  assert.equal(planDrop([1], { kind: "group", groupId: 5 }, tabs), null);
  assert.equal(planDrop([1], { kind: "end" }, tabs), null);
});

test("planDrop: закреплённые переставляются между собой без групповых операций", () => {
  const tabs = byId([tab(1, 0, { pinned: true }), tab(2, 1, { pinned: true })]);
  const plan = planDrop([2], { kind: "tab", tabId: 1, zone: "before" }, tabs);
  assert.deepEqual(plan, { ids: [2], group: null, anchor: { tabId: 1, side: "before" } });
});

test("planDrop: вкладка из другого окна (нет в tabsById) обрабатывается как обычная", () => {
  const plan = planDrop([99], { kind: "tab", tabId: 1, zone: "after" }, byId([tab(1, 0)]));
  assert.deepEqual(plan, { ids: [99], group: { type: "ungroup" }, anchor: { tabId: 1, side: "after" } });
});

// ---------------------------------------------------------------- computeMoveIndex

const five = [tab(1, 0), tab(2, 1), tab(3, 2), tab(4, 3), tab(5, 4)];

test("computeMoveIndex: перенос вниз учитывает изъятие самой вкладки", () => {
  // 1 после 4 → [2,3,4,1,5] → index 3
  assert.equal(computeMoveIndex(five, [1], { tabId: 4, side: "after" }), 3);
  // 1 перед 4 → [2,3,1,4,5] → index 2
  assert.equal(computeMoveIndex(five, [1], { tabId: 4, side: "before" }), 2);
});

test("computeMoveIndex: перенос вверх", () => {
  // 5 перед 2 → [1,5,2,3,4] → index 1
  assert.equal(computeMoveIndex(five, [5], { tabId: 2, side: "before" }), 1);
  assert.equal(computeMoveIndex(five, [5], { tabId: 2, side: "after" }), 2);
});

test("computeMoveIndex: несколько вкладок по разные стороны от якоря", () => {
  // [1,5] после 3 → [2,3,1,5,4] → index 2
  assert.equal(computeMoveIndex(five, [1, 5], { tabId: 3, side: "after" }), 2);
});

test("computeMoveIndex: конец, пустой якорь и якорь среди перемещаемых", () => {
  assert.equal(computeMoveIndex(five, [1], { end: true }), -1);
  assert.equal(computeMoveIndex(five, [1], null), null);
  assert.equal(computeMoveIndex(five, [1, 2], { tabId: 2, side: "after" }), null);
  assert.equal(computeMoveIndex(five, [1], { tabId: 42, side: "after" }), null);
});

// ---------------------------------------------------------------- мелочи

test("rangeBetween: диапазон в обе стороны и без опорной вкладки", () => {
  assert.deepEqual(rangeBetween([1, 2, 3, 4], 2, 4), [2, 3, 4]);
  assert.deepEqual(rangeBetween([1, 2, 3, 4], 4, 2), [2, 3, 4]);
  assert.deepEqual(rangeBetween([1, 2, 3, 4], null, 3), [3]);
  assert.deepEqual(rangeBetween([1, 2, 3, 4], 1, 9), []);
});

test("dropZone: края строки — вставка, середина — группировка; без групп середины нет", () => {
  assert.equal(dropZone(2, 24, true), "before");
  assert.equal(dropZone(12, 24, true), "onto");
  assert.equal(dropZone(22, 24, true), "after");
  assert.equal(dropZone(11, 24, false), "before");
  assert.equal(dropZone(13, 24, false), "after");
});

// ---------------------------------------------------------------- заголовок группы при переносе вкладок

test("planDrop: верхний край заголовка группы — вне групп, перед этой группой", () => {
  const tabs = byId([tab(1, 0, { groupId: 5 }), tab(2, 1, { groupId: 6 }), tab(3, 2, { groupId: 6 }), tab(4, 3)]);
  const plan = planDrop([4], { kind: "group", groupId: 6, zone: "before" }, tabs);
  assert.deepEqual(plan, { ids: [4], group: { type: "ungroup" }, anchor: { tabId: 2, side: "before" } });
});

test("planDrop: середина/низ заголовка группы — вступление в группу", () => {
  const tabs = byId([tab(1, 0, { groupId: 5 }), tab(2, 1)]);
  assert.deepEqual(planDrop([2], { kind: "group", groupId: 5, zone: "onto" }, tabs).group, { type: "join", groupId: 5 });
});

test("planDrop: верх заголовка собственной группы для её первой вкладки — нет смысла", () => {
  const tabs = byId([tab(1, 0, { groupId: 5 }), tab(2, 1, { groupId: 5 })]);
  assert.equal(planDrop([1], { kind: "group", groupId: 5, zone: "before" }, tabs), null);
});

// ---------------------------------------------------------------- planGroupDrop

const { planGroupDrop } = require("../sidebar/model.js");

// [p1] [2] [3 g5] [4 g5] [5] [6 g7] [7 g7] [8]
function layoutWithGroups() {
  return byId([
    tab(1, 0, { pinned: true }),
    tab(2, 1),
    tab(3, 2, { groupId: 5 }),
    tab(4, 3, { groupId: 5 }),
    tab(5, 4),
    tab(6, 5, { groupId: 7 }),
    tab(7, 6, { groupId: 7 }),
    tab(8, 7),
  ]);
}

test("planGroupDrop: рядом с вкладкой вне групп — прямо до/после неё", () => {
  const plan = planGroupDrop(5, { kind: "tab", tabId: 8, zone: "after" }, layoutWithGroups());
  assert.deepEqual(plan, { groupId: 5, memberIds: [3, 4], anchor: { tabId: 8, side: "after" } });
});

test("planGroupDrop: цель внутри чужой группы притягивается к её краю", () => {
  const tabs = layoutWithGroups();
  assert.deepEqual(planGroupDrop(5, { kind: "tab", tabId: 7, zone: "before" }, tabs).anchor, { tabId: 6, side: "before" });
  assert.deepEqual(planGroupDrop(5, { kind: "tab", tabId: 6, zone: "after" }, tabs).anchor, { tabId: 7, side: "after" });
});

test("planGroupDrop: на заголовок чужой группы — перед ней или после неё", () => {
  const tabs = layoutWithGroups();
  assert.deepEqual(planGroupDrop(5, { kind: "group", groupId: 7, zone: "before" }, tabs).anchor, { tabId: 6, side: "before" });
  assert.deepEqual(planGroupDrop(5, { kind: "group", groupId: 7, zone: "after" }, tabs).anchor, { tabId: 7, side: "after" });
});

test("planGroupDrop: на себя, на закреплённые и в пустоту", () => {
  const tabs = layoutWithGroups();
  assert.equal(planGroupDrop(5, { kind: "group", groupId: 5, zone: "before" }, tabs), null);
  assert.equal(planGroupDrop(5, { kind: "tab", tabId: 3, zone: "after" }, tabs), null);
  assert.equal(planGroupDrop(5, { kind: "tab", tabId: 1, zone: "after" }, tabs), null);
  assert.deepEqual(planGroupDrop(5, { kind: "end" }, tabs).anchor, { end: true });
});

test("planGroupDrop + computeMoveIndex: итоговая позиция первой вкладки группы", () => {
  const tabs = layoutWithGroups();
  const all = [...tabs.values()];
  // группа 5 после группы 7: [p1][2][5][6][7][3][4][8] → первая вкладка группы на index 5
  const down = planGroupDrop(5, { kind: "group", groupId: 7, zone: "after" }, tabs);
  assert.equal(computeMoveIndex(all, down.memberIds, down.anchor), 5);
  // группа 7 перед группой 5: [p1][2][6][7][3][4][5][8] → index 2
  const up = planGroupDrop(7, { kind: "group", groupId: 5, zone: "before" }, tabs);
  assert.equal(computeMoveIndex(all, up.memberIds, up.anchor), 2);
});

test("planGroupDrop: группа из другого окна (участников здесь нет) всё равно получает якорь", () => {
  const plan = planGroupDrop(99, { kind: "tab", tabId: 2, zone: "before" }, layoutWithGroups());
  assert.deepEqual(plan, { groupId: 99, memberIds: [], anchor: { tabId: 2, side: "before" } });
});
