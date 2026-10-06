#!/usr/bin/env bash
# Sidebar Tabs: убрать встроенную полосу вкладок Firefox и заголовок
# «Вкладки ✕» над боковой панелью. Лаунчер боковой панели (иконки
# расширений и настройки) остаётся.
#
#   ./install.sh                 установить (спросит профиль, если их несколько)
#   ./install.sh --all           во все найденные профили
#   ./install.sh --profile DIR   в конкретный профиль
#   ./install.sh --uninstall     убрать (можно вместе с --all / --profile)
#
# Что делает с профилем:
#   chrome/userChrome.css — добавляет блок стилей между метками Sidebar Tabs
#                           (остальное содержимое файла не трогает);
#   user.js               — включает загрузку userChrome.css и выключает
#                           нативные вертикальные вкладки (с ними стили не работают).
# Перед первым изменением файла рядом сохраняется копия *.sidebar-tabs.bak.
# Работает в Linux и macOS.
set -euo pipefail

BEGIN_CSS='/* >>> Sidebar Tabs >>> */'
END_CSS='/* <<< Sidebar Tabs <<< */'
BEGIN_JS='// >>> Sidebar Tabs >>>'
END_JS='// <<< Sidebar Tabs <<<'

read -r -d '' CSS <<'CSS_END' || true
/* Скрыть встроенную горизонтальную полосу вкладок — вкладки показывает
   боковая панель Sidebar Tabs. Скрывается именно
   #TabsToolbar-customization-target, а не весь #TabsToolbar: на Linux
   #TabsToolbar одновременно заголовок окна, и вместе с ним пропали бы
   кнопки свернуть/развернуть/закрыть. */
#TabsToolbar-customization-target {
  visibility: collapse !important;
}

#TabsToolbar .titlebar-spacer {
  display: none !important;
}

/* Убрать заголовок «Вкладки ✕» над боковой панелью. Его рисует страница
   панелей расширений, отличить в ней одно расширение от другого нечем,
   поэтому заголовок пропадает у боковых панелей всех расширений;
   у встроенных (закладки, история) он остаётся. */
@-moz-document url("chrome://browser/content/webext-panels.xhtml") {
  sidebar-panel-header {
    display: none !important;
  }
}
CSS_END

read -r -d '' PREFS <<'PREFS_END' || true
user_pref("toolkit.legacyUserProfileCustomizations.stylesheets", true);
user_pref("sidebar.verticalTabs", false);
PREFS_END

die() { printf 'Ошибка: %s\n' "$*" >&2; exit 1; }

mode=install select=ask profile_arg=
while [ $# -gt 0 ]; do
  case "$1" in
    --uninstall) mode=uninstall ;;
    --all) select=all ;;
    --profile) [ $# -ge 2 ] || die "--profile требует путь"; select=one; profile_arg=$2; shift ;;
    -h|--help) sed -n '2,17p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "неизвестный параметр: $1 (см. --help)" ;;
  esac
  shift
done

# Каталоги Firefox, где может лежать profiles.ini (обычная установка, новый
# XDG-путь, Flatpak, Snap, macOS).
firefox_roots() {
  local d
  for d in \
    "$HOME/.mozilla/firefox" \
    "${XDG_CONFIG_HOME:-$HOME/.config}/mozilla/firefox" \
    "$HOME/.var/app/org.mozilla.firefox/.mozilla/firefox" \
    "$HOME/.var/app/org.mozilla.firefox/config/mozilla/firefox" \
    "$HOME/snap/firefox/common/.mozilla/firefox" \
    "$HOME/Library/Application Support/Firefox"; do
    [ -f "$d/profiles.ini" ] && printf '%s\n' "$d"
  done
  return 0
}

# Профили из profiles.ini: «путь<TAB>имя<TAB>1, если профиль по умолчанию».
# По умолчанию — тот, что указан в секции [Install…] (у каждой установленной
# сборки Firefox свой), или старый флаг Default=1.
list_profiles() {
  local root=$1
  awk -v root="$root" '
    function flush() {
      if (sec ~ /^Profile/ && path != "") {
        full = rel ? root "/" path : path
        n++; P[n] = full; N[n] = name; D[n] = def
      }
      sec = ""; path = ""; name = ""; rel = 1; def = 0
    }
    { sub(/\r$/, "") }
    /^\[.*\]$/ { flush(); sec = substr($0, 2, length($0) - 2); next }
    {
      i = index($0, "="); if (!i) next
      k = substr($0, 1, i - 1); v = substr($0, i + 1)
      if (sec ~ /^Profile/) {
        if (k == "Path") path = v
        else if (k == "Name") name = v
        else if (k == "IsRelative") rel = (v == "1")
        else if (k == "Default" && v == "1") def = 1
      } else if (sec ~ /^Install/ && k == "Default") {
        INST[v] = 1; ninst++
      }
    }
    END {
      flush()
      for (j = 1; j <= n; j++) {
        p = P[j]; short = substr(p, length(root) + 2)
        if (ninst) D[j] = (short in INST) || (p in INST)
        printf "%s\t%s\t%d\n", p, N[j], D[j]
      }
    }' "$root/profiles.ini" | while IFS=$'\t' read -r p name def; do
      [ -d "$p" ] && printf '%s\t%s\t%s\n' "$p" "$name" "$def"
    done
  return 0
}

# Удаляет из файла блок между метками (включительно).
strip_block() {
  local file=$1 begin=$2 end=$3
  awk -v b="$begin" -v e="$end" '
    $0 == b { skip = 1; next }
    $0 == e { skip = 0; next }
    !skip' "$file"
}

# Копия исходного файла — только если в нём ещё нет нашего блока, иначе
# повторная установка «сохраняла» бы файл, созданный этим же скриптом.
backup_once() {
  local file=$1 begin=$2
  [ -f "$file" ] && [ ! -e "$file.sidebar-tabs.bak" ] && ! grep -qxF "$begin" "$file" &&
    cp -p "$file" "$file.sidebar-tabs.bak"
  return 0
}

# Записывает блок в файл: старая версия блока заменяется, остальное остаётся.
put_block() {
  local file=$1 begin=$2 end=$3 body=$4 tmp rest
  tmp=$(mktemp "$file.XXXXXX")
  rest=
  if [ -f "$file" ]; then
    backup_once "$file" "$begin"
    rest=$(strip_block "$file" "$begin" "$end")
  fi
  {
    [ -n "$rest" ] && printf '%s\n\n' "$rest"
    printf '%s\n%s\n%s\n' "$begin" "$body" "$end"
  } >"$tmp"
  chmod 644 "$tmp"  # mktemp создаёт файл с правами 600
  mv "$tmp" "$file"
}

# Убирает блок; если в файле больше ничего нет — удаляет файл.
drop_block() {
  local file=$1 begin=$2 end=$3 rest tmp
  [ -f "$file" ] || return 0
  grep -qxF "$begin" "$file" || return 0
  rest=$(strip_block "$file" "$begin" "$end")
  if [ -z "${rest//[[:space:]]/}" ]; then
    rm -f "$file"
  else
    tmp=$(mktemp "$file.XXXXXX")
    printf '%s\n' "$rest" >"$tmp"
    chmod 644 "$tmp"  # mktemp создаёт файл с правами 600
    mv "$tmp" "$file"
  fi
}

apply() {
  local dir=$1
  if [ "$mode" = install ]; then
    mkdir -p "$dir/chrome"
    put_block "$dir/chrome/userChrome.css" "$BEGIN_CSS" "$END_CSS" "$CSS"
    put_block "$dir/user.js" "$BEGIN_JS" "$END_JS" "$PREFS"
    printf '  ✓ %s\n' "$dir"
  else
    drop_block "$dir/chrome/userChrome.css" "$BEGIN_CSS" "$END_CSS"
    drop_block "$dir/user.js" "$BEGIN_JS" "$END_JS"
    rmdir "$dir/chrome" 2>/dev/null || true
    printf '  ✓ убрано: %s\n' "$dir"
  fi
}

# --- выбор профилей ---------------------------------------------------------

targets=()
if [ "$select" = one ]; then
  [ -d "$profile_arg" ] || die "нет такого каталога: $profile_arg"
  targets=("$profile_arg")
else
  paths=() labels=() defaults=()
  while IFS= read -r root; do
    while IFS=$'\t' read -r p name def; do
      paths+=("$p")
      labels+=("$name  ($p)")
      defaults+=("$def")
    done < <(list_profiles "$root")
  done < <(firefox_roots)

  [ ${#paths[@]} -gt 0 ] || die "профили Firefox не найдены. Укажите путь: --profile DIR (about:profiles → «Корневой каталог»)"

  if [ "$select" = all ] || [ ${#paths[@]} -eq 1 ]; then
    targets=("${paths[@]}")
  else
    echo "Найдены профили Firefox:"
    hint=
    for i in "${!paths[@]}"; do
      mark=
      if [ "${defaults[$i]}" = 1 ]; then mark=' [по умолчанию]'; hint="$hint $((i + 1))"; fi
      printf '  %d) %s%s\n' $((i + 1)) "${labels[$i]}" "$mark"
    done
    echo "  a) все"
    [ -n "$hint" ] || hint=' 1'
    answer=
    # stdin может быть занят (curl … | bash) — спрашиваем через терминал.
    if { exec 3<>/dev/tty; } 2>/dev/null; then
      printf 'Номера через пробел, Enter —%s: ' "$hint" >&3
      read -r answer <&3 || answer=
      exec 3<&-
    fi
    [ -n "$answer" ] || answer=$hint
    for n in $answer; do
      case "$n" in
        a|A|all) targets=("${paths[@]}"); break ;;
        *[!0-9]*|'') die "непонятный выбор: $n" ;;
        *) [ "$n" -ge 1 ] && [ "$n" -le ${#paths[@]} ] || die "нет профиля с номером $n"
           targets+=("${paths[$((n - 1))]}") ;;
      esac
    done
  fi
fi

[ "$mode" = install ] && echo "Устанавливаю стили Sidebar Tabs:" || echo "Убираю стили Sidebar Tabs:"
for t in "${targets[@]}"; do apply "$t"; done

if pgrep -x firefox >/dev/null 2>&1 || pgrep -x firefox-bin >/dev/null 2>&1; then
  echo "Firefox запущен — изменения вступят в силу после его перезапуска."
else
  echo "Готово. Запустите Firefox."
fi
if [ "$mode" = uninstall ]; then
  echo "Настройки из user.js остаются в профиле до ручного сброса в about:config"
  echo "(toolkit.legacyUserProfileCustomizations.stylesheets, sidebar.verticalTabs) — они безвредны."
fi
