/**
 * ggplot.js — GG scatter plot (lateral G vs longitudinal G)
 *
 * Features:
 *  - Chart.js scatter, X = lateral G (ay), Y = longitudinal G (ax)
 *  - Color-coded points: green (low) → red (high G magnitude)
 *  - Fading trail (older points more transparent)
 *  - 1g / 2g / 3g reference circles drawn via custom Chart.js plugin
 *  - Live highlighted last point (larger, white border)
 *  - Peak statistics panel
 *  - Configurable trail length
 */

class GGPlotTab {
  constructor() {
    this._canvas = document.getElementById('ggCanvas');
    this._chart  = null;

    this._trail    = [];    // { x: ay, y: ax }
    this._maxPts   = 500;
    this._fade     = true;

    this._peaks = { lat: 0, longAccel: 0, brake: 0, combined: 0 };

    this._initChart();
    this._bindControls();
  }

  /* ── Public ──────────────────────────────────────── */

  update(data) {
    const ax  = data.ax ?? 0;
    const ay  = data.ay ?? 0;
    const mag = Math.sqrt(ax * ax + ay * ay);

    this._trail.push({ x: ay, y: ax, mag });
    if (this._trail.length > this._maxPts) this._trail.shift();

    // Peaks
    if (Math.abs(ay) > this._peaks.lat)   { this._peaks.lat   = Math.abs(ay); }
    if (ax > this._peaks.longAccel)        { this._peaks.longAccel = ax; }
    if (-ax > this._peaks.brake)           { this._peaks.brake = -ax; }
    if (mag > this._peaks.combined)        { this._peaks.combined  = mag; }

    this._updatePeakDisplay();

    // Only push to chart if tab is active (perf)
    if (document.getElementById('tab-ggplot').classList.contains('active')) {
      this._pushToChart();
    }
  }

  onActivate() {
    this._pushToChart();
    this._chart.resize();
  }

  clearHistory() {
    this._trail = [];
    this._peaks = { lat: 0, longAccel: 0, brake: 0, combined: 0 };
    this._updatePeakDisplay();
    this._pushToChart();
  }

  /* ── Chart init ──────────────────────────────────── */

  _initChart() {
    const circlesPlugin = {
      id: 'ggCircles',
      afterDatasetsDraw: (chart) => {
        if (!document.getElementById('ggCircles')?.checked) return;
        const { ctx, scales: { x, y } } = chart;
        const cx = x.getPixelForValue(0);
        const cy = y.getPixelForValue(0);
        const cs = getComputedStyle(document.documentElement);
        const lineCol = cs.getPropertyValue('--line').trim() || '#ddd';

        [1, 2, 3].forEach(g => {
          const r = x.getPixelForValue(g) - cx;
          ctx.save();
          ctx.beginPath();
          ctx.arc(cx, cy, r, 0, Math.PI * 2);
          ctx.strokeStyle = lineCol;
          ctx.lineWidth   = 1;
          ctx.setLineDash([5, 4]);
          ctx.stroke();
          ctx.setLineDash([]);
          ctx.fillStyle    = cs.getPropertyValue('--muted').trim() || '#888';
          ctx.font         = '10px IBM Plex Mono, monospace';
          ctx.textAlign    = 'left';
          ctx.textBaseline = 'bottom';
          ctx.fillText(`${g}g`, cx + r + 3, cy - 2);
          ctx.restore();
        });
      },
    };

    const cs = getComputedStyle(document.documentElement);

    this._chart = new Chart(this._canvas, {
      type: 'scatter',
      plugins: [circlesPlugin],
      data: {
        datasets: [{
          label: 'G-Forces',
          data:            [],
          pointRadius:     [],
          pointHoverRadius: 5,
          backgroundColor: [],
          borderColor:     [],
          borderWidth:     [],
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: true,
        aspectRatio: 1,
        animation:   false,
        scales: {
          x: {
            title: { display: true, text: 'Lateral G  →', color: cs.getPropertyValue('--muted').trim() },
            min: -4, max: 4,
            grid:  { color: cs.getPropertyValue('--line').trim() || '#e5e0d8' },
            ticks: { color: cs.getPropertyValue('--muted').trim(), stepSize: 1 },
          },
          y: {
            title: { display: true, text: 'Long G  ↑ accel / ↓ brake', color: cs.getPropertyValue('--muted').trim() },
            min: -4, max: 4,
            grid:  { color: cs.getPropertyValue('--line').trim() || '#e5e0d8' },
            ticks: { color: cs.getPropertyValue('--muted').trim(), stepSize: 1 },
          },
        },
        plugins: {
          legend:  { display: false },
          tooltip: { enabled: false },
        },
      },
    });
  }

  /* ── Push trail data to Chart.js ─────────────────── */

  _pushToChart() {
    const ds  = this._chart.data.datasets[0];
    const n   = this._trail.length;
    const fade = this._fade;

    ds.data            = this._trail.map(p => ({ x: p.x, y: p.y }));
    ds.backgroundColor = this._trail.map((p, i) => {
      const hue   = Math.max(0, 120 - (p.mag / 3) * 120);
      const alpha = fade ? 0.15 + (i / n) * 0.80 : 0.75;
      return `hsla(${hue}, 78%, 46%, ${alpha})`;
    });
    ds.borderColor = this._trail.map((_, i) =>
      i === n - 1 ? 'rgba(255,255,255,0.9)' : 'transparent'
    );
    ds.borderWidth  = this._trail.map((_, i) => i === n - 1 ? 1.5 : 0);
    ds.pointRadius  = this._trail.map((_, i) => i === n - 1 ? 7 : 3);

    this._chart.update('none');
  }

  /* ── Peaks display ───────────────────────────────── */

  _updatePeakDisplay() {
    document.getElementById('peakLatG').textContent   = this._peaks.lat.toFixed(2)       + ' g';
    document.getElementById('peakLongG').textContent  = this._peaks.longAccel.toFixed(2)  + ' g';
    document.getElementById('peakBrakeG').textContent = this._peaks.brake.toFixed(2)       + ' g';
    document.getElementById('peakCombG').textContent  = this._peaks.combined.toFixed(2)    + ' g';
  }

  /* ── Controls ────────────────────────────────────── */

  _bindControls() {
    const trailSlider = document.getElementById('ggTrailLength');
    trailSlider.addEventListener('input', () => {
      this._maxPts = parseInt(trailSlider.value);
      document.getElementById('ggTrailVal').textContent = trailSlider.value;
      // Trim existing trail
      if (this._trail.length > this._maxPts) {
        this._trail = this._trail.slice(this._trail.length - this._maxPts);
      }
    });

    document.getElementById('ggCircles').addEventListener('change', () => {
      this._chart.update();
    });

    document.getElementById('ggFade').addEventListener('change', e => {
      this._fade = e.target.checked;
      this._pushToChart();
    });

    document.getElementById('resetPeaksBtn').addEventListener('click', () => {
      this._peaks = { lat: 0, longAccel: 0, brake: 0, combined: 0 };
      this._updatePeakDisplay();
    });
  }
}

window.ggplotTab = null;
document.addEventListener('DOMContentLoaded', () => {
  window.ggplotTab = new GGPlotTab();
});
