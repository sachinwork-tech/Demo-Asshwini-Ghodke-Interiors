/* ==========================================================================
   AURELIAN STUDIO — script.js
   Interaction engine for styles.css. No dependencies, no HTML changes.

   Why JavaScript is needed (CSS cannot do these):
   - read the cursor position and turn it into spotlight, tilt, magnetic and
     depth values
   - read scroll position per element to run multi-speed parallax with
     inertia (scroll-driven CSS can't lerp or share one cursor state)
   - draw the light trail and particles (canvas)
   - add reveal classes at the right moment and count up the statistics

   Markup it reads (all already in your HTML):
     [data-reveal]     entrance animation, staggered by sibling order
     [data-parallax]   scroll layer speed (images: fraction of travel,
                       other elements: fraction of scroll)
     [data-depth]      cursor depth in px (hero layers)
     [data-tilt]       3D card tilt; value = max degrees (blank = per-type default)
     [data-magnetic]   magnetic pull strength (0.25–0.35 typical)
     [data-spotlight]  cursor spotlight layer
     [data-value]      stat counter target

   Layers it creates itself: .fx-cursor (glow + ring), canvas.fx-trail,
   .fx-spotlight, .fx-glare. All aria-hidden and pointer-events: none.

   Flags it sets on <html>: .js, .fx-parallax, .fx-pointer
   ========================================================================== */
(() => {
  'use strict';

  const root = document.documentElement;
  const mqReduce = window.matchMedia('(prefers-reduced-motion: reduce)');
  const mqFine   = window.matchMedia('(hover: hover) and (pointer: fine)');
  const mqPhone  = window.matchMedia('(max-width: 760px)');
  const mqNarrow = window.matchMedia('(max-width: 960px)');

  const $  = (sel, ctx = document) => ctx.querySelector(sel);
  const $$ = (sel, ctx = document) => Array.from(ctx.querySelectorAll(sel));
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const lerp  = (a, b, t) => a + (b - a) * t;
  const setVar = (el, name, value) => el.style.setProperty(name, value);
  const makeLayer = (tag, cls) => {
    const n = document.createElement(tag);
    n.className = cls;
    n.setAttribute('aria-hidden', 'true');
    return n;
  };

  root.classList.add('js');

  /* ------------------------------------------------------------------------
     1. ENTRANCE REVEALS + STAT COUNTERS
     ------------------------------------------------------------------------ */
  function initReveal(animated) {
    const items = $$('[data-reveal]');
    const seen = new Map();

    items.forEach((el) => {
      const i = seen.get(el.parentElement) || 0;
      seen.set(el.parentElement, i + 1);
      setVar(el, '--rd', (Math.min(i, 6) * 0.09).toFixed(2) + 's');
    });

    if (!animated || !('IntersectionObserver' in window)) {
      items.forEach((el) => el.classList.add('is-in'));
      return;
    }

    const io = new IntersectionObserver((entries) => {
      entries.forEach((e) => {
        // Elements already scrolled past (page reload, anchor jump) show instantly
        if (e.isIntersecting || e.boundingClientRect.top < 0) {
          reveal(e.target);
          io.unobserve(e.target);
        }
      });
    }, { threshold: 0.12, rootMargin: '0px 0px -6% 0px' });

    items.forEach((el) => io.observe(el));
  }

  function reveal(el) {
    el.classList.add('is-in');
    if (el.classList.contains('stat')) {
      const n = $('.stat__number', el);
      if (n) countUp(n);
    }
  }

  function countUp(el) {
    const end = parseFloat(el.dataset.value);
    const m = el.textContent.trim().match(/^(\D*)(\d[\d.,]*)(.*)$/);
    if (!isFinite(end) || !m) return;
    const prefix = m[1];
    const suffix = m[3];
    const start = performance.now();
    const duration = 1600;
    el.textContent = prefix + '0' + suffix;
    const tick = (now) => {
      const p = clamp((now - start) / duration, 0, 1);
      const eased = 1 - Math.pow(1 - p, 4);
      el.textContent = prefix + Math.round(end * eased) + suffix;
      if (p < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  // Reduced motion: show everything immediately and stop here.
  if (mqReduce.matches) {
    initReveal(false);
    return;
  }
  initReveal(true);

  /* ------------------------------------------------------------------------
     2. SHARED STATE + FRAME LOOP
     One requestAnimationFrame loop. It only keeps running while something is
     still moving, then goes idle until the next scroll / pointer event.
     ------------------------------------------------------------------------ */
  const S = {
    scroll: window.scrollY,
    smooth: window.scrollY,   // inertial scroll value used by parallax
    mx: window.innerWidth / 2,
    my: window.innerHeight / 2,
    nx: 0, ny: 0,             // cursor, −1..1
    hx: 0, hy: 0,             // smoothed cursor for hero depth
    stamp: 0,                 // bumps when cached geometry may be stale
    raf: 0,
    parallaxDirty: true,
    pointerReady: false
  };

  const hero = $('.hero');
  const isPointer = () => root.classList.contains('fx-pointer');
  const syncMode = () => root.classList.toggle('fx-pointer', mqFine.matches && !mqPhone.matches);

  root.classList.add('fx-parallax');
  syncMode();

  [mqFine, mqPhone, mqNarrow].forEach((mq) => {
    mq.addEventListener('change', () => {
      syncMode();
      S.stamp++;
      S.parallaxDirty = true;
      kick();
    });
  });

  function kick() {
    if (!S.raf) S.raf = requestAnimationFrame(frame);
  }

  function frame() {
    S.raf = 0;
    let busy = false;

    // Inertial scroll
    const diff = S.scroll - S.smooth;
    if (Math.abs(diff) > 0.05) {
      S.smooth += diff * 0.14;
      busy = true;
    } else {
      S.smooth = S.scroll;
    }
    if (busy || S.parallaxDirty) {
      updateParallax();
      S.parallaxDirty = false;
    }

    if (S.pointerReady && isPointer()) {
      if (stepCursor())  busy = true;
      if (stepDepth())   busy = true;
      if (stepMagnets()) busy = true;
      if (stepSpots())   busy = true;
      if (stepGrids())   busy = true;
      if (stepTilts())   busy = true;
      if (stepTrail())   busy = true;
    }

    if (busy) kick();
  }

  window.addEventListener('scroll', () => {
    S.scroll = window.scrollY;
    S.stamp++;
    kick();
  }, { passive: true });

  window.addEventListener('resize', () => {
    S.stamp++;
    S.parallaxDirty = true;
    if (trail.canvas) resizeTrail();
    kick();
  }, { passive: true });

  window.addEventListener('load', () => {
    S.stamp++;
    S.parallaxDirty = true;
    kick();
  });

  /* ------------------------------------------------------------------------
     3. MULTI-LAYER PARALLAX
     Images inside an overflow-hidden frame get a minimal scale so no edge is
     ever exposed. Hero layers use scroll distance; everything else uses its
     distance from the viewport centre, so layers rest at zero offset when
     centred on screen.
     ------------------------------------------------------------------------ */
  const IMG_GAIN = () => (mqPhone.matches ? 0.2 : 0.4);

  // Extra layers (no HTML change needed): [selector, speed, desktopOnly]
  // negative = faster than the page (foreground), positive = slower (background)
  const EXTRA_LAYERS = [
    ['.project--featured .project__body', -0.05, true],
    ['.projects__grid .project:nth-child(2)', -0.045, true],
    ['.projects__grid .project:nth-child(4)', 0.035, true],
    ['.cta__content', -0.05, false]
  ];

  const targets = [];
  const hostMap = new Map();
  const desktopOnly = new Set();

  function initParallax() {
    EXTRA_LAYERS.forEach(([sel, n, dOnly]) => {
      $$(sel).forEach((el) => {
        if (!el.hasAttribute('data-parallax')) el.setAttribute('data-parallax', String(n));
        if (dOnly) desktopOnly.add(el);
      });
    });

    $$('[data-parallax]').forEach((el) => {
      const n = parseFloat(el.dataset.parallax);
      if (!isFinite(n) || n === 0) return;
      const isImg = el.tagName === 'IMG';
      const host = isImg ? el.parentElement : el;
      const t = {
        el, host, n, isImg,
        inHero: !!el.closest('.hero'),
        bleed: isImg && getComputedStyle(host).overflow !== 'visible',
        desktopOnly: desktopOnly.has(el),
        lastPy: 0,
        vis: false
      };
      targets.push(t);
      hostMap.set(host, t);
    });

    if ('IntersectionObserver' in window) {
      const vio = new IntersectionObserver((entries) => {
        entries.forEach((e) => {
          const t = hostMap.get(e.target);
          if (t) t.vis = e.isIntersecting;
        });
        S.parallaxDirty = true;
        kick();
      }, { rootMargin: '25% 0px 25% 0px' });
      hostMap.forEach((t, host) => vio.observe(host));
    } else {
      targets.forEach((t) => { t.vis = true; });
    }
  }

  function updateParallax() {
    const vh = window.innerHeight;
    const lag = S.scroll - S.smooth;
    const gain = IMG_GAIN();
    const narrow = mqNarrow.matches;

    const live = targets.filter((t) => t.vis);
    const rects = live.map((t) => t.host.getBoundingClientRect()); // read phase

    live.forEach((t, i) => {                                       // write phase
      let py;
      if (t.desktopOnly && narrow) {
        py = 0;
      } else if (t.inHero) {
        py = t.n * (t.isImg ? gain : 1) * S.smooth;
      } else {
        const r = rects[i];
        const centre = r.top + r.height / 2 - (t.isImg ? 0 : t.lastPy) + lag;
        py = -t.n * (t.isImg ? gain : 1) * (centre - vh / 2);
      }

      if (t.bleed) {
        const h = t.host.offsetHeight || 1;
        py = clamp(py, -h * 0.2, h * 0.2);
        setVar(t.el, '--ps', (1 + (2 * Math.abs(py)) / h + 0.004).toFixed(4));
      }

      t.lastPy = py;
      setVar(t.el, '--py', py.toFixed(2) + 'px');
    });

    if (hero) {
      const hh = hero.offsetHeight || vh;
      setVar(hero, '--hp', clamp(S.smooth / hh, 0, 1).toFixed(4));
    }
    const max = root.scrollHeight - vh;
    setVar(root, '--scroll-p', max > 0 ? clamp(S.smooth / max, 0, 1).toFixed(4) : '0');
  }

  /* ------------------------------------------------------------------------
     4. POINTER LAYERS (built on the first real mouse movement, so touch
        devices never get these listeners or elements)
     ------------------------------------------------------------------------ */
  const HOVER_SEL = 'a, button, input, select, textarea, label, summary, [data-magnetic]';

  let cursor, glow, ring;
  const cur = { gx: 0, gy: 0, rx: 0, ry: 0, init: false };

  const trail = { canvas: null, ctx: null, pts: [], parts: [], w: 0, h: 0, dpr: 1, lx: 0, ly: 0, last: 0, dirty: false };
  const PALETTE = ['244,91,11', '168,201,200', '255,255,255'];

  let depthEls = [];
  let magnets = [];
  let spots = [];
  let grids = [];
  let tilts = [];
  const activeTilts = new Set();

  function initPointer() {
    if (S.pointerReady) return;
    S.pointerReady = true;

    // Cursor glow + ring
    cursor = makeLayer('div', 'fx-cursor');
    glow = makeLayer('span', 'fx-cursor__glow');
    ring = makeLayer('span', 'fx-cursor__ring');
    cursor.append(glow, ring);

    // Light trail + particles
    trail.canvas = makeLayer('canvas', 'fx-trail');
    trail.ctx = trail.canvas.getContext('2d');
    resizeTrail();

    document.body.append(trail.canvas, cursor);

    document.addEventListener('pointerover', (e) => {
      if (e.target && e.target.closest) cursor.classList.toggle('is-hover', !!e.target.closest(HOVER_SEL));
    }, { passive: true });
    window.addEventListener('pointerdown', () => cursor.classList.add('is-down'), { passive: true });
    window.addEventListener('pointerup', () => cursor.classList.remove('is-down'), { passive: true });
    root.addEventListener('mouseleave', () => {
      cursor.classList.remove('is-visible');
      S.nx = 0; S.ny = 0;
      kick();
    });
    root.addEventListener('mouseenter', () => cursor.classList.add('is-visible'));

    buildDepth();
    buildSpots();
    buildGrids();
    buildTilts();
    buildMagnets();
  }

  function onPointerMove(e) {
    if (e.pointerType === 'touch' || !isPointer()) return;
    if (!S.pointerReady) initPointer();

    S.mx = e.clientX;
    S.my = e.clientY;
    S.nx = (e.clientX / window.innerWidth - 0.5) * 2;
    S.ny = (e.clientY / window.innerHeight - 0.5) * 2;

    if (!cur.init) {
      cur.gx = cur.rx = e.clientX;
      cur.gy = cur.ry = e.clientY;
      trail.lx = e.clientX;
      trail.ly = e.clientY;
      cur.init = true;
    }
    cursor.classList.add('is-visible');
    trailPush(e.clientX, e.clientY);
    magnetsAim();
    kick();
  }
  window.addEventListener('pointermove', onPointerMove, { passive: true });

  /* ---- 4a. Cursor glow + ring ------------------------------------------- */
  // function stepCursor() {
  //   if (!cur.init) return false;
  //   cur.gx = lerp(cur.gx, S.mx, 0.14);
  //   cur.gy = lerp(cur.gy, S.my, 0.14);
  //   cur.rx = lerp(cur.rx, S.mx, 0.22);
  //   cur.ry = lerp(cur.ry, S.my, 0.22);
  //   glow.style.transform = 'translate3d(' + cur.gx.toFixed(1) + 'px,' + cur.gy.toFixed(1) + 'px,0)';
  //   ring.style.transform = 'translate3d(' + cur.rx.toFixed(1) + 'px,' + cur.ry.toFixed(1) + 'px,0)';
  //   return Math.abs(S.mx - cur.gx) + Math.abs(S.my - cur.gy) > 0.3 ||
  //          Math.abs(S.mx - cur.rx) + Math.abs(S.my - cur.ry) > 0.3;
  // }

  /* ---- 4b. Hero depth (cursor) ------------------------------------------ */
  function buildDepth() {
    depthEls = $$('[data-depth]').map((el) => ({ el, d: parseFloat(el.dataset.depth) || 0 }));
  }

  function stepDepth() {
    if (!hero || S.smooth > hero.offsetHeight * 1.15) return false;
    const px = lerp(S.hx, S.nx, 0.07);
    const py = lerp(S.hy, S.ny, 0.07);
    const moved = Math.abs(px - S.hx) + Math.abs(py - S.hy) > 0.0004;
    S.hx = px;
    S.hy = py;
    if (moved) {
      setVar(hero, '--hx', px.toFixed(4));
      setVar(hero, '--hy', py.toFixed(4));
      depthEls.forEach(({ el, d }) => {
        setVar(el, '--dx', (px * d).toFixed(2) + 'px');
        setVar(el, '--dy', (py * d * 0.7).toFixed(2) + 'px');
      });
    }
    return moved;
  }

  /* ---- 4c. Magnetic elements -------------------------------------------- */
  function buildMagnets() {
    magnets = $$('[data-magnetic]').map((el) => ({
      el,
      k: parseFloat(el.dataset.magnetic) || 0.3,
      x: 0, y: 0, tx: 0, ty: 0,
      cx: 0, cy: 0, w: 0, h: 0, stamp: -1
    }));
  }

  function magnetsAim() {
    const off = mqNarrow.matches;
    magnets.forEach((m) => {
      if (off) { m.tx = 0; m.ty = 0; return; }
      if (m.stamp !== S.stamp) {
        const r = m.el.getBoundingClientRect();
        m.cx = r.left + r.width / 2 - m.x;   // centre without the current pull
        m.cy = r.top + r.height / 2 - m.y;
        m.w = r.width;
        m.h = r.height;
        m.stamp = S.stamp;
      }
      const dx = S.mx - m.cx;
      const dy = S.my - m.cy;
      const pad = 48;
      const inside = Math.abs(dx) < m.w / 2 + pad && Math.abs(dy) < m.h / 2 + pad;
      m.tx = inside ? clamp(dx * m.k, -16, 16) : 0;
      m.ty = inside ? clamp(dy * m.k, -16, 16) : 0;
    });
  }

  function stepMagnets() {
    let busy = false;
    magnets.forEach((m) => {
      const ex = m.tx - m.x;
      const ey = m.ty - m.y;
      if (Math.abs(ex) < 0.05 && Math.abs(ey) < 0.05) {
        if (m.x !== m.tx || m.y !== m.ty) {
          m.x = m.tx; m.y = m.ty;
          setVar(m.el, '--tx', m.x.toFixed(2) + 'px');
          setVar(m.el, '--ty', m.y.toFixed(2) + 'px');
        }
        return;
      }
      m.x += ex * 0.18;
      m.y += ey * 0.18;
      setVar(m.el, '--tx', m.x.toFixed(2) + 'px');
      setVar(m.el, '--ty', m.y.toFixed(2) + 'px');
      busy = true;
    });
    return busy;
  }

  /* ---- 4d. Section spotlights ------------------------------------------- */
  function buildSpots() {
    spots = $$('[data-spotlight]').map((el) => {
      const layer = makeLayer('div', 'fx-spotlight');
      el.insertBefore(layer, el.firstChild);
      const s = { el, layer, x: 0, y: 0, tx: 0, ty: 0, on: false, init: false };
      const aim = (e) => {
        const r = el.getBoundingClientRect();
        s.tx = e.clientX - r.left;
        s.ty = e.clientY - r.top;
        if (!s.init) { s.x = s.tx; s.y = s.ty; s.init = true; }
      };
      el.addEventListener('pointerenter', (e) => {
        if (e.pointerType === 'touch' || !isPointer()) return;
        s.on = true; aim(e); layer.classList.add('is-hot'); kick();
      });
      el.addEventListener('pointermove', (e) => { if (s.on) { aim(e); kick(); } });
      el.addEventListener('pointerleave', () => { s.on = false; layer.classList.remove('is-hot'); });
      return s;
    });
  }

  function stepSpots() {
    let busy = false;
    spots.forEach((s) => {
      if (!s.on) return;
      s.x = lerp(s.x, s.tx, 0.12);
      s.y = lerp(s.y, s.ty, 0.12);
      setVar(s.layer, '--sx', s.x.toFixed(1) + 'px');
      setVar(s.layer, '--sy', s.y.toFixed(1) + 'px');
      if (Math.abs(s.tx - s.x) + Math.abs(s.ty - s.y) > 0.3) busy = true;
    });
    return busy;
  }

  /* ---- 4e. Services grid edge-light ------------------------------------- */
  function buildGrids() {
    grids = $$('.services__grid').map((el) => {
      const g = { el, x: 0, y: 0, tx: 0, ty: 0, l: 0, tl: 0, init: false };
      const aim = (e) => {
        const r = el.getBoundingClientRect();
        g.tx = e.clientX - r.left;
        g.ty = e.clientY - r.top;
        if (!g.init) { g.x = g.tx; g.y = g.ty; g.init = true; }
      };
      el.addEventListener('pointerenter', (e) => {
        if (e.pointerType === 'touch' || !isPointer()) return;
        aim(e); g.tl = 1; kick();
      });
      el.addEventListener('pointermove', (e) => { if (g.tl) { aim(e); kick(); } });
      el.addEventListener('pointerleave', () => { g.tl = 0; kick(); });
      return g;
    });
  }

  function stepGrids() {
    let busy = false;
    grids.forEach((g) => {
      if (!g.tl && g.l < 0.003) {
        if (g.l !== 0) { g.l = 0; setVar(g.el, '--ll', '0'); }
        return;
      }
      g.x = lerp(g.x, g.tx, 0.16);
      g.y = lerp(g.y, g.ty, 0.16);
      g.l = lerp(g.l, g.tl, 0.1);
      setVar(g.el, '--lx', g.x.toFixed(1) + 'px');
      setVar(g.el, '--ly', g.y.toFixed(1) + 'px');
      setVar(g.el, '--ll', g.l.toFixed(3));
      busy = true;
    });
    return busy;
  }

  /* ---- 4f. 3D tilt + glare + layered shadow ----------------------------- */
  // Default max tilt (degrees) per card type when data-tilt has no number
  const TILT_DEFAULT = [
    ['.pillar', 2], ['.service', 3], ['.step', 4], ['.article-card', 4.5],
    ['.project', 5], ['.material', 5], ['.testimonial', 5.5]
  ];
  // Where the specular glare lives: [card selector, glare host selector | null = the card]
  const GLARE_HOST = [
    ['.project', '.project__media'],
    ['.article-card', '.article-card__media'],
    ['.material', null],
    ['.testimonial', null],
    ['.service', null],
    ['.philosophy__figure', null],
    ['.intro__figure', null]
  ];

  function buildTilts() {
    tilts = $$('[data-tilt]').map((el) => {
      let max = parseFloat(el.dataset.tilt);
      if (!isFinite(max)) {
        const d = TILT_DEFAULT.find(([sel]) => el.matches(sel));
        max = d ? d[1] : 6;
      }

      let glare = null;
      const g = GLARE_HOST.find(([sel]) => el.matches(sel));
      if (g) {
        const host = g[1] ? $(g[1], el) : el;
        if (host) {
          glare = makeLayer('span', 'fx-glare');
          host.appendChild(glare);
        }
      }

      const t = {
        el, max, glare, over: false, gx: 50, gy: 50,
        cur: { rx: 0, ry: 0, tz: 0, lit: 0, sx: 0, sy: 0 },
        tar: { rx: 0, ry: 0, tz: 0, lit: 0, sx: 0, sy: 0 }
      };

      el.addEventListener('pointerenter', (e) => {
        if (e.pointerType === 'touch' || !isPointer()) return;
        t.over = true;
        el.classList.add('is-tilting');
        if (glare) glare.classList.add('is-on');
        activeTilts.add(t);
        kick();
      });

      el.addEventListener('pointermove', (e) => {
        if (!t.over) return;
        const r = el.getBoundingClientRect();
        const px = clamp((e.clientX - r.left) / (r.width || 1), 0, 1);
        const py = clamp((e.clientY - r.top) / (r.height || 1), 0, 1);
        // The edge under the cursor presses away from the viewer
        t.tar.ry = (px - 0.5) * 2 * t.max;
        t.tar.rx = -(py - 0.5) * 2 * t.max;
        t.tar.tz = 14;
        t.tar.lit = 1;
        t.tar.sx = -(px - 0.5) * 2;   // shadow falls away from the light
        t.tar.sy = -(py - 0.5) * 2;
        t.gx = px * 100;
        t.gy = py * 100;
        kick();
      });

      el.addEventListener('pointerleave', () => {
        t.over = false;
        t.tar.rx = t.tar.ry = t.tar.tz = t.tar.lit = t.tar.sx = t.tar.sy = 0;
        if (glare) glare.classList.remove('is-on');
        kick();
      });

      return t;
    });
  }

  function stepTilts() {
    let busy = false;
    activeTilts.forEach((t) => {
      const c = t.cur;
      const a = t.tar;
      const k = t.over ? 0.16 : 0.1;
      c.rx  = lerp(c.rx,  a.rx,  k);
      c.ry  = lerp(c.ry,  a.ry,  k);
      c.tz  = lerp(c.tz,  a.tz,  k);
      c.lit = lerp(c.lit, a.lit, k);
      c.sx  = lerp(c.sx,  a.sx,  k);
      c.sy  = lerp(c.sy,  a.sy,  k);

      const settled = !t.over &&
        Math.abs(c.rx) < 0.01 && Math.abs(c.ry) < 0.01 &&
        c.tz < 0.05 && c.lit < 0.005;

      if (settled) {
        t.el.classList.remove('is-tilting');
        ['--rx', '--ry', '--tz', '--lit', '--shx', '--shy'].forEach((p) => t.el.style.removeProperty(p));
        if (t.glare) { t.glare.style.removeProperty('--gx'); t.glare.style.removeProperty('--gy'); }
        activeTilts.delete(t);
        return;
      }

      setVar(t.el, '--rx', c.rx.toFixed(3) + 'deg');
      setVar(t.el, '--ry', c.ry.toFixed(3) + 'deg');
      setVar(t.el, '--tz', c.tz.toFixed(2) + 'px');
      setVar(t.el, '--lit', c.lit.toFixed(3));
      setVar(t.el, '--shx', c.sx.toFixed(3));
      setVar(t.el, '--shy', c.sy.toFixed(3));
      if (t.glare) {
        setVar(t.glare, '--gx', t.gx.toFixed(1) + '%');
        setVar(t.glare, '--gy', t.gy.toFixed(1) + '%');
      }
      busy = true;
    });
    return busy;
  }

  /* ---- 4g. Light trail + particles (canvas) ----------------------------- */
  function resizeTrail() {
    trail.dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    trail.w = window.innerWidth;
    trail.h = window.innerHeight;
    trail.canvas.width = Math.round(trail.w * trail.dpr);
    trail.canvas.height = Math.round(trail.h * trail.dpr);
    trail.ctx.setTransform(trail.dpr, 0, 0, trail.dpr, 0, 0);
  }

  function trailPush(x, y) {
    const now = performance.now();
    trail.pts.push({ x, y, t: now });
    if (trail.pts.length > 36) trail.pts.shift();

    const dx = x - trail.lx;
    const dy = y - trail.ly;
    const dist = Math.hypot(dx, dy);
    if (dist > 10 && trail.parts.length < 80) {
      const count = dist > 40 ? 2 : 1;
      for (let i = 0; i < count; i++) {
        const r = Math.random();
        trail.parts.push({
          x: x + (Math.random() - 0.5) * 6,
          y: y + (Math.random() - 0.5) * 6,
          vx: (Math.random() - 0.5) * 0.5 - dx * 0.01,
          vy: (Math.random() - 0.5) * 0.5 - 0.15 - dy * 0.01,
          r: 0.8 + Math.random() * 1.8,
          t0: now,
          life: 650 + Math.random() * 600,
          c: r < 0.6 ? PALETTE[0] : r < 0.85 ? PALETTE[1] : PALETTE[2]
        });
      }
      trail.lx = x;
      trail.ly = y;
    }
  }

  function stepTrail() {
    const ctx = trail.ctx;
    if (!ctx) return false;
    const now = performance.now();
    const life = 520;
    const dt = Math.min(now - (trail.last || now), 50) / 16.7;
    trail.last = now;

    trail.pts = trail.pts.filter((p) => now - p.t < life);
    trail.parts = trail.parts.filter((p) => now - p.t0 < p.life);

    if (!trail.pts.length && !trail.parts.length) {
      if (trail.dirty) {
        ctx.clearRect(0, 0, trail.w, trail.h);
        trail.dirty = false;
      }
      trail.last = 0;
      return false;
    }

    ctx.clearRect(0, 0, trail.w, trail.h);
    trail.dirty = true;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    for (let i = 1; i < trail.pts.length; i++) {
      const a = trail.pts[i - 1];
      const b = trail.pts[i];
      const age = 1 - (now - b.t) / life;          // 1 = fresh, 0 = gone
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.strokeStyle = 'rgba(244,91,11,' + (0.2 * age * age).toFixed(3) + ')';
      ctx.lineWidth = 2 + 9 * age;
      ctx.stroke();
      ctx.strokeStyle = 'rgba(255,255,255,' + (0.55 * age * age * age).toFixed(3) + ')';
      ctx.lineWidth = 0.8 + 1.4 * age;
      ctx.stroke();
    }

    trail.parts.forEach((p) => {
      const age = (now - p.t0) / p.life;            // 0 = fresh, 1 = gone
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vx *= 0.985;
      p.vy *= 0.985;
      const radius = p.r * (1 - age * 0.6);
      const alpha = (1 - age) * 0.8;
      ctx.fillStyle = 'rgba(' + p.c + ',' + (alpha * 0.14).toFixed(3) + ')';
      ctx.beginPath();
      ctx.arc(p.x, p.y, radius * 3, 0, 6.2832);
      ctx.fill();
      ctx.fillStyle = 'rgba(' + p.c + ',' + alpha.toFixed(3) + ')';
      ctx.beginPath();
      ctx.arc(p.x, p.y, radius, 0, 6.2832);
      ctx.fill();
    });

    return true;
  }

  /* ------------------------------------------------------------------------
     5. START
     ------------------------------------------------------------------------ */
  initParallax();
  S.parallaxDirty = true;
  kick();
})();