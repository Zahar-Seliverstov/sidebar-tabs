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

</div>

## Возможности

**Вкладки**
- Вертикальный список вкладок в боковой панели: закреплённые сверху, компактные строки.
- Нативные группы вкладок Firefox — создание, сворачивание, перетаскивание целых групп.
- Перетаскивание вкладок и групп мышью, в том числе нескольких сразу.
- Кнопки «Выгрузить» (освободить память) и «Закрыть» вкладки вне групп.
- Иконки сайтов видны даже у ещё не загруженных вкладок — из кэша, без загрузки страниц.
- Цвета подстраиваются под системную тему и тему Firefox.

**Звук и плеер**
- Громкость для каждой вкладки отдельно: клик по динамику — выключить звук, наведение — ползунок, колесо — ±5 %.
- Плеер внизу панели для всех играющих вкладок: обложка, название, пауза, предыдущий/следующий трек, перемотка ±10 с, полоса позиции.
- Работает с сайтами через Media Session API и с обычными `<audio>`/`<video>`.

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
e2e/                 — сквозные тесты плеера в настоящем Firefox
```

```sh
npm test        # модульные тесты, нужен Node.js 22+
npm run e2e     # сквозные тесты, нужен Firefox Developer Edition (FIREFOX=/путь/к/firefox)
./build.sh      # собрать dist/sidebar-tabs.xpi
```

## Лицензия

[MIT](LICENSE). Используются [Lucide](https://lucide.dev) (ISC, `icons/lucide/LICENSE`)
и [Motion](https://motion.dev) (MIT, `sidebar/vendor/MOTION-LICENSE.md`).
