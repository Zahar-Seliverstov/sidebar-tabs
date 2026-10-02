"use strict";

// Лёгкий (без зависимостей) фейк WebExtension `browser.*` API для юнит-тестов
// background.js. Только то, что реально использует расширение.

function createEvent() {
  const listeners = [];
  return {
    addListener(fn) {
      listeners.push(fn);
    },
    removeListener(fn) {
      const idx = listeners.indexOf(fn);
      if (idx !== -1) listeners.splice(idx, 1);
    },
    async emit(...args) {
      for (const fn of listeners.slice()) {
        await fn(...args);
      }
    },
    get listenerCount() {
      return listeners.length;
    },
    // Для событий, где важен возвращаемый обработчиком результат
    // (runtime.onMessage отвечает промисом), emit его теряет.
    get handlers() {
      return listeners.slice();
    },
  };
}

function createMockBrowser({ initialStorage = {}, withTabGroups = false } = {}) {
  const storageData = { ...initialStorage };
  const calls = {
    storageSet: [],
    tabsCreate: [],
    tabsUpdate: [],
    tabsRemove: [],
    windowsCreate: [],
    tabsGroup: [],
    tabsUngroup: [],
    tabGroupsUpdate: [],
    tabsExecuteScript: [],
  };

  let nextTabId = 1000;
  let nextWindowId = 100;
  let nextGroupId = 1;

  const browser = {
    tabs: {
      onCreated: createEvent(),
      onRemoved: createEvent(),
      onMoved: createEvent(),
      onAttached: createEvent(),
      onDetached: createEvent(),
      onReplaced: createEvent(),
      onUpdated: createEvent(),
      create: async (props) => {
        calls.tabsCreate.push(props);
        if (browser.__tabsCreateImpl) return browser.__tabsCreateImpl(props);
        return { id: nextTabId++, ...props };
      },
      update: async (tabId, props) => {
        calls.tabsUpdate.push([tabId, props]);
        if (browser.__tabsUpdateImpl) return browser.__tabsUpdateImpl(tabId, props);
        return { id: tabId, ...props };
      },
      remove: async (ids) => {
        calls.tabsRemove.push(ids);
      },
      executeScript: async (tabId, details) => {
        calls.tabsExecuteScript.push([tabId, details]);
        if (browser.__executeScriptImpl) return browser.__executeScriptImpl(tabId, details);
        return [];
      },
      query: async (queryInfo) => {
        if (browser.__tabsQueryImpl) return browser.__tabsQueryImpl(queryInfo);
        return [];
      },
      // tabs.group()/tabGroups.* — относительно новый API Firefox. По умолчанию
      // отсутствует в моке, как на старом Firefox: код должен деградировать
      // без ошибок (typeof browser.tabs.group !== "function"). Включается
      // явно через withTabGroups для тестов самой функциональности групп.
      ...(withTabGroups
        ? {
            group: async (options) => {
              calls.tabsGroup.push(options);
              // Как схема Firefox: в createProperties допустим только windowId,
              // а вместе с groupId createProperties нельзя вовсе.
              const cp = options.createProperties;
              if (cp !== undefined) {
                const extra = Object.keys(cp).filter((k) => k !== "windowId");
                if (extra.length) throw new Error(`Type error for parameter options (Error processing createProperties: Unexpected property "${extra[0]}")`);
                if (options.groupId !== undefined) throw new Error("Cannot specify both groupId and createProperties");
              }
              if (browser.__tabsGroupImpl) return browser.__tabsGroupImpl(options);
              return nextGroupId++;
            },
            ungroup: async (tabIds) => {
              calls.tabsUngroup.push(tabIds);
            },
          }
        : {}),
    },
    windows: {
      onCreated: createEvent(),
      onRemoved: createEvent(),
      getAll: async (...args) => {
        if (browser.__windowsGetAllImpl) return browser.__windowsGetAllImpl(...args);
        return [];
      },
      create: async (props) => {
        calls.windowsCreate.push(props);
        const win = {
          id: nextWindowId++,
          type: "normal",
          incognito: false,
          tabs: [
            {
              id: nextTabId++,
              url: "about:newtab",
              title: "New Tab",
              pinned: false,
              active: true,
              status: "complete",
            },
          ],
        };
        if (browser.__windowsCreateImpl) return browser.__windowsCreateImpl(props, win);
        return win;
      },
    },
    ...(withTabGroups
      ? {
          tabGroups: {
            onCreated: createEvent(),
            onUpdated: createEvent(),
            onRemoved: createEvent(),
            onMoved: createEvent(),
            query: async (queryInfo) => {
              if (browser.__tabGroupsQueryImpl) return browser.__tabGroupsQueryImpl(queryInfo);
              return [];
            },
            get: async (groupId) => {
              if (browser.__tabGroupsGetImpl) return browser.__tabGroupsGetImpl(groupId);
              return { id: groupId };
            },
            update: async (groupId, props) => {
              calls.tabGroupsUpdate.push([groupId, props]);
              const extra = Object.keys(props).filter((k) => !["title", "color", "collapsed"].includes(k));
              if (extra.length) throw new Error(`Unexpected property "${extra[0]}"`);
              if (browser.__tabGroupsUpdateImpl) return browser.__tabGroupsUpdateImpl(groupId, props);
              return { id: groupId, ...props };
            },
          },
        }
      : {}),
    storage: {
      local: {
        get: async (key) => {
          if (typeof key === "string") return { [key]: storageData[key] };
          return { ...storageData };
        },
        set: async (obj) => {
          calls.storageSet.push(obj);
          if (browser.__storageSetImpl) await browser.__storageSetImpl(obj);
          Object.assign(storageData, obj);
        },
      },
    },
    runtime: {
      onStartup: createEvent(),
      onMessage: createEvent(),
    },
    __calls: calls,
    __storageData: storageData,
  };

  return browser;
}

// Требует background.js со свежим состоянием модуля (require.cache очищается)
// под конкретный мок browser. setInterval подменяется на время загрузки —
// иначе периодический таймер (10с) держит процесс `node --test` живым.
function loadBackground(mockBrowser) {
  const backgroundPath = require.resolve("../background.js");
  delete require.cache[backgroundPath];

  const realSetInterval = global.setInterval;
  global.setInterval = () => 0;
  global.browser = mockBrowser;
  try {
    return require(backgroundPath);
  } finally {
    global.setInterval = realSetInterval;
  }
}

module.exports = { createMockBrowser, createEvent, loadBackground };
