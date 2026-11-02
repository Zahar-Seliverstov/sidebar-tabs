"use strict";

/*
 * Пружины для анимаций панели — вместо библиотеки Motion (147 КБ).
 *
 * springEasing(opts) — кривая пружины для Web Animations API: easing
 *   "linear(…)" и длительность. Анимация тогда идёт на потоке композитора,
 *   без JS в каждом кадре (перестановки строк списка).
 * new Spring(value, opts, onChange, onRest) — значение, которое пружиной едет к цели
 *   в requestAnimationFrame. Новая цель посреди движения сохраняет скорость —
 *   прерванный поворот продолжается плавно, без рывка (барабан плеера).
 *
 * opts: { stiffness, damping, mass } — как у Motion.
 */

(() => {
  const STEP = 1 / 240; // шаг интегрирования, с
  const MAX_TIME = 3; // дольше пружина не едет (защита от вечного колебания)

  // Сдвиг пружины на dt: полунеявный Эйлер, устойчив для этих жёсткостей.
  function step(x, v, target, { stiffness, damping, mass }, dt) {
    const a = (-stiffness * (x - target) - damping * v) / mass;
    v += a * dt;
    x += v * dt;
    return [x, v];
  }

  const easingCache = new Map();

  function springEasing(opts) {
    const key = `${opts.stiffness}/${opts.damping}/${opts.mass}`;
    let cached = easingCache.get(key);
    if (cached) return cached;
    // Отклик 0 → 1, точка каждые ~1/60 с, до успокоения.
    const points = [0];
    let x = 0;
    let v = 0;
    let t = 0;
    let sinceSample = 0;
    while (t < MAX_TIME) {
      [x, v] = step(x, v, 1, opts, STEP);
      t += STEP;
      sinceSample += STEP;
      if (sinceSample >= 1 / 60) {
        sinceSample = 0;
        points.push(+x.toFixed(4));
        if (Math.abs(1 - x) < 0.001 && Math.abs(v) < 0.01) break;
      }
    }
    points[points.length - 1] = 1;
    cached = { easing: `linear(${points.join(", ")})`, duration: Math.round(t * 1000) };
    easingCache.set(key, cached);
    return cached;
  }

  class Spring {
    constructor(value, opts, onChange, onRest) {
      this.x = value;
      this.v = 0;
      this.target = value;
      this.opts = opts;
      this.onChange = onChange;
      this.onRest = onRest || null;
      this.raf = 0;
      this.last = 0;
      this.tick = this.tick.bind(this);
    }

    get() {
      return this.x;
    }

    // Сразу в value, без движения.
    jump(value) {
      this.stop();
      this.x = this.target = value;
      this.v = 0;
      this.onChange(value);
      if (this.onRest) this.onRest();
    }

    // Ехать к target с текущей скоростью.
    to(target) {
      this.target = target;
      if (!this.raf) {
        this.last = performance.now();
        this.raf = requestAnimationFrame(this.tick);
      }
    }

    stop() {
      if (this.raf) cancelAnimationFrame(this.raf);
      this.raf = 0;
    }

    tick(now) {
      // Вкладка в фоне — rAF стоит; после паузы не догоняем рывком.
      let left = Math.min((now - this.last) / 1000, 0.064);
      this.last = now;
      while (left > 0) {
        const dt = Math.min(STEP, left);
        [this.x, this.v] = step(this.x, this.v, this.target, this.opts, dt);
        left -= dt;
      }
      const done = Math.abs(this.x - this.target) < 0.0005 && Math.abs(this.v) < 0.005;
      if (done) {
        this.x = this.target;
        this.v = 0;
        this.raf = 0;
      } else {
        this.raf = requestAnimationFrame(this.tick);
      }
      this.onChange(this.x);
      if (done && this.onRest) this.onRest();
    }
  }

  const api = { springEasing, Spring };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else globalThis.SidebarSpring = api;
})();
