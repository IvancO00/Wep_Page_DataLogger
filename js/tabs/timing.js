/**
 * timing.js — Live lap timer + sector display + lap history table
 */

class TimingTab {
  constructor() {
    this._tbody = document.getElementById('timingTableBody');
    this._currentSectorIdx = 0;
  }

  /* ── Called every 50 ms from app.js ─────────────── */

  updateLiveTimer(ms) {
    document.getElementById('currentLapTimer').textContent = session.formatTime(ms);

    const delta = session.getDeltaToBest();
    const el    = document.getElementById('deltaBest');
    if (delta === null) {
      el.textContent = '--';
      el.className   = 'delta-time neutral';
    } else {
      const sign = delta >= 0 ? '+' : '';
      el.textContent = `${sign}${(delta / 1000).toFixed(3)}`;
      el.className   = `delta-time ${delta > 0 ? 'positive' : 'negative'}`;
    }
  }

  /* ── Session events ──────────────────────────────── */

  onLapStart(detail) {
    document.getElementById('currentLapNum').textContent = `LAP ${detail.num}`;
    document.getElementById('s1Display').textContent     = '--:--.---';
    document.getElementById('s2Display').textContent     = '--:--.---';
    document.getElementById('s3Display').textContent     = '--:--.---';
    document.getElementById('deltaBest').textContent     = '--';
    document.getElementById('deltaBest').className       = 'delta-time neutral';
    this._currentSectorIdx = 0;
  }

  onSector(detail) {
    const DISPLAYS = ['s1Display', 's2Display', 's3Display'];
    if (detail.sectorIndex < DISPLAYS.length) {
      document.getElementById(DISPLAYS[detail.sectorIndex]).textContent =
        session.formatTime(detail.time);
    }
  }

  onLapComplete(lap) {
    // Update best lap display
    if (lap.isBest) {
      document.getElementById('bestLapDisplay').textContent = session.formatTime(lap.duration);
    }

    // Build table row
    const bestTime = session.bestLapTime;
    const delta    = lap.isBest
      ? '★ BEST'
      : `+${((lap.duration - bestTime) / 1000).toFixed(3)}`;

    const secs = [0, 1, 2].map(i =>
      lap.sectorTimes[i] !== undefined ? session.formatTime(lap.sectorTimes[i]) : '--'
    );

    const tr = document.createElement('tr');
    if (lap.isBest) tr.classList.add('best-lap');

    tr.innerHTML = `
      <td>${lap.num}</td>
      <td class="mono">${session.formatTime(lap.duration)}</td>
      <td class="delta ${lap.isBest ? 'best' : 'positive'}">${delta}</td>
      <td class="mono">${secs[0]}</td>
      <td class="mono">${secs[1]}</td>
      <td class="mono">${secs[2]}</td>
      <td>${lap.avgSpeed != null ? lap.avgSpeed.toFixed(1) + ' km/h' : '--'}</td>
      <td>${lap.peakLatG != null ? lap.peakLatG.toFixed(2) + ' g' : '--'}</td>
    `;

    // Insert newest at top
    this._tbody.insertBefore(tr, this._tbody.firstChild);

    // Refresh all delta cells now that best may have changed
    this._refreshDeltas();
  }

  clear() {
    this._tbody.innerHTML = '';
    document.getElementById('currentLapNum').textContent  = 'LAP 1';
    document.getElementById('currentLapTimer').textContent = '00:00.000';
    document.getElementById('s1Display').textContent       = '--:--.---';
    document.getElementById('s2Display').textContent       = '--:--.---';
    document.getElementById('s3Display').textContent       = '--:--.---';
    document.getElementById('deltaBest').textContent       = '--';
    document.getElementById('deltaBest').className         = 'delta-time neutral';
    document.getElementById('bestLapDisplay').textContent  = '--:--.---';
  }

  /* ── Private ──────────────────────────────────────── */

  _refreshDeltas() {
    const best = session.bestLapTime;
    if (best === Infinity) return;

    Array.from(this._tbody.rows).forEach((row, i) => {
      const lapIdx = session.laps.length - 1 - i;
      if (lapIdx < 0) return;
      const lap      = session.laps[lapIdx];
      const deltaCell = row.cells[2];
      if (lap.isBest) {
        deltaCell.textContent = '★ BEST';
        deltaCell.className   = 'delta best';
        row.classList.add('best-lap');
      } else {
        row.classList.remove('best-lap');
        const d = ((lap.duration - best) / 1000).toFixed(3);
        deltaCell.textContent = `+${d}`;
        deltaCell.className   = 'delta positive';
      }
    });
  }
}

window.timingTab = null;
document.addEventListener('DOMContentLoaded', () => {
  window.timingTab = new TimingTab();
});
