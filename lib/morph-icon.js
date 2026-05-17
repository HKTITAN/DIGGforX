// MorphIcon — every icon is exactly three SVG lines on a 14×14 viewbox.
// Lines that an icon doesn't use collapse to an invisible center point so
// the line *count* never changes between states. That's the trick: with a
// fixed three-line skeleton, any icon can tween into any other.
//
// Icons that share a shape but differ only in orientation (arrows, chevrons,
// plus/cross) belong to a `rotationGroup`. Cross-group transitions
// interpolate coordinates; same-group transitions rotate the whole svg.
// Rotating preserves line geometry — coordinate tweens between rotated
// twins would warp through their midpoint.
//
// Technique from https://benji.org/morphing-icons-with-claude

(function () {
  const SIZE = 14;
  const CENTER = SIZE / 2;
  const COLLAPSED = { x1: CENTER, y1: CENTER, x2: CENTER, y2: CENTER };

  // viewbox is 0..14, stroke 1.5, rounded caps. Coords picked so the icons
  // sit visually within a 10px square inset by 2px on each side.
  const DEFS = {
    close: {
      lines: [
        { x1: 3.5, y1: 3.5, x2: 10.5, y2: 10.5 },
        { x1: 10.5, y1: 3.5, x2: 3.5, y2: 10.5 },
        COLLAPSED,
      ],
      group: 'plusCross',
      rotation: 45,
    },
    plus: {
      lines: [
        { x1: 3, y1: CENTER, x2: 11, y2: CENTER },
        { x1: CENTER, y1: 3, x2: CENTER, y2: 11 },
        COLLAPSED,
      ],
      group: 'plusCross',
      rotation: 0,
    },
    // Right-pointing chevron — head only, no shaft.
    chevronRight: {
      lines: [
        { x1: 5, y1: 3, x2: 9, y2: CENTER },
        { x1: 9, y1: CENTER, x2: 5, y2: 11 },
        COLLAPSED,
      ],
      group: 'chevron',
      rotation: 0,
    },
    back: { // chevron-left — same group as chevronRight, rotated 180°.
      lines: [
        { x1: 5, y1: 3, x2: 9, y2: CENTER },
        { x1: 9, y1: CENTER, x2: 5, y2: 11 },
        COLLAPSED,
      ],
      group: 'chevron',
      rotation: 180,
    },
    chevronDown: {
      lines: [
        { x1: 5, y1: 3, x2: 9, y2: CENTER },
        { x1: 9, y1: CENTER, x2: 5, y2: 11 },
        COLLAPSED,
      ],
      group: 'chevron',
      rotation: 90,
    },
    // Right-pointing arrow — shaft + two barbs (uses all three lines).
    arrowRight: {
      lines: [
        { x1: 3, y1: CENTER, x2: 11, y2: CENTER },
        { x1: 8, y1: 4, x2: 11, y2: CENTER },
        { x1: 8, y1: 10, x2: 11, y2: CENTER },
      ],
      group: 'arrow',
      rotation: 0,
    },
    arrowLeft: {
      lines: [
        { x1: 3, y1: CENTER, x2: 11, y2: CENTER },
        { x1: 8, y1: 4, x2: 11, y2: CENTER },
        { x1: 8, y1: 10, x2: 11, y2: CENTER },
      ],
      group: 'arrow',
      rotation: 180,
    },
    // Three horizontal lines (menu / hamburger).
    menu: {
      lines: [
        { x1: 2.5, y1: 4, x2: 11.5, y2: 4 },
        { x1: 2.5, y1: CENTER, x2: 11.5, y2: CENTER },
        { x1: 2.5, y1: 10, x2: 11.5, y2: 10 },
      ],
      group: null,
      rotation: 0,
    },
    // Checkmark — two visible legs, third collapsed.
    check: {
      lines: [
        { x1: 3, y1: 7.5, x2: 6, y2: 10.5 },
        { x1: 6, y1: 10.5, x2: 11.5, y2: 4 },
        COLLAPSED,
      ],
      group: null,
      rotation: 0,
    },
    // Spark — three radial lines meeting at center.
    spark: {
      lines: [
        { x1: CENTER, y1: 2, x2: CENTER, y2: 12 },
        { x1: 2.5, y1: 4.5, x2: 11.5, y2: 9.5 },
        { x1: 2.5, y1: 9.5, x2: 11.5, y2: 4.5 },
      ],
      group: null,
      rotation: 0,
    },
    // Circle approximated as a triangle — three sides.
    triangle: {
      lines: [
        { x1: CENTER, y1: 3, x2: 11, y2: 11 },
        { x1: 11, y1: 11, x2: 3, y2: 11 },
        { x1: 3, y1: 11, x2: CENTER, y2: 3 },
      ],
      group: null,
      rotation: 0,
    },
  };

  function easeOutCubic(t) {
    return 1 - Math.pow(1 - t, 3);
  }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function lerpRotation(a, b, t) {
    // Shortest path around the circle. Without this, e.g. 0°→180° via 270°
    // would loop the long way; we always pick the ≤180° direction.
    let delta = ((b - a + 540) % 360) - 180;
    return a + delta * t;
  }

  class MorphIcon {
    constructor(host, initial = 'close', { size = 20, duration = 260, stroke = 1.5 } = {}) {
      this.host = host;
      this.size = size;
      this.duration = duration;
      this.stroke = stroke;
      this.state = initial;
      this.rotation = (DEFS[initial] || DEFS.close).rotation || 0;
      this.lines = (DEFS[initial] || DEFS.close).lines.map((l) => ({ ...l }));

      this.host.classList.add('morph-icon-host');
      this.host.style.display = 'inline-flex';
      this.host.style.alignItems = 'center';
      this.host.style.justifyContent = 'center';

      this._raf = 0;
      this._mount();
      this._paint();
    }

    _mount() {
      const ns = 'http://www.w3.org/2000/svg';
      const svg = document.createElementNS(ns, 'svg');
      svg.setAttribute('viewBox', `0 0 ${SIZE} ${SIZE}`);
      svg.setAttribute('width', this.size);
      svg.setAttribute('height', this.size);
      svg.setAttribute('aria-hidden', 'true');
      svg.style.overflow = 'visible';
      svg.style.transition = 'transform 260ms cubic-bezier(0.2, 0.8, 0.2, 1)';

      const lineEls = [];
      for (let i = 0; i < 3; i++) {
        const l = document.createElementNS(ns, 'line');
        l.setAttribute('stroke', 'currentColor');
        l.setAttribute('stroke-width', String(this.stroke));
        l.setAttribute('stroke-linecap', 'round');
        l.setAttribute('vector-effect', 'non-scaling-stroke');
        svg.appendChild(l);
        lineEls.push(l);
      }

      this.host.innerHTML = '';
      this.host.appendChild(svg);
      this.svg = svg;
      this.lineEls = lineEls;
    }

    _paint() {
      for (let i = 0; i < 3; i++) {
        const l = this.lines[i];
        const isCollapsed =
          l.x1 === CENTER && l.y1 === CENTER && l.x2 === CENTER && l.y2 === CENTER;
        const el = this.lineEls[i];
        el.setAttribute('x1', String(l.x1));
        el.setAttribute('y1', String(l.y1));
        el.setAttribute('x2', String(l.x2));
        el.setAttribute('y2', String(l.y2));
        el.style.opacity = isCollapsed ? '0' : '1';
      }
      this.svg.style.transform = `rotate(${this.rotation}deg)`;
    }

    morphTo(name) {
      const def = DEFS[name];
      if (!def) return;
      cancelAnimationFrame(this._raf);

      const fromLines = this.lines.map((l) => ({ ...l }));
      const fromRotation = this.rotation;
      const toLines = def.lines;
      const toGroup = def.group;
      const fromGroup = (DEFS[this.state] || {}).group;

      // Same-group → rotation only. Cross-group → coordinate tween.
      // The line coords are identical within a group, so the line lerp is
      // a no-op and the CSS rotation handles all the visible motion.
      const inGroup = toGroup && toGroup === fromGroup;
      const toRotation = inGroup ? def.rotation : def.rotation;

      const t0 = performance.now();
      const tick = (now) => {
        const t = Math.min(1, (now - t0) / this.duration);
        const e = easeOutCubic(t);
        for (let i = 0; i < 3; i++) {
          this.lines[i] = {
            x1: lerp(fromLines[i].x1, toLines[i].x1, e),
            y1: lerp(fromLines[i].y1, toLines[i].y1, e),
            x2: lerp(fromLines[i].x2, toLines[i].x2, e),
            y2: lerp(fromLines[i].y2, toLines[i].y2, e),
          };
        }
        this.rotation = lerpRotation(fromRotation, toRotation, e);
        this._paint();
        if (t < 1) this._raf = requestAnimationFrame(tick);
        else this.state = name;
      };
      this._raf = requestAnimationFrame(tick);
    }
  }

  window.MorphIcon = MorphIcon;
})();
