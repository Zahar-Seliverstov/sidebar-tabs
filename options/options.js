"use strict";

/*
 * Страница настроек. Всё сохраняется сразу (storage.local, ключ
 * SidebarSettings.SETTINGS_KEY); фон и открытые панели подхватывают
 * изменения сами через storage.onChanged.
 *
 * Горячие клавиши хранит не расширение, а Firefox: читаются через
 * commands.getAll(), меняются через commands.update/reset — те же самые,
 * что в about:addons → «Управление горячими клавишами дополнений».
 */

const S = SidebarSettings;
const GROUP_COLOR_NAMES = {
  grey: "серый",
  blue: "синий",
  purple: "фиолетовый",
  cyan: "голубой",
  green: "зелёный",
  yellow: "жёлтый",
  orange: "оранжевый",
  red: "красный",
  pink: "розовый",
};
const SAVE_DELAY_MS = 300;

let settings = S.normalizeSettings(null);
// Правила, как они в редакторе (в том числе недописанные — без названия).
let rules = [];
let saveTimer = 0;
let savedTimer = 0;
let os = "linux";

const $rules = document.getElementById("rules");
const $ruleTpl = document.getElementById("rule-tpl");
const $saved = document.getElementById("saved");
const $rulesStatus = document.getElementById("rules-status");

function report(err) {
  console.error("[sidebar-tabs] options", err);
}

// ---------------------------------------------------------------- сохранение

// Промис записи: кому важно, что настройки уже в storage («Применить
// к открытым вкладкам»), ждёт его. Ошибка записи уже показана в консоли,
// промис всё равно выполняется — остальные вызовы его просто не ждут.
function save() {
  settings = S.normalizeSettings({ ...settings, groupRules: rules });
  return browser.storage.local.set({ [S.SETTINGS_KEY]: settings }).then(() => {
    $saved.hidden = false;
    clearTimeout(savedTimer);
    savedTimer = setTimeout(() => ($saved.hidden = true), 1500);
  }, report);
}

function saveSoon() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(save, SAVE_DELAY_MS);
}

// ---------------------------------------------------------------- переключатели

function renderToggles() {
  for (const el of document.querySelectorAll("[data-setting]")) {
    const key = el.dataset.setting;
    if (el.type === "checkbox") el.checked = settings[key];
    else el.value = String(settings[key]);
  }
  for (const row of document.querySelectorAll("[data-depends]")) {
    row.classList.toggle("disabled", !settings[row.dataset.depends]);
  }
}

document.addEventListener("change", (e) => {
  const el = e.target.closest("[data-setting]");
  if (!el) return;
  const key = el.dataset.setting;
  settings[key] = el.type === "checkbox" ? el.checked : el.dataset.number !== undefined ? Number(el.value) : el.value;
  renderToggles();
  save();
});

// ---------------------------------------------------------------- правила

function renderRules() {
  $rules.textContent = "";
  if (rules.length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = "Правил пока нет.";
    $rules.append(empty);
  }
  rules.forEach((rule, i) => $rules.append(makeRule(rule, i)));
  updateProbe();
}

function makeRule(rule, index) {
  const el = $ruleTpl.content.firstElementChild.cloneNode(true);
  el.dataset.index = index;
  const pattern = el.querySelector(".rule-pattern");
  const group = el.querySelector(".rule-group");
  pattern.value = rule.pattern;
  group.value = rule.group;

  const swatches = el.querySelector(".swatches");
  for (const color of S.GROUP_COLORS) {
    const sw = document.createElement("button");
    sw.type = "button";
    sw.className = "swatch";
    sw.dataset.color = color;
    sw.title = GROUP_COLOR_NAMES[color];
    sw.setAttribute("role", "radio");
    sw.setAttribute("aria-checked", String(rule.color === color));
    sw.style.setProperty("--gc", `var(--c-${color})`);
    swatches.append(sw);
  }

  el.querySelector('[data-act="up"]').disabled = index === 0;
  el.querySelector('[data-act="down"]').disabled = index === rules.length - 1;
  validateRule(el, rule);
  return el;
}

function validateRule(el, rule) {
  const bad = rule.pattern.trim() !== "" && !S.isValidPattern(rule.pattern);
  el.querySelector(".rule-pattern").classList.toggle("invalid", bad);
  el.querySelector(".rule-error").hidden = !bad;
}

function ruleIndexOf(node) {
  const el = node.closest(".rule");
  return el ? Number(el.dataset.index) : -1;
}

$rules.addEventListener("input", (e) => {
  const i = ruleIndexOf(e.target);
  if (i < 0) return;
  if (e.target.classList.contains("rule-pattern")) rules[i].pattern = e.target.value;
  else if (e.target.classList.contains("rule-group")) rules[i].group = e.target.value;
  validateRule(e.target.closest(".rule"), rules[i]);
  updateProbe();
  saveSoon();
});

$rules.addEventListener("click", (e) => {
  const i = ruleIndexOf(e.target);
  if (i < 0) return;
  const sw = e.target.closest(".swatch");
  if (sw) {
    rules[i].color = sw.dataset.color;
    for (const b of sw.parentElement.children) b.setAttribute("aria-checked", String(b === sw));
    save();
    return;
  }
  const act = e.target.closest("[data-act]")?.dataset.act;
  if (act === "remove") rules.splice(i, 1);
  else if (act === "up" && i > 0) [rules[i - 1], rules[i]] = [rules[i], rules[i - 1]];
  else if (act === "down" && i < rules.length - 1) [rules[i + 1], rules[i]] = [rules[i], rules[i + 1]];
  else return;
  renderRules();
  save();
});

document.getElementById("rule-add").addEventListener("click", () => {
  rules.push({ pattern: "", group: "", color: S.GROUP_COLORS[(rules.length + 1) % S.GROUP_COLORS.length] });
  renderRules();
  $rules.querySelector(".rule:last-child .rule-pattern").focus();
});

document.getElementById("rules-apply").addEventListener("click", async () => {
  clearTimeout(saveTimer);
  $rulesStatus.textContent = "…";
  try {
    // Фон перечитывает настройки из storage — ждём, пока запись дойдёт.
    await save();
    const n = await browser.runtime.sendMessage({ type: "applyGroupRules" });
    $rulesStatus.textContent = n ? `Разложено по группам: ${n}` : "Подходящих вкладок вне групп нет";
  } catch (err) {
    report(err);
    $rulesStatus.textContent = "Не получилось — подробности в консоли";
  }
});

// Проверка адреса: какое правило сработает.
const $probe = document.getElementById("probe-url");
const $probeResult = document.getElementById("probe-result");

function updateProbe() {
  const url = $probe.value.trim();
  if (!url) {
    $probeResult.textContent = "";
    return;
  }
  const full = /^[a-z]+:\/\//i.test(url) ? url : "https://" + url;
  const rule = S.matchGroupRule(S.normalizeSettings({ groupRules: rules }).groupRules, full);
  $probeResult.className = "probe-result" + (rule ? " hit" : "");
  $probeResult.textContent = rule ? `→ группа «${rule.group}»` : "→ ни одно правило не подходит";
}

$probe.addEventListener("input", updateProbe);

// ---------------------------------------------------------------- горячие клавиши

const $shortcuts = document.getElementById("shortcuts");
let recording = null;

async function renderShortcuts() {
  if (!browser.commands) return;
  const list = await browser.commands.getAll();
  $shortcuts.textContent = "";
  for (const c of list) {
    const row = document.createElement("div");
    row.className = "shortcut";
    row.dataset.name = c.name;

    const label = document.createElement("span");
    label.className = "shortcut-label";
    label.textContent = c.description || c.name;

    const key = document.createElement("button");
    key.type = "button";
    key.className = "kbd" + (c.shortcut ? "" : " none");
    key.dataset.act = "record";
    key.textContent = c.shortcut ? S.formatShortcut(c.shortcut, os) : "не назначено";
    key.title = "Нажмите, чтобы назначить другое сочетание";

    const tools = document.createElement("span");
    tools.className = "shortcut-tools";
    const clear = document.createElement("button");
    clear.type = "button";
    clear.className = "icon-btn";
    clear.dataset.act = "clear";
    clear.textContent = "✕";
    clear.title = "Убрать сочетание";
    clear.disabled = !c.shortcut;
    const reset = document.createElement("button");
    reset.type = "button";
    reset.className = "icon-btn";
    reset.dataset.act = "reset";
    reset.textContent = "↺";
    reset.title = "Вернуть сочетание по умолчанию";
    tools.append(clear, reset);

    const error = document.createElement("span");
    error.className = "shortcut-error";
    error.hidden = true;

    row.append(label, key, tools, error);
    $shortcuts.append(row);
  }
}

function showShortcutError(row, text) {
  const el = row.querySelector(".shortcut-error");
  el.textContent = text;
  el.hidden = !text;
}

function stopRecording() {
  if (!recording) return;
  recording.classList.remove("recording");
  recording = null;
}

$shortcuts.addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-act]");
  const row = e.target.closest(".shortcut");
  if (!btn || !row) return;
  const name = row.dataset.name;
  showShortcutError(row, "");
  try {
    if (btn.dataset.act === "record") {
      stopRecording();
      recording = btn;
      btn.classList.add("recording");
      btn.textContent = "Нажмите сочетание… (Esc — отмена)";
      btn.focus();
      return;
    }
    if (btn.dataset.act === "clear") await browser.commands.update({ name, shortcut: "" });
    else if (btn.dataset.act === "reset") await browser.commands.reset(name);
    await renderShortcuts();
  } catch (err) {
    report(err);
    showShortcutError(row, "Firefox не принял: " + (err && err.message ? err.message : err));
  }
});

document.addEventListener(
  "keydown",
  async (e) => {
    if (!recording) return;
    e.preventDefault();
    e.stopPropagation();
    const row = recording.closest(".shortcut");
    if (e.key === "Escape") {
      stopRecording();
      await renderShortcuts();
      return;
    }
    const result = S.shortcutFromEvent(e, os);
    if (!result) return;
    if (result.error) {
      showShortcutError(row, result.error);
      return;
    }
    // Своё же сочетание у другой команды — Firefox бы молча принял, а
    // сработала бы только одна.
    const list = await browser.commands.getAll();
    const clash = list.find((c) => c.name !== row.dataset.name && c.shortcut === result.shortcut);
    if (clash) {
      showShortcutError(row, `Уже назначено: «${clash.description || clash.name}»`);
      return;
    }
    stopRecording();
    try {
      await browser.commands.update({ name: row.dataset.name, shortcut: result.shortcut });
      await renderShortcuts();
    } catch (err) {
      report(err);
      await renderShortcuts();
      const fresh = $shortcuts.querySelector(`[data-name="${CSS.escape(row.dataset.name)}"]`);
      if (fresh) showShortcutError(fresh, "Firefox не принял это сочетание");
    }
  },
  true
);

document.addEventListener("mousedown", (e) => {
  if (recording && !recording.contains(e.target)) {
    stopRecording();
    renderShortcuts().catch(report);
  }
});

const $openShortcuts = document.getElementById("open-shortcuts");
if (browser.commands && typeof browser.commands.openShortcutSettings === "function") {
  document.getElementById("shortcuts-more").hidden = false;
  $openShortcuts.addEventListener("click", () => browser.commands.openShortcutSettings().catch(report));
}

// ---------------------------------------------------------------- старт

async function checkContainers() {
  const note = document.getElementById("containers-note");
  try {
    if (!browser.contextualIdentities) throw new Error("no api");
    const list = await browser.contextualIdentities.query({});
    if (list.length === 0) note.textContent += " Контейнеров пока нет — их создают в настройках Firefox.";
  } catch (err) {
    note.textContent += " Сейчас контейнеры выключены в Firefox (privacy.userContext.enabled).";
  }
}

(async () => {
  try {
    const [stored, info] = await Promise.all([
      browser.storage.local.get(S.SETTINGS_KEY),
      browser.runtime.getPlatformInfo().catch(() => ({ os: "linux" })),
    ]);
    os = info.os;
    settings = S.normalizeSettings(stored[S.SETTINGS_KEY]);
    rules = settings.groupRules.map((r) => ({ ...r }));
    renderToggles();
    renderRules();
    await Promise.all([renderShortcuts(), checkContainers()]);
  } catch (err) {
    report(err);
  }
})();

// Настройку поменяли в другом месте (панель запомнила «раскрыт ли блок»,
// вторая вкладка настроек) — переключатели показывают правду. Правила в
// редакторе не трогаем, пока их здесь же правят.
browser.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !changes[S.SETTINGS_KEY]) return;
  const next = S.normalizeSettings(changes[S.SETTINGS_KEY].newValue);
  settings = { ...next, groupRules: settings.groupRules };
  renderToggles();
});
if (browser.commands && browser.commands.onChanged) browser.commands.onChanged.addListener(() => renderShortcuts().catch(report));
