/**
 * export.js — Session data export (JSON, CSV, Lap CSV) and stats
 */

class ExportTab {
  constructor() {
    document.getElementById('exportJsonBtn').addEventListener('click',   () => this._exportJSON());
    document.getElementById('exportCsvBtn').addEventListener('click',    () => this._exportCSV());
    document.getElementById('exportLapCsvBtn').addEventListener('click', () => this._exportLapCSV());
    document.getElementById('clearSessionBtn').addEventListener('click', () => {
      if (confirm('Clear ALL session data? This cannot be undone.')) {
        session.clearSession();
      }
    });

    this.updateStats();
  }

  /* ── Public ──────────────────────────────────────── */

  updateStats() {
    const s = session.getSessionStats();
    document.getElementById('statPackets').textContent  = s.packets.toLocaleString();
    document.getElementById('statLaps').textContent     = s.laps;
    document.getElementById('statBestLap').textContent  = s.bestLap ? session.formatTime(s.bestLap) : '--';
    document.getElementById('statDuration').textContent = s.duration ? session.formatTime(s.duration) : '--';
    document.getElementById('statSize').textContent     = (s.size / 1024).toFixed(1) + ' KB';
  }

  /* ── Exports ─────────────────────────────────────── */

  _exportJSON() {
    if (session.packets.length === 0) {
      showToast('No data to export', 'error');
      return;
    }

    const payload = {
      meta: {
        app:        'Kart Telemetry',
        version:    '1.0',
        exportedAt: new Date().toISOString(),
        totalPackets: session.packets.length,
        totalLaps:    session.laps.length,
        bestLap:      session.bestLapTime === Infinity ? null : session.bestLapTime,
      },
      laps: session.laps.map(l => ({
        num:         l.num,
        duration:    l.duration,
        durationFmt: session.formatTime(l.duration),
        sectorTimes: l.sectorTimes,
        avgSpeed:    l.avgSpeed,
        peakLatG:    l.peakLatG,
        peakLongG:   l.peakLongG,
        peakBrakeG:  l.peakBrakeG,
        isBest:      l.isBest,
      })),
      packets: session.packets,
    };

    this._download(
      JSON.stringify(payload, null, 2),
      `kart_session_${this._timestamp()}.json`,
      'application/json'
    );
  }

  _exportCSV() {
    if (session.packets.length === 0) {
      showToast('No data to export', 'error');
      return;
    }

    // Collect all unique keys across all packets
    const keys = [...new Set(session.packets.flatMap(p => Object.keys(p)))];
    const header = keys.join(',');
    const rows   = session.packets.map(p =>
      keys.map(k => {
        const v = p[k];
        if (v === undefined || v === null) return '';
        if (typeof v === 'string' && v.includes(',')) return `"${v}"`;
        return v;
      }).join(',')
    );

    this._download(
      [header, ...rows].join('\r\n'),
      `kart_session_${this._timestamp()}.csv`,
      'text/csv;charset=utf-8'
    );
  }

  _exportLapCSV() {
    if (session.laps.length === 0) {
      showToast('No laps to export', 'error');
      return;
    }

    const header = 'lap,duration_ms,duration,s1_ms,s1,s2_ms,s2,s3_ms,s3,avg_speed_kmh,peak_lat_g,peak_long_g,peak_brake_g,is_best';
    const rows   = session.laps.map(l => [
      l.num,
      l.duration,
      session.formatTime(l.duration),
      l.sectorTimes[0] ?? '', l.sectorTimes[0] != null ? session.formatTime(l.sectorTimes[0]) : '',
      l.sectorTimes[1] ?? '', l.sectorTimes[1] != null ? session.formatTime(l.sectorTimes[1]) : '',
      l.sectorTimes[2] ?? '', l.sectorTimes[2] != null ? session.formatTime(l.sectorTimes[2]) : '',
      l.avgSpeed   != null ? l.avgSpeed.toFixed(2)   : '',
      l.peakLatG   != null ? l.peakLatG.toFixed(3)   : '',
      l.peakLongG  != null ? l.peakLongG.toFixed(3)  : '',
      l.peakBrakeG != null ? l.peakBrakeG.toFixed(3) : '',
      l.isBest ? '1' : '0',
    ].join(','));

    this._download(
      [header, ...rows].join('\r\n'),
      `kart_laps_${this._timestamp()}.csv`,
      'text/csv;charset=utf-8'
    );
  }

  /* ── Helper ──────────────────────────────────────── */

  _download(content, filename, mimeType) {
    const blob = new Blob([content], { type: mimeType });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    showToast(`Downloaded ${filename}`);
  }

  _timestamp() {
    return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  }
}

window.exportTab = null;
document.addEventListener('DOMContentLoaded', () => {
  window.exportTab = new ExportTab();
});
