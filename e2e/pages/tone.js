"use strict";
// Общие помощники тестовых страниц: тон в WAV (без сети и файлов) и журнал в раннер.
function toneUrl(seconds, freq = 440) {
  const rate = 8000;
  const n = Math.round(rate * seconds);
  const buf = new ArrayBuffer(44 + n);
  const v = new DataView(buf);
  const w = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  w(0, "RIFF");
  v.setUint32(4, 36 + n, true);
  w(8, "WAVEfmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, rate, true);
  v.setUint32(28, rate, true);
  v.setUint16(32, 1, true);
  v.setUint16(34, 8, true);
  w(36, "data");
  v.setUint32(40, n, true);
  for (let i = 0; i < n; i++) v.setUint8(44 + i, 128 + Math.round(60 * Math.sin((2 * Math.PI * freq * i) / rate)));
  return URL.createObjectURL(new Blob([buf], { type: "audio/wav" }));
}
function pageLog(msg) {
  fetch("/page-log?" + encodeURIComponent(location.pathname + location.search + " " + msg)).catch(() => {});
}
