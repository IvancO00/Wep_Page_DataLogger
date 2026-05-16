/**
 * dashboard.js — Live gauge rendering (rAF loop)
 *
 * Draws:
 *  - Speed arc gauge        (canvas #speedGauge)
 *  - Compass                (canvas #compassCanvas)
 *  - GG-force mini scatter  (canvas #ggMini)
 *  - Lateral / Longitudinal G bars (CSS width via inline style)
 *  - Fix quality badge, numbers
 */

class DashboardTab {
  constructor() {
    this._speedCanvas   = document.getElementById('speedGauge');
    this._compassCanvas = document.getElementById('compassCanvas');
    this._ggMiniCanvas  = document.getElementById('ggMini');

    this._speedCtx   = this._speedCanvas.getContext('2d');
    this._compassCtx = this._compassCanvas.getContext('2d');
    this._ggMiniCtx  = this._ggMiniCanvas.getContext('2d');

    // Size canvases to match their CSS display size
    this._resizeCanvases();
    window.addEventListener('resize', () => this._resizeCanvases());

    this._data = { spd: 0, hdg: 0, ax: 0, ay: 0, az: 1, gz: 0, t: 0, alt: 0, fix: 0 };

    // GG mini trail
    this._ggTrail = [];
    this._ggTrailMax = 120;

    this._rafId = null;
    this._startRaf();
  }

  /* ── Public ──────────────────────────────────────── */

  update(data) {
    Object.assign(this._data, data);

    // Text values
    document.getElementById('speedVal').textContent   = Math.round(data.spd  ?? 0);
    document.getElementById('headingVal').textContent = Math.round(data.hdg  ?? 0);
    document.getElementById('lateralGVal').textContent= (data.ay  ?? 0).toFixed(2);
    document.getElementById('longGVal').textContent   = (data.ax  ?? 0).toFixed(2);
    document.getElementById('altVal').textContent     = (data.alt ?? 0).toFixed(1);
    document.getElementById('tempVal').textContent    = (data.t   ?? 0).toFixed(1);
    document.getElementById('gzVal').textContent      = (data.gz  ?? 0).toFixed(1);
    document.getElementById('azVal').textContent      = (data.az  ?? 0).toFixed(2);

    // Lateral G bar (split left/right from centre)
    const ay   = data.ay ?? 0;
    const latPct = Math.min(Math.abs(ay) / 3, 1) * 50; // 0..50% of half-bar
    const leftEl  = document.getElementById('lateralGBarLeft');
    const rightEl = document.getElementById('lateralGBarRight');
    if (ay < 0) {
      leftEl.style.width  = `${latPct}%`;
      rightEl.style.width = '0%';
    } else {
      rightEl.style.width = `${latPct}%`;
      leftEl.style.width  = '0%';
    }

    // Longitudinal G bar (split accel/brake from centre)
    const ax      = data.ax ?? 0;
    const longPct = Math.min(Math.abs(ax) / 3, 1) * 50;
    const accelEl = document.getElementById('longGBarPos');
    const brakeEl = document.getElementById('longGBarNeg');
    if (ax >= 0) {
      accelEl.style.width = `${longPct}%`;
      brakeEl.style.width = '0%';
    } else {
      brakeEl.style.width = `${longPct}%`;
      accelEl.style.width = '0%';
    }

    // Fix quality
    const FIX_NAMES   = ['No Fix', 'GPS', 'RTK Float', 'RTK Fixed'];
    const FIX_CLASSES = ['fix-none', 'fix-gps', 'fix-rtk-float', 'fix-rtk'];
    const FIX_BADGE   = ['NO FIX',  'GPS',  'RTK~',       'RTK'];
    const fix = Math.min(Math.max(Math.round(data.fix ?? 0), 0), 3);
    const fixEl    = document.getElementById('fixDetail');
    const badgeEl  = document.getElementById('fixBadge');
    fixEl.textContent  = FIX_NAMES[fix];
    fixEl.className    = `fix-detail ${FIX_CLASSES[fix]}`;
    badgeEl.textContent = FIX_BADGE[fix];
    badgeEl.className   = `fix-badge ${FIX_CLASSES[fix]}`;

    // GG trail
    this._ggTrail.push({ ax: data.ax ?? 0, ay: data.ay ?? 0 });
    if (this._ggTrail.length > this._ggTrailMax) this._ggTrail.shift();
  }

  /* ── Private: rAF render loop ────────────────────── */

  _startRaf() {
    const loop = () => {
      this._drawSpeedGauge(this._data.spd ?? 0);
      this._drawCompass(this._data.hdg ?? 0);
      this._drawGGMini();
      this._rafId = requestAnimationFrame(loop);
    };
    this._rafId = requestAnimationFrame(loop);
  }

  _resizeCanvases() {
    const dpr = window.devicePixelRatio || 1;
    for (const [canvas, w, h] of [
      [this._speedCanvas,   220, 150],
      [this._compassCanvas, 170, 170],
      [this._ggMiniCanvas,  180, 180],
    ]) {
      canvas.width  = w * dpr;
      canvas.height = h * dpr;
      canvas.style.width  = `${w}px`;
      canvas.style.height = `${h}px`;
      canvas.getContext('2d').scale(dpr, dpr);
    }
  }

  /* ── Speed arc gauge ─────────────────────────────── */
  _drawSpeedGauge(speed) {
    const ctx = this._speedCtx;
    const W = 220, H = 150;
    ctx.clearRect(0, 0, W, H);

    const cx        = W / 2;
    const cy        = H * 0.80;
    const R         = 90;
    const MAX_SPD   = 160;
    const ARC_START = Math.PI * 0.80;   // starts bottom-left
    const ARC_END   = Math.PI * 2.20;   // ends bottom-right
    const ARC_SPAN  = ARC_END - ARC_START;

    const cs = getComputedStyle(document.documentElement);
    const gaugeBg  = cs.getPropertyValue('--gauge-bg').trim()  || '#e8e3da';
    const mutedCol = cs.getPropertyValue('--muted').trim()     || '#888';

    // Background arc
    ctx.beginPath();
    ctx.arc(cx, cy, R, ARC_START, ARC_END);
    ctx.strokeStyle = gaugeBg;
    ctx.lineWidth   = 16;
    ctx.lineCap     = 'round';
    ctx.stroke();

    // Speed arc — colour shifts green → yellow → red
    const fraction    = Math.min(speed, MAX_SPD) / MAX_SPD;
    const speedAngle  = ARC_START + ARC_SPAN * fraction;
    const hue         = 120 - fraction * 120;
    ctx.beginPath();
    ctx.arc(cx, cy, R, ARC_START, speedAngle);
    ctx.strokeStyle = `hsl(${hue}, 78%, 44%)`;
    ctx.lineWidth   = 16;
    ctx.lineCap     = 'round';
    ctx.stroke();

    // Tick marks + labels every 20 km/h
    for (let s = 0; s <= MAX_SPD; s += 20) {
      const angle = ARC_START + ARC_SPAN * (s / MAX_SPD);
      const isMajor = (s % 40 === 0);
      const inner = R - (isMajor ? 22 : 14);
      const outer = R + 4;
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(angle) * inner, cy + Math.sin(angle) * inner);
      ctx.lineTo(cx + Math.cos(angle) * outer, cy + Math.sin(angle) * outer);
      ctx.strokeStyle = mutedCol;
      ctx.lineWidth   = isMajor ? 2 : 1;
      ctx.stroke();

      if (isMajor) {
        const lr = R - 36;
        ctx.fillStyle    = mutedCol;
        ctx.font         = '9px IBM Plex Mono, monospace';
        ctx.textAlign    = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(s, cx + Math.cos(angle) * lr, cy + Math.sin(angle) * lr);
      }
    }
  }

  /* ── Compass ─────────────────────────────────────── */
  _drawCompass(heading) {
    const ctx = this._compassCtx;
    const W = 170, H = 170;
    ctx.clearRect(0, 0, W, H);

    const cx = W / 2, cy = H / 2;
    const R  = 72;
    const cs = getComputedStyle(document.documentElement);
    const lineCol   = cs.getPropertyValue('--line').trim()   || '#ccc';
    const inkCol    = cs.getPropertyValue('--ink').trim()    || '#111';
    const accentCol = cs.getPropertyValue('--accent').trim() || '#0f6b5a';
    const mutedCol  = cs.getPropertyValue('--muted').trim()  || '#888';

    // Outer ring
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, Math.PI * 2);
    ctx.strokeStyle = lineCol;
    ctx.lineWidth   = 1.5;
    ctx.stroke();

    // 36 tick marks
    for (let i = 0; i < 36; i++) {
      const angle  = (i / 36) * Math.PI * 2 - Math.PI / 2;
      const isMaj  = (i % 9 === 0);
      const inner  = R - (isMaj ? 12 : 6);
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(angle) * inner, cy + Math.sin(angle) * inner);
      ctx.lineTo(cx + Math.cos(angle) * R,     cy + Math.sin(angle) * R);
      ctx.strokeStyle = isMaj ? mutedCol : lineCol;
      ctx.lineWidth   = isMaj ? 1.5 : 0.8;
      ctx.stroke();
    }

    // Cardinal letters — rotated with heading
    const CARDS = ['N', 'E', 'S', 'W'];
    CARDS.forEach((c, i) => {
      const baseAngle = (i / 4) * Math.PI * 2 - Math.PI / 2;
      const angle     = baseAngle - (heading * Math.PI / 180);
      const lr        = R - 20;
      ctx.fillStyle    = c === 'N' ? accentCol : inkCol;
      ctx.font         = `bold ${c === 'N' ? 13 : 11}px IBM Plex Mono, monospace`;
      ctx.textAlign    = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(c, cx + Math.cos(angle) * lr, cy + Math.sin(angle) * lr);
    });

    // Fixed pointer needle (upward)
    ctx.save();
    ctx.translate(cx, cy);

    // North (teal)
    ctx.beginPath();
    ctx.moveTo(0, 4);
    ctx.lineTo(-5, 0);
    ctx.lineTo(0, -(R - 28));
    ctx.lineTo(5, 0);
    ctx.closePath();
    ctx.fillStyle = accentCol;
    ctx.fill();

    // South (gray)
    ctx.beginPath();
    ctx.moveTo(0, -4);
    ctx.lineTo(-4, 0);
    ctx.lineTo(0, R - 28);
    ctx.lineTo(4, 0);
    ctx.closePath();
    ctx.fillStyle = mutedCol;
    ctx.fill();

    // Centre dot
    ctx.beginPath();
    ctx.arc(0, 0, 5, 0, Math.PI * 2);
    ctx.fillStyle = inkCol;
    ctx.fill();

    ctx.restore();
  }

  /* ── GG mini ─────────────────────────────────────── */
  _drawGGMini() {
    const ctx = this._ggMiniCtx;
    const W = 180, H = 180;
    ctx.clearRect(0, 0, W, H);

    const cx    = W / 2, cy = H / 2;
    const SCALE = 28;  // px per g
    const MAX_G = 3;
    const cs = getComputedStyle(document.documentElement);
    const lineCol = cs.getPropertyValue('--line').trim() || '#ddd';

    // Reference circles
    for (let g = 1; g <= MAX_G; g++) {
      ctx.beginPath();
      ctx.arc(cx, cy, g * SCALE, 0, Math.PI * 2);
      ctx.strokeStyle = lineCol;
      ctx.lineWidth   = 1;
      ctx.stroke();
    }
    // Crosshairs
    ctx.beginPath();
    ctx.moveTo(cx - MAX_G * SCALE, cy); ctx.lineTo(cx + MAX_G * SCALE, cy);
    ctx.moveTo(cx, cy - MAX_G * SCALE); ctx.lineTo(cx, cy + MAX_G * SCALE);
    ctx.strokeStyle = lineCol;
    ctx.lineWidth   = 0.8;
    ctx.stroke();

    // Trail
    const n = this._ggTrail.length;
    this._ggTrail.forEach((pt, i) => {
      const px  = cx + pt.ay * SCALE;
      const py  = cy - pt.ax * SCALE;
      const mag = Math.sqrt(pt.ax * pt.ax + pt.ay * pt.ay);
      const hue = Math.max(0, 120 - (mag / 3) * 120);
      const alpha = 0.15 + (i / n) * 0.75;
      const r   = i === n - 1 ? 7 : 3;
      ctx.beginPath();
      ctx.arc(px, py, r, 0, Math.PI * 2);
      ctx.fillStyle = `hsla(${hue}, 78%, 46%, ${alpha})`;
      ctx.fill();
      if (i === n - 1) {
        ctx.strokeStyle = 'white';
        ctx.lineWidth   = 1.5;
        ctx.stroke();
      }
    });
  }
}

window.dashboardTab = null;
document.addEventListener('DOMContentLoaded', () => {
  window.dashboardTab = new DashboardTab();
});
