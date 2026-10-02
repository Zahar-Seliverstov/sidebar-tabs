<div align="center">

<img src="icons/icon.svg" width="96" alt="Sidebar Tabs">

# Sidebar Tabs

Компактная панель вкладок в боковой панели Firefox — с нативными группами,
плеером, громкостью для каждой вкладки и автосохранением сессии на случай краша.

![Firefox 140+](https://img.shields.io/badge/Firefox-140%2B-FF7139?logo=firefoxbrowser&logoColor=white)
![Без зависимостей](https://img.shields.io/badge/зависимости-0-brightgreen)
[![test](../../actions/workflows/test.yml/badge.svg)](../../actions/workflows/test.yml)
[![release](https://img.shields.io/github/v/release/Zahar-Seliverstov/sidebar-tabs)](../../releases/latest)
![MIT](https://img.shields.io/badge/license-MIT-blue)

<br>

<table>
  <tr>
    <td><img src="docs/panel-light.png?v=5.11.0" width="320" alt="Панель в светлой теме: группы вкладок и плеер"></td>
    <td><img src="docs/panel-dark.png?v=5.11.0" width="320" alt="Панель в тёмной теме: группы вкладок и плеер"></td>
  </tr>
  <tr>
    <td align="center"><sub>Светлая тема</sub></td>
    <td align="center"><sub>Тёмная тема — цвета берутся из системы и темы Firefox</sub></td>
  </tr>
</table>

</div>

## Возможности

**Вкладки**
- Вертикальный список вкладок в боковой панели: закреплённые сверху, компактные строки.
- Нативные группы вкладок Firefox — создание, сворачивание, перетаскивание целых групп, «+» на заголовке — новая вкладка сразу в группе.
- Перетаскивание вкладок и групп мышью, в том числе нескольких сразу.
- Кнопки «Выгрузить» (освободить память) и «Закрыть» вкладки вне групп.
- Иконки сайтов видны даже у ещё не загруженных вкладок — из кэша, без загрузки страниц.
- Цвета подстраиваются под системную тему и тему Firefox.

**Звук и плеер**
- Громкость для каждой вкладки отдельно: клик по динамику — выключить звук, наведение — ползунок, колесо — ±5 %.
- Плеер внизу панели для всех играющих вкладок: обложка, название, пауза, предыдущий/следующий трек, перемотка ±10 с, полоса позиции.
- Работает с сайтами через Media Session API и с обычными `<audio>`/`<video>`.

<p align="center">
  <img src="docs/menu-dark.png?v=5.11.0" width="320" alt="Контекстное меню вкладки: группы, звук, громкость, закрепление, выгрузка из памяти">
  <br><sub>Всё под рукой в контекстном меню: группы, звук, громкость, закрепление, выгрузка из памяти</sub>
</p>

**Автосохранение**
- Открытые окна, вкладки и группы сохраняются в фоне при каждом изменении (не чаще раза в 400 мс и не реже раза в 2 с).
- После краша браузера или отключения питания сессия восстанавливается автоматически при запуске.
- Восстановленные вкладки не загружаются, пока на них не кликнуть, — запуск остаётся быстрым даже с сотнями вкладок.

## Установка

Расширение не подписано в addons.mozilla.org, поэтому ставится в
**Firefox Developer Edition** или **Nightly**:

1. Скачайте `sidebar-tabs.xpi` из [последнего релиза](../../releases/latest) или соберите сами: `./build.sh` → `dist/sidebar-tabs.xpi`.
2. В `about:config` установите `xpinstall.signatures.required` = `false`.
3. `about:addons` → ⚙ → «Установить дополнение из файла…» → выберите `.xpi`.

Для быстрой проверки без установки подойдёт `about:debugging` → «Этот Firefox» → «Загрузить временное дополнение» → `manifest.json`.

## Разработка

Проект на чистом JavaScript без сборщиков и npm-зависимостей.

```
manifest.json        — манифест (Manifest V2)
background.js        — автосохранение и восстановление сессии, кэш иконок, громкость, состояние плеера
content/media.js     — перехват медиа на страницах (Media Session, <audio>/<video>, громкость)
sidebar/             — интерфейс боковой панели (model.js — чистая логика, sidebar.js — DOM)
icons/               — иконка расширения и иконки Lucide
test/                — модульные тесты (node:test) с фейковым browser.* API
e2e/                 — сквозные тесты плеера в настоящем Firefox и съёмка скриншотов
docs/                — скриншоты для README
```

```sh
npm test        # модульные тесты, нужен Node.js 22+
npm run e2e     # сквозные тесты, нужен Firefox Developer Edition (FIREFOX=/путь/к/firefox)
./build.sh      # собрать dist/sidebar-tabs.xpi
npm run screenshots  # переснять docs/*.png (Firefox Developer Edition)
```

## Лицензия

[MIT](LICENSE). Используются [Lucide](https://lucide.dev) (ISC, `icons/lucide/LICENSE`)
и [Motion](https://motion.dev) (MIT, `sidebar/vendor/MOTION-LICENSE.md`).
