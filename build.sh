#!/usr/bin/env bash
# Собирает расширение в dist/sidebar-tabs.xpi.
set -euo pipefail
cd "$(dirname "$0")"

python3 - <<'PY'
import os, zipfile

SHIP = ["manifest.json", "background.js", "content", "sidebar", "icons"]
out = "dist/sidebar-tabs.xpi"
os.makedirs("dist", exist_ok=True)

files = []
for item in SHIP:
    if os.path.isdir(item):
        for root, _, names in os.walk(item):
            files += [os.path.join(root, n) for n in names]
    else:
        files.append(item)

with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
    for f in sorted(files):
        z.write(f, f)

print(f"Собрано: {os.path.abspath(out)} ({len(files)} файлов)")
PY
