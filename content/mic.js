"use strict";

/*
 * Громкость микрофона вкладки.
 *
 * Что вкладка пишет микрофон, Firefox сообщает сам (tab.sharingState), а вот
 * регулятора ни громкости, ни выключения у WebExtension API нет. Поэтому
 * скрипт встаёт в каждый фрейм на document_start, раньше скриптов сайта, и
 * подменяет в прототипе страницы MediaDevices.getUserMedia (wrappedJSObject +
 * exportFunction, как плеер в media.js): сайт получает не сам микрофон, а
 * его копию после узла усиления Web Audio —
 *
 *   микрофон → MediaStreamSource → Gain → MediaStreamDestination → сайту.
 *
 * Шумо- и эхоподавление браузер делает ещё при захвате, до нас, так что
 * качество не страдает; задержка — один такт Web Audio (миллисекунды).
 * Видео (камера) отдаётся как есть.
 *
 * Копия притворяется микрофоном: label, getSettings, getConstraints,
 * getCapabilities и applyConstraints отвечают за настоящую дорожку, а stop()
 * (своей копии и всех её clone()) освобождает настоящий микрофон, когда
 * остановлена последняя копия, — иначе значок «микрофон включён» висел бы
 * после конца звонка. Если Web Audio не запустился (например, запрещён),
 * сайт получает настоящий поток: громкость тогда не работает, а выключение
 * работает через enabled самой дорожки.
 *
 * Протокол с фоном: "micGet" — при каждом новом захвате узнать настройку
 * вкладки (она могла быть выставлена раньше); "micSet" от фона — новая
 * настройка; отвечает только фрейм, у которого есть живой микрофон.
 *
 * Страницы без микрофона не платят ничего, кроме одной подмены.
 */

(() => {
  if (window.__mtbMic) return;

  // Сколько ждать запуска AudioContext, прежде чем отдать сайту настоящий поток.
  const RESUME_MS = 1000;
  // Плавность смены громкости (постоянная времени, с) — без щелчков.
  const RAMP_S = 0.015;

  const S = (window.__mtbMic = {
    volume: 1,
    muted: false,
    // Живые захваты: { orig, gain|null, outs:Set, ctx|null }.
    groups: new Set(),
  });

  const page = window.wrappedJSObject;

  function level() {
    return S.muted ? 0 : S.volume;
  }

  function apply(g) {
    try {
      if (g.gain) g.gain.gain.setTargetAtTime(level(), g.ctx.currentTime, RAMP_S);
      else g.orig.enabled = !S.muted;
    } catch (e) {}
  }

  function setSettings(st) {
    if (!st || typeof st !== "object") return;
    const v = Number(st.volume);
    S.volume = Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 1;
    S.muted = !!st.muted;
    for (const g of S.groups) apply(g);
  }

  function live() {
    let n = 0;
    for (const g of S.groups) {
      if (g.orig.readyState === "live") n++;
      else if (!g.shared) S.groups.delete(g);
    }
    return n;
  }

  function fetchSettings() {
    browser.runtime.sendMessage({ type: "micGet" }).then(setSettings, () => {});
  }

  // Последняя копия остановлена или микрофон пропал — освобождаем всё.
  function release(g) {
    if (!S.groups.delete(g)) return;
    try {
      g.orig.stop();
    } catch (e) {}
    if (!g.shared) return;
    try {
      g.src.disconnect();
    } catch (e) {}
    if (--g.shared.users === 0) g.ctx.close().catch(() => {});
  }

  function stopOut(g, out) {
    try {
      g.nativeStop.call(out);
    } catch (e) {}
    g.outs.delete(out);
    if (g.outs.size === 0) release(g);
  }

  // Копия-дорожка выглядит для сайта как настоящий микрофон.
  function disguise(g, out) {
    g.outs.add(out);
    const p = out.wrappedJSObject;
    const po = g.orig.wrappedJSObject;
    const def = (name, fn) =>
      Object.defineProperty(p, name, { value: exportFunction(fn, window), configurable: true, writable: true });
    Object.defineProperty(p, "label", {
      get: exportFunction(() => g.orig.label, window),
      configurable: true,
    });
    def("getSettings", () => po.getSettings());
    def("getConstraints", () => po.getConstraints());
    def("getCapabilities", () => po.getCapabilities());
    def("applyConstraints", (c) => po.applyConstraints(c));
    def("stop", () => stopOut(g, out));
    def("clone", () => {
      const copy = g.nativeClone.call(out);
      disguise(g, copy);
      return copy;
    });
  }

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  async function wrap(stream) {
    const audio = stream.getAudioTracks();
    if (audio.length === 0) return stream;

    let ctx = null;
    try {
      ctx = new AudioContext();
      if (ctx.state !== "running") await Promise.race([ctx.resume(), sleep(RESUME_MS)]);
      if (ctx.state !== "running") throw new Error("AudioContext не запустился");
      // Один AudioContext на захват; закрывается с последней дорожкой.
      const shared = { users: 0 };
      const tracks = [];
      for (const orig of stream.getTracks()) {
        if (orig.kind !== "audio") {
          tracks.push(orig);
          continue;
        }
        const src = ctx.createMediaStreamSource(new MediaStream([orig]));
        const gain = ctx.createGain();
        const dest = ctx.createMediaStreamDestination();
        // Микрофон обычно моно — не раздуваем его до стерео.
        const channels = Number(orig.getSettings().channelCount) || src.channelCount || 1;
        dest.channelCount = Math.min(2, Math.max(1, channels));
        gain.gain.value = level();
        src.connect(gain).connect(dest);
        const out = dest.stream.getAudioTracks()[0];
        const g = { orig, gain, ctx, shared, src, outs: new Set(), nativeStop: out.stop, nativeClone: out.clone };
        shared.users++;
        S.groups.add(g);
        disguise(g, out);
        // Микрофон отключили (вынули гарнитуру) — копии тоже заканчиваются.
        orig.addEventListener("ended", () => {
          for (const o of [...g.outs]) {
            stopOut(g, o);
            try {
              o.dispatchEvent(new Event("ended"));
            } catch (e) {}
          }
        });
        tracks.push(out);
      }
      fetchSettings();
      return new MediaStream(tracks);
    } catch (e) {
      if (ctx) ctx.close().catch(() => {});
      // Запасной путь: настоящий поток, выключение через enabled.
      for (const orig of audio) {
        const g = { orig, gain: null, ctx: null, shared: null, outs: new Set() };
        S.groups.add(g);
        apply(g);
      }
      fetchSettings();
      return stream;
    }
  }

  try {
    const xGetUserMedia = MediaDevices.prototype.getUserMedia;
    page.MediaDevices.prototype.getUserMedia = exportFunction(function (constraints) {
      const devices = this;
      return new page.Promise(
        exportFunction((resolve, reject) => {
          xGetUserMedia.call(devices, constraints).then(
            (stream) => wrap(stream).then(resolve, () => resolve(stream)),
            reject
          );
        }, window)
      );
    }, window);
  } catch (e) {
    // Фрейм без MediaDevices (не https и не localhost) — микрофона там нет.
  }

  browser.runtime.onMessage.addListener((msg) => {
    if (!msg || msg.type !== "micSet") return undefined;
    setSettings(msg);
    const n = live();
    return n ? Promise.resolve({ live: n }) : undefined;
  });
})();
