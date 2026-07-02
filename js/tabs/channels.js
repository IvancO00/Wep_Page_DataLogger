/**
 * channels.js — Time-series charts (Speed, Lateral G, Longitudinal G)
 *
 * Features:
 *  - Three stacked Chart.js line charts with shared time axis
 *  - Configurable rolling time window (5–120 s)
 *  - Channel visibility toggles
 *  - Only redraws when the Channels tab is visible
 */

class ChannelsTab {
  constructor() {
    this._charts = {};
    this._windowSec = 30;
    this._sampleRate = 20;  // ~20 Hz from BLE

    // Rolling buffers
    this._buf = {
      labels:  [],
      speed:   [],
      lateral: [],
      longG:   [],
      vertG:   [],
      yaw:     [],
    };

    this._visible = {
      speed:   true,
      lateral: true,
      longG:   true,
      vertG:   false,
      yaw:     false,
    };

    this._init();
    this._bindControls();
  }

  /* ── Init charts ─────────────────────────────────── */

  _init() {
    const cs = getComputedStyle(document.documentElement);

    const makeChart = (id, label, color, yMin, yMax) => {
      return new Chart(document.getElementById(id), {
        type: 'line',
        data: {
          labels: [],
          datasets: [{
            label,
            data:        [],
            borderColor: color,
            borderWidth: 1.5,
            pointRadius: 0,
            tension:     0.2,
            fill:        false,
          }],
        },
        options: {
          responsive:          true,
          maintainAspectRatio: false,
          animation:           false,
          interaction:         { mode: 'index', intersect: false },
          scales: {
            x: {
              display: false,
            },
            y: {
              min:   yMin,
              max:   yMax,
              grid:  { color: cs.getPropertyValue('--line').trim() || '#e5e0d8' },
              ticks: { color: cs.getPropertyValue('--muted').trim() || '#888', font: { size: 10 } },
            },
          },
          plugins: {
            legend: {
              display: true,
              labels:  { color: cs.getPropertyValue('--muted').trim() || '#888', font: { size: 11 } },
            },
            tooltip: {
              callbacks: {
                title: () => '',
              },
            },
          },
        },
      });
    };

    this._charts.speed   = makeChart('speedChart',    'Speed (km/h)', '#0f6b5a',  0,  160);
    this._charts.lateral = makeChart('lateralGChart', 'Lateral G',    '#cf5c36', -4,    4);
    this._charts.longG   = makeChart('longGChart',    'Long G',       '#5b8cde', -4,    4);
  }

  /* ── Public ──────────────────────────────────────── */

  update(data) {
    const t   = data.ms ?? Date.now();
    const max = this._windowSec * this._sampleRate;

    this._buf.labels .push(t);
    this._buf.speed  .push(data.spd ?? 0);
    this._buf.lateral.push(data.ay  ?? 0);
    this._buf.longG  .push(data.ax  ?? 0);
    this._buf.vertG  .push(data.az  ?? 0);
    this._buf.yaw    .push(data.gz  ?? 0);

    if (this._buf.labels.length > max) {
      for (const k of Object.keys(this._buf)) this._buf[k].shift();
    }

    if (document.getElementById('tab-channels').classList.contains('active')) {
      this._pushToCharts();
    }
  }

  loadPackets(packets) {
    this._buf = {
      labels:  [],
      speed:   [],
      lateral: [],
      longG:   [],
      vertG:   [],
      yaw:     [],
    };

    for (const packet of packets) {
      this.update(packet);
    }

    this._pushToCharts();
  }

  onActivate() {
    this._pushToCharts();
    Object.values(this._charts).forEach(c => c.resize());
  }

  /* ── Private ──────────────────────────────────────── */

  _pushToCharts() {
    const pairs = [
      ['speed',   'speed'],
      ['lateral', 'lateral'],
      ['longG',   'longG'],
    ];

    pairs.forEach(([chartKey, bufKey]) => {
      const chart = this._charts[chartKey];
      if (!chart) return;
      chart.data.labels              = this._buf.labels;
      chart.data.datasets[0].data   = this._buf[bufKey];
      chart.data.datasets[0].hidden = !this._visible[bufKey];
      chart.update('none');
    });
  }

  _bindControls() {
    // Window slider
    document.getElementById('channelWindow').addEventListener('input', e => {
      this._windowSec = parseInt(e.target.value);
      document.getElementById('channelWindowVal').textContent = e.target.value;
    });

    // Channel visibility toggles
    document.querySelectorAll('[data-ch]').forEach(cb => {
      cb.addEventListener('change', () => {
        this._visible[cb.dataset.ch] = cb.checked;
        this._pushToCharts();
      });
    });
  }
}

window.channelsTab = null;
document.addEventListener('DOMContentLoaded', () => {
  window.channelsTab = new ChannelsTab();
});
