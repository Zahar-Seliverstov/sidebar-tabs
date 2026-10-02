#!/usr/bin/env node
"use strict";

/*
 * Скриншоты панели для README: npm run screenshots → docs/*.png
 * (панель и меню вкладки, в светлой и тёмной теме).
 *
 * Как e2e/run.js: временная копия расширения + временный профиль, Firefox
 * без окна, страницы с e2e/pages. Фон копии получает сцену (вкладки, группы,
 * плееры), открывает панель отдельным окном и снимает её captureVisibleTab.
 * Панель в отдельном окне показывала бы своё окно, поэтому в копии
 * sidebar.js windows.getCurrent() подменяется на окно со сценой.
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { spawn, spawnSync } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..");
const PAGES = path.join(__dirname, "pages");
const OUT = path.join(ROOT, "docs");
const FIREFOX = process.env.FIREFOX || "firefox-developer-edition";
const EXT_ID = "minimal-tab-bar@local.ext";
const SHIP = ["manifest.json", "background.js", "content", "sidebar", "icons"];

// Окно без интерфейса не уже 500 px — ширину панели задаёт CSS, снимок обрезается.
const PANEL = { width: 320, height: 720 };

// ---------------------------------------------------------------- сцена

const demo = (o) => "/demo.html?" + new URLSearchParams(o);

const SCENE = {
  tabs: [
    { key: "mail", pinned: true, url: demo({ title: "Почта — Входящие (3)", icon: "#e5484d", letter: "@" }) },
    { key: "cal", pinned: true, url: demo({ title: "Календарь — октябрь", icon: "#3e63dd", letter: "2" }) },
    { key: "notes", pinned: true, url: demo({ title: "Заметки", icon: "#f5a524", letter: "N" }) },

    { key: "w1", group: "work", url: demo({ title: "Задачи спринта — Трекер", icon: "#5b5bd6", letter: "T" }) },
    { key: "w2", group: "work", url: demo({ title: "Pull request #128: поиск по вкладкам", icon: "#24292f", letter: "P" }) },
    { key: "w3", group: "work", url: demo({ title: "Справочник WebExtensions API", icon: "#0d74ce", letter: "W" }) },
    { key: "w4", group: "work", discard: true, url: demo({ title: "Макеты интерфейса", icon: "#d6409f", letter: "M" }) },

    {
      key: "m1", group: "music",
      url: demo({ title: "Midnight Drive — Neon Avenue", icon: "#8e4ec6", letter: "♪", play: 1, track: "Midnight Drive", artist: "Neon Avenue", art: "#6d5dfc,#ff5fa2", glyph: "♫", dur: 222, pos: 81, delay: 3000 }),
    },
    {
      key: "m2", group: "music", volume: 0.45,
      url: demo({ title: "Выпуск 42: как браузер рисует страницу", icon: "#12a594", letter: "Р", play: 1, track: "Выпуск 42: как браузер рисует страницу", artist: "Подкаст «Под капотом»", art: "#0ea5a4,#2563eb", glyph: "🎙", dur: 3480, pos: 1210, paused: 1 }),
    },
    { key: "m3", group: "music", url: demo({ title: "Плейлист «В дорогу»", icon: "#8e4ec6", letter: "♪" }) },

    { key: "t1", group: "trip", url: demo({ title: "Билеты Москва — Казань", icon: "#30a46c", letter: "✈" }) },
    { key: "t2", group: "trip", url: demo({ title: "Отели в Казани", icon: "#30a46c", letter: "H" }) },
    { key: "t3", group: "trip", url: demo({ title: "Что посмотреть в Казани", icon: "#30a46c", letter: "K" }) },

    { key: "weather", active: true, url: demo({ title: "Погода в Москве: +12°, облачно", icon: "#0090ff", letter: "☁" }) },
    {
      key: "video", muted: true,
      url: demo({ title: "Обзор: лучшие ноутбуки 2026 года", icon: "#e5484d", letter: "▶", play: 1, track: "Обзор: лучшие ноутбуки 2026 года", artist: "Техноблог", art: "#f97316,#e11d48", glyph: "▶", dur: 1260, pos: 344 }),
    },
    { key: "recipe", discard: true, url: demo({ title: "Шарлотка с яблоками — простой рецепт", icon: "#f76b15", letter: "Ш" }) },
    { key: "news", discard: true, url: demo({ title: "Новости технологий", icon: "#6e56cf", letter: "N" }) },
    { key: "shop", url: demo({ title: "Корзина — 2 товара", icon: "#e54666", letter: "₽" }) },
    { key: "docs", url: demo({ title: "Основы CSS Grid — руководство", icon: "#0d74ce", letter: "#" }) },
  ],
  menuOn: "m2",
  groups: {
    work: { title: "Работа", color: "blue" },
    music: { title: "Музыка", color: "purple" },
    trip: { title: "Отпуск", color: "green", collapsed: true },
  },
};

// ---------------------------------------------------------------- фон копии

// Выполняется в фоне расширения (дописывается в manifest копии).
const HOOK = `
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const post = (p, body) => fetch(SHOOT_ORIGIN + p, { method: "POST", body });
  try {
    const scene = await (await fetch(SHOOT_ORIGIN + "/scene")).json();
    const [main] = await browser.windows.getAll({ windowTypes: ["normal"] });
    await browser.windows.update(main.id, { width: 1280, height: 900 });
    const blank = await browser.tabs.query({ windowId: main.id });
    const ids = {};
    for (const t of scene.tabs) {
      const tab = await browser.tabs.create({ windowId: main.id, url: SHOOT_ORIGIN + t.url, pinned: !!t.pinned, active: false });
      ids[t.key] = tab.id;
    }
    await browser.tabs.remove(blank.map((t) => t.id));
    await sleep(2500);
    for (const [g, props] of Object.entries(scene.groups)) {
      const tabIds = scene.tabs.filter((t) => t.group === g).map((t) => ids[t.key]);
      const gid = await browser.tabs.group({ tabIds, createProperties: { windowId: main.id } });
      await browser.tabGroups.update(gid, { title: props.title, color: props.color });
      if (props.collapsed) await browser.tabGroups.update(gid, { collapsed: true });
    }
    const active = scene.tabs.find((t) => t.active);
    await browser.tabs.update(ids[active.key], { active: true });
    for (const t of scene.tabs) {
      if (t.muted) await browser.tabs.update(ids[t.key], { muted: true });
      if (t.volume) await setTabVolume(ids[t.key], t.volume);
      if (t.discard) await browser.tabs.discard(ids[t.key]);
    }
    await sleep(1500);
    const url = browser.runtime.getURL("sidebar/sidebar.html") + "#" + main.id;
    const panel = await browser.windows.create({ url, width: 600, height: scene.panel.height + 200 });
    await sleep(7000);
    const rect = { x: 0, y: 0, width: scene.panel.width, height: scene.panel.height };
    const capture = () => browser.tabs.captureVisibleTab(panel.id, { format: "png", scale: 2, rect });
    await post("/shot?name=panel", await capture());

    // Контекстное меню вкладки с подкастом.
    const view = browser.extension.getViews({ type: "tab" }).find((v) => v.location.pathname.endsWith("/sidebar/sidebar.html"));
    const row = view.document.querySelector('[data-id="' + ids[scene.menuOn] + '"]');
    const r = row.getBoundingClientRect();
    row.dispatchEvent(new view.MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: r.left + 90, clientY: r.top + r.height / 2 }));
    await sleep(800);
    await post("/shot?name=menu", await capture());
    await post("/done", "");
  } catch (err) {
    await post("/error", String(err && err.stack || err));
  }
})();
`;

// ---------------------------------------------------------------- запуск

function prepare(origin, dark) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sidebar-tabs-shot-"));
  const ext = path.join(tmp, "ext");
  const profile = path.join(tmp, "profile");
  fs.mkdirSync(ext);
  fs.mkdirSync(path.join(profile, "extensions"), { recursive: true });
  for (const item of SHIP) fs.cpSync(path.join(ROOT, item), path.join(ext, item), { recursive: true });
  fs.writeFileSync(path.join(ext, "shoot-hook.js"), `const SHOOT_ORIGIN = ${JSON.stringify(origin)};\n${HOOK}`);
  const manifest = JSON.parse(fs.readFileSync(path.join(ext, "manifest.json"), "utf8"));
  manifest.background.scripts.push("shoot-hook.js");
  delete manifest.sidebar_action.open_at_install;
  fs.writeFileSync(path.join(ext, "manifest.json"), JSON.stringify(manifest, null, 2));
  fs.appendFileSync(path.join(ext, "sidebar", "sidebar.css"), `\nhtml { width: ${PANEL.width}px !important; height: ${PANEL.height}px !important; overflow: hidden; }\n`);
  const sidebarJs = path.join(ext, "sidebar", "sidebar.js");
  const src = fs.readFileSync(sidebarJs, "utf8");
  if (!src.includes("browser.windows.getCurrent()")) throw new Error("в sidebar.js нет windows.getCurrent()");
  fs.writeFileSync(sidebarJs, src.replace("browser.windows.getCurrent()", "Promise.resolve({ id: Number(location.hash.slice(1)) })"));
  fs.writeFileSync(path.join(profile, "extensions", EXT_ID), ext + "\n");
  fs.writeFileSync(
    path.join(profile, "user.js"),
    [
      ["xpinstall.signatures.required", false],
      ["extensions.autoDisableScopes", 0],
      ["extensions.enabledScopes", 15],
      ["media.autoplay.default", 0],
      ["media.autoplay.blocking_policy", 0],
      ["media.block-autoplay-until-in-foreground", false],
      ["browser.shell.checkDefaultBrowser", false],
      ["browser.startup.homepage_override.mstone", "ignore"],
      ["datareporting.policy.dataSubmissionEnabled", false],
      ["toolkit.telemetry.reportingpolicy.firstRun", false],
      ["browser.aboutwelcome.enabled", false],
      ["ui.systemUsesDarkTheme", dark ? 1 : 0],
      ["layout.css.prefers-color-scheme.content-override", dark ? 0 : 1],
    ]
      .map(([k, v]) => `user_pref(${JSON.stringify(k)}, ${JSON.stringify(v)});`)
      .join("\n")
  );
  return { tmp, profile };
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => resolve(data));
  });
}

async function shoot(suffix, dark) {
  let done;
  const result = new Promise((resolve, reject) => (done = { resolve, reject }));
  const shots = [];
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://x");
    if (url.pathname === "/scene") return res.end(JSON.stringify({ ...SCENE, panel: PANEL }));
    if (url.pathname === "/shot") {
      const data = await readBody(req);
      shots.push({ name: `${url.searchParams.get("name")}-${suffix}.png`, png: Buffer.from(data.split(",")[1], "base64") });
      return res.end("ok");
    }
    if (url.pathname === "/done") {
      res.end("ok");
      return done.resolve();
    }
    if (url.pathname === "/error") {
      const msg = await readBody(req);
      res.end("ok");
      return done.reject(new Error(msg));
    }
    if (url.pathname === "/page-log") return res.end("ok");
    const file = path.join(PAGES, path.normalize(url.pathname).replace(/^(\.\.[/\\])+/, ""));
    if (!file.startsWith(PAGES) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.statusCode = 404;
      return res.end("not found");
    }
    res.setHeader("content-type", file.endsWith(".js") ? "text/javascript; charset=utf-8" : "text/html; charset=utf-8");
    fs.createReadStream(file).pipe(res);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const origin = `http://127.0.0.1:${server.address().port}`;

  // Пустой аудиовыход: вкладки «звучат» (значок динамика), а в колонках тихо.
  const sink = spawnSync("pactl", ["load-module", "module-null-sink", "sink_name=sidebar_tabs_shot"], { encoding: "utf8" });
  const sinkId = sink.status === 0 ? sink.stdout.trim() : null;
  const env = sinkId ? { ...process.env, PULSE_SINK: "sidebar_tabs_shot" } : process.env;

  const { tmp, profile } = prepare(origin, dark);
  const ff = spawn(FIREFOX, ["--headless", "--no-remote", "--profile", profile, "about:blank"], { stdio: "ignore", env });
  const timer = setTimeout(() => done.reject(new Error("нет снимка за 60 с")), 60000);
  try {
    await result;
    fs.mkdirSync(OUT, { recursive: true });
    for (const { name, png } of shots) {
      fs.writeFileSync(path.join(OUT, name), png);
      console.log("  ✔ docs/" + name);
    }
  } finally {
    clearTimeout(timer);
    ff.kill();
    server.close();
    await new Promise((r) => setTimeout(r, 500));
    if (sinkId) spawnSync("pactl", ["unload-module", sinkId]);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

(async () => {
  await shoot("light", false);
  await shoot("dark", true);
})().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
