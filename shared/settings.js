"use strict";

/*
 * Настройки расширения — общие для фона, панели и страницы настроек.
 * Без DOM и без browser.*: только значения по умолчанию, проверка того,
 * что лежит в storage, правила автогруппировки и вид горячих клавиш.
 *
 * Хранятся одним объектом в storage.local под ключом SETTINGS_KEY. Что бы
 * там ни лежало (старая версия, ручная правка, мусор), normalizeSettings
 * возвращает полный и правильный объект — читающим проверять ничего не нужно.
 *
 * Обёрнуто в функцию: в фоне и в панели файл подключается обычным
 * <script>/scripts из манифеста рядом с другими, и его имена не должны
 * сталкиваться с их верхнеуровневыми const. Наружу — один объект
 * SidebarSettings (в node — module.exports).
 */

(() => {
  const SETTINGS_KEY = "settings";

  const GROUP_COLORS = ["grey", "blue", "purple", "cyan", "green", "yellow", "orange", "red", "pink"];
  const CLOSED_COUNTS = [5, 10, 15, 25];
  const MAX_RULES = 200;
  const MAX_TEXT = 200;

  const DEFAULTS = Object.freeze({
    // Блок «Недавно закрытые» внизу панели и сколько в нём строк.
    closedShown: true,
    closedCount: 10,
    // Блок раскрыт (запоминается сам, на странице настроек его нет).
    closedOpen: false,
    // Отмечать вкладки, открытые больше одного раза.
    duplicates: true,
    // Цветная полоска контейнера Firefox у вкладки.
    containers: true,
    // Горячие клавиши в пунктах меню и подсказках.
    shortcutHints: true,
    // Правила автогруппировки: [{ pattern, group, color }].
    groupRules: Object.freeze([]),
  });

  function text(value) {
    return typeof value === "string" ? value.trim().slice(0, MAX_TEXT) : "";
  }

  function normalizeRule(raw) {
    if (!raw || typeof raw !== "object") return null;
    const pattern = text(raw.pattern);
    const group = text(raw.group);
    if (!pattern || !group) return null;
    const color = GROUP_COLORS.includes(raw.color) ? raw.color : "blue";
    return { pattern, group, color };
  }

  function normalizeSettings(raw) {
    const s = raw && typeof raw === "object" ? raw : {};
    const bool = (key) => (typeof s[key] === "boolean" ? s[key] : DEFAULTS[key]);
    return {
      closedShown: bool("closedShown"),
      closedCount: CLOSED_COUNTS.includes(s.closedCount) ? s.closedCount : DEFAULTS.closedCount,
      closedOpen: bool("closedOpen"),
      duplicates: bool("duplicates"),
      containers: bool("containers"),
      shortcutHints: bool("shortcutHints"),
      groupRules: Array.isArray(s.groupRules) ? s.groupRules.map(normalizeRule).filter(Boolean).slice(0, MAX_RULES) : [],
    };
  }

  // ---------------------------------------------------------------- автогруппировка
  //
  // Правило: адрес → название группы. Адрес пишется так, как его видно
  // в адресной строке, без https://:
  //   github.com            — сайт и все его поддомены (www., gist. …);
  //   *.google.com          — только поддомены;
  //   github.com/mozilla    — страницы под этим путём (github.com/mozilla/…),
  //                           но не github.com/mozillaXYZ;
  //   docs.*.com, */wiki/*  — «*» означает любой кусок адреса;
  //   localhost:3000        — только этот порт; без порта в шаблоне порт
  //                           не важен (localhost — любой порт).
  // Большие и маленькие буквы не различаются, ?запрос не важен.

  function escapeRe(s) {
    return s.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  }

  function globRe(s, star) {
    return s.split("*").map(escapeRe).join(star);
  }

  // "хост[:порт]" → { host, port } (port — null, если не указан) или null.
  // IPv6 пишется в скобках: в [::1] двоеточия — часть адреса, в [::1]:8080
  // порт — то, что после «]».
  function splitPort(hostPort) {
    let host = hostPort;
    let port = null;
    if (hostPort.startsWith("[")) {
      const end = hostPort.indexOf("]");
      if (end === -1) return null;
      host = hostPort.slice(0, end + 1);
      const rest = hostPort.slice(end + 1);
      if (rest) {
        if (rest[0] !== ":") return null;
        port = rest.slice(1);
      }
    } else {
      const colon = hostPort.indexOf(":");
      if (colon !== -1) {
        host = hostPort.slice(0, colon);
        port = hostPort.slice(colon + 1);
      }
      // Двоеточие вне скобок бывает только перед портом.
      if (/[\[\]:]/.test(host)) return null;
    }
    if (port === "") port = null; // «localhost:» — порт не указан
    if (port !== null) {
      if (!/^[0-9*]+$/.test(port)) return null;
      if (!port.includes("*")) {
        // Как в адресной строке: 03000 → 3000; больше 65535 портов нет.
        const n = Number(port);
        if (n > 65535) return null;
        port = String(n);
      }
    }
    return { host, port };
  }

  // RegExp для адреса вида "host[:port]/path" или null, если шаблон бессмысленный.
  function compilePattern(pattern) {
    let p = text(pattern).toLowerCase().replace(/^[a-z]+:\/\//, "");
    if (!p || /\s/.test(p)) return null;
    const slash = p.indexOf("/");
    const hostPort = slash === -1 ? p : p.slice(0, slash);
    const path = slash === -1 ? "" : p.slice(slash);
    if (!hostPort) return null;
    const split = splitPort(hostPort);
    if (!split) return null;
    let { host, port } = split;
    // Кириллический домен (сайт.рф) браузер хранит в punycode (xn--…).
    if (host && !host.includes("*") && /[^\x00-\x7f]/.test(host)) {
      try {
        host = new URL("http://" + host).hostname;
      } catch (e) {
        return null;
      }
    }
    if (!host || !/^[a-z0-9.*\-\[\]:]+$/.test(host)) return null;
    if ((host + (port || "")).replace(/[*.]/g, "") === "" && !path.replace(/[/*]/g, "")) return null;

    // Без «*» в начале правило берёт и поддомены: github.com → www.github.com.
    let re = "^";
    if (host.startsWith("*.")) re += "(?:[^/]+\\.)" + globRe(host.slice(2), "[^/]*");
    else if (host.startsWith("*")) re += globRe(host, "[^/]*");
    else re += "(?:[^/]+\\.)?" + globRe(host, "[^/]*");

    // Порт в адресе есть, только если он не стандартный (см. ruleSubject).
    // Не указан в шаблоне — любой или никакого (хост на «*» съел бы порт
    // и сам, необязательная группа ему не мешает). Указан 80 или 443 —
    // браузер его не показывает, поэтому и без порта подходит.
    if (port === null) re += "(?::\\d+)?";
    else if (port === "80" || port === "443") re += "(?::" + port + ")?";
    else re += ":" + globRe(port, "\\d*");

    if (!path || path === "/") re += "(?:/.*)?$";
    else if (path.endsWith("/") || path.endsWith("*")) re += globRe(path, ".*") + ".*$";
    else re += globRe(path, ".*") + "(?:/.*)?$";
    try {
      return new RegExp(re);
    } catch (e) {
      return null;
    }
  }

  // Скомпилированные шаблоны: matchGroupRule зовётся на каждый переход
  // каждой вкладки, а правил бывает до MAX_RULES. Кэшируется и null
  // (неверный шаблон). RegExp без флага g — test() не хранит состояние,
  // один объект можно отдавать всем. Разросся (шаблоны правят по букве
  // на странице настроек) — сбрасываем целиком.
  const PATTERN_CACHE_MAX = 500;
  const patternCache = new Map();

  function cachedPattern(pattern) {
    if (typeof pattern !== "string") return compilePattern(pattern);
    if (patternCache.has(pattern)) return patternCache.get(pattern);
    if (patternCache.size >= PATTERN_CACHE_MAX) patternCache.clear();
    const re = compilePattern(pattern);
    patternCache.set(pattern, re);
    return re;
  }

  function isValidPattern(pattern) {
    return cachedPattern(pattern) !== null;
  }

  // Что сравнивается с правилом: "host[:port]/path" обычной страницы или null.
  // u.host содержит порт, только если он не стандартный для схемы.
  function ruleSubject(url) {
    try {
      const u = new URL(url);
      if (u.protocol !== "http:" && u.protocol !== "https:") return null;
      let path = u.pathname;
      try {
        path = decodeURI(path);
      } catch (e) {
        // Битая %-последовательность — сравниваем как есть.
      }
      return u.host.toLowerCase() + path.toLowerCase();
    } catch (e) {
      return null;
    }
  }

  // Первое подходящее правило (порядок в списке — приоритет) или null.
  function matchGroupRule(rules, url) {
    if (!Array.isArray(rules) || rules.length === 0) return null;
    const subject = ruleSubject(url);
    if (subject === null) return null;
    for (const rule of rules) {
      const re = cachedPattern(rule.pattern);
      if (re && re.test(subject)) return rule;
    }
    return null;
  }

  // Существующая группа окна с названием из правила (без учёта регистра).
  function findRuleGroup(groups, rule) {
    const want = rule.group.trim().toLowerCase();
    return groups.find((g) => (g.title || "").trim().toLowerCase() === want) || null;
  }

  // ---------------------------------------------------------------- горячие клавиши
  //
  // commands.getAll() отдаёт сочетание строкой вида "Ctrl+Alt+M" (так же оно
  // записано в манифесте). На macOS Firefox пишет "Command"/"MacCtrl" —
  // там показываем привычные значки.

  const MAC_KEYS = { Command: "⌘", MacCtrl: "⌃", Ctrl: "⌘", Alt: "⌥", Shift: "⇧" };
  const KEY_NAMES = { Comma: ",", Period: ".", Up: "↑", Down: "↓", Left: "←", Right: "→", Space: "Пробел", Delete: "Del" };

  function formatShortcut(shortcut, os) {
    if (!shortcut) return "";
    const parts = shortcut.split("+");
    const key = parts.pop();
    const shown = KEY_NAMES[key] || key;
    if (os === "mac") return parts.map((m) => MAC_KEYS[m] || m).join("") + shown;
    return parts.concat(shown).join("+");
  }

  // Клавиша события → имя клавиши для commands.update или null.
  // e.code, а не e.key: в русской раскладке key — «ь», а сочетание то же.
  function shortcutKey(code) {
    let m = /^Key([A-Z])$/.exec(code) || /^Digit([0-9])$/.exec(code) || /^(F[0-9]{1,2})$/.exec(code);
    if (m) return m[1];
    const map = {
      Comma: "Comma",
      Period: "Period",
      Space: "Space",
      Home: "Home",
      End: "End",
      PageUp: "PageUp",
      PageDown: "PageDown",
      Insert: "Insert",
      Delete: "Delete",
      ArrowUp: "Up",
      ArrowDown: "Down",
      ArrowLeft: "Left",
      ArrowRight: "Right",
    };
    return map[code] || null;
  }

  // Сочетание для commands.update из события клавиатуры:
  //   { shortcut }  — готово;
  //   { error }     — так нельзя (и почему);
  //   null          — нажат только модификатор, ждём клавишу.
  function shortcutFromEvent(e, os) {
    if (["Control", "Alt", "Shift", "Meta", "OS", "AltGraph"].includes(e.key)) return null;
    const key = shortcutKey(e.code);
    if (!key) return { error: "Эту клавишу нельзя назначить" };
    const mods = [];
    if (os === "mac") {
      if (e.metaKey) mods.push("Command");
      if (e.ctrlKey) mods.push("MacCtrl");
    } else if (e.ctrlKey) {
      mods.push("Ctrl");
    }
    if (e.altKey) mods.push("Alt");
    const fn = /^F[0-9]{1,2}$/.test(key);
    if (!fn && !mods.some((m) => m !== "Shift")) return { error: "Нужен Ctrl или Alt" };
    if (e.shiftKey) mods.push("Shift");
    return { shortcut: mods.concat(key).join("+") };
  }

  const api = {
    SETTINGS_KEY,
    GROUP_COLORS,
    CLOSED_COUNTS,
    DEFAULTS,
    normalizeSettings,
    normalizeRule,
    compilePattern,
    cachedPattern,
    isValidPattern,
    ruleSubject,
    matchGroupRule,
    findRuleGroup,
    formatShortcut,
    shortcutFromEvent,
  };

  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else globalThis.SidebarSettings = api;
})();
