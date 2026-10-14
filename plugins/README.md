# Плагины

Плагин добавляет в строку плеера панели кнопку, которой нет в стандартном
пульте: «в мою музыку», «нравится», «скачать» — всё, что сайт умеет делать
своей кнопкой. Плагины включаются и выключаются кнопкой с пазлом вверху
панели.

## Как устроен

```
plugins/
  index.json            ← список папок плагинов: ["vk-favorite", "мой-плагин"]
  мой-плагин/
    plugin.json         ← где работает и какие кнопки показывает
    page.js             ← поведение кнопок на странице сайта
    icon.svg …          ← значки кнопок (24×24, рисуются цветом текста панели)
```

**plugin.json**

```json
{
  "name": "Сайт: нравится",
  "description": "Подсказка в меню плагинов",
  "matches": ["https://example.com/*"],
  "js": ["page.js"],
  "allFrames": false,
  "enabled": true,
  "buttons": [
    { "id": "like", "title": "Нравится", "activeTitle": "Уже нравится — убрать",
      "icon": "heart.svg", "activeIcon": "heart-fill.svg" }
  ]
}
```

- `matches` — [шаблоны адресов](https://developer.mozilla.org/docs/Mozilla/Add-ons/WebExtensions/Match_patterns): только на этих сайтах подключается `page.js`.
- `enabled: false` — плагин выключен, пока его не включат в панели.
- id плагина (имя папки) и кнопок — латиница в нижнем регистре, цифры и `-`.

**page.js** — работает на странице сайта (как content-скрипт расширения):

```js
// setup выполняется один раз на страницу (скрипт может попасть в неё дважды).
SidebarTabs.plugin("мой-плагин", (plugin) => {
  plugin.button("like", {
    // null — кнопки сейчас нет; иначе active: подсвечена ли (activeIcon/activeTitle).
    state() {
      const b = document.querySelector(".like-button");
      return b ? { active: b.classList.contains("liked") } : null;
    },
    // Нажатие в панели. Новое состояние панель узнаёт из state().
    press() {
      document.querySelector(".like-button").click();
    },
  });

  // Если меняется только кнопка (а не трек), сообщите панели:
  new MutationObserver(() => SidebarTabs.update()).observe(document.body, { subtree: true, attributes: true });
});
```

Кнопка видна, пока на вкладке что-то играет и `state()` не вернул `null`.
После нажатия панель ждёт до 1,5 с, пока `state()` изменится, и показывает
то, что получилось на самом деле.

Чтобы плагин попал в расширение: добавьте папку в `index.json` и соберите
`./build.sh`. Пример — `vk-favorite/`.
