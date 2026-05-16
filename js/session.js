/**
 * session.js — Session management, lap detection, sector timing
 *
 * Events fired on window.session (EventTarget):
 *   'packet'       — detail: packet object (every BLE sample)
 *   'lapstart'     — detail: { num }
 *   'lapcomplete'  — detail: lap object
 *   'sector'       — detail: { sectorIndex, time (ms) }
 *   'cleared'      — session was reset
 */

class SessionManager extends EventTarget {
  constructor() {
    super();

    this.packets   = [];        // All raw BLE packets
    this.laps      = [];        // Completed lap objects
    this.bestLapTime = Infinity;
    this.sessionStartTime = null;

    /** @type {{ p1:[lat,lon], p2:[lat,lon] } | null} */
    this.finishLine = null;

    /** @type {Array<{ p1:[lat,lon], p2:[lat,lon] }>} max 2 */
    this.sectorMarkers = [];

    // Current in-progress lap state
    this._lap = this._freshLap(1);
    this._lastGPS = null;

    this.loadConfig();
  }

  /* ── Public: data ingestion ──────────────────────── */

  addPacket(data) {
    const pkt = { ...data, _ts: Date.now() };
    this.packets.push(pkt);

    if (!this.sessionStartTime) this.sessionStartTime = pkt._ts;

    // GPS-based lap / sector detection
    if (Number.isFinite(data.lat) && Number.isFinite(data.lon) &&
        !(data.lat === 0 && data.lon === 0)) {
      const gps = [data.lat, data.lon];
      this._checkCrossings(gps, pkt);
      this._lastGPS = gps;
    }

    // Accumulate into current lap buffer (only after lap has started)
    if (this._lap.startTime !== null) {
      this._lap.points.push(pkt);
    }

    this._fire('packet', pkt);
  }

  /* ── Public: track markers ───────────────────────── */

  setFinishLine(p1, p2) {
    this.finishLine = { p1, p2 };
    this._saveConfig();
  }

  addSectorMarker(p1, p2) {
    if (this.sectorMarkers.length < 2) {
      this.sectorMarkers.push({ p1, p2 });
      this._saveConfig();
      return true;
    }
    return false;
  }

  clearMarkers() {
    this.finishLine    = null;
    this.sectorMarkers = [];
    this._saveConfig();
  }

  /* ── Public: runtime queries ─────────────────────── */

  getCurrentLapTime() {
    if (this._lap.startTime === null) return 0;
    return Date.now() - this._lap.startTime;
  }

  getDeltaToBest() {
    if (this.bestLapTime === Infinity || this._lap.startTime === null) return null;
    return this.getCurrentLapTime() - this.bestLapTime;
  }

  formatTime(ms) {
    if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0) return '--:--.---';
    const m   = Math.floor(ms / 60000);
    const s   = Math.floor((ms % 60000) / 1000);
    const mil = Math.floor(ms % 1000);
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(mil).padStart(3, '0')}`;
  }

  getSessionStats() {
    const raw = JSON.stringify(this.packets);
    return {
      packets:  this.packets.length,
      laps:     this.laps.length,
      bestLap:  this.bestLapTime === Infinity ? null : this.bestLapTime,
      duration: this.sessionStartTime ? Date.now() - this.sessionStartTime : 0,
      size:     raw.length,
    };
  }

  clearSession() {
    this.packets          = [];
    this.laps             = [];
    this.bestLapTime      = Infinity;
    this.sessionStartTime = null;
    this._lap             = this._freshLap(1);
    this._lastGPS         = null;
    this._fire('cleared');
  }

  /* ── Private: lap / sector engine ────────────────── */

  _checkCrossings(gps, pkt) {
    if (!this._lastGPS) return;

    // Finish line
    if (this.finishLine) {
      if (this._crosses(this._lastGPS, gps, this.finishLine.p1, this.finishLine.p2)) {
        this._handleFinishCrossing(pkt);
        return; // After finish crossing don't also fire sector
      }
    }

    // Sector markers (only fires for the next expected sector)
    this.sectorMarkers.forEach((sm, i) => {
      if (i === this._lap.currentSector) {
        if (this._crosses(this._lastGPS, gps, sm.p1, sm.p2)) {
          this._handleSectorCrossing(i, pkt);
        }
      }
    });
  }

  _handleFinishCrossing(pkt) {
    if (this._lap.startTime === null) {
      // First crossing — start the first lap
      this._lap.startTime       = pkt._ts;
      this._lap.sectorStartTime = pkt._ts;
      this._fire('lapstart', { num: this._lap.num });
      return;
    }

    // Complete the current lap
    const lapTime = pkt._ts - this._lap.startTime;
    const isBest  = lapTime < this.bestLapTime;
    if (isBest) this.bestLapTime = lapTime;

    const lap = {
      num:         this._lap.num,
      startTime:   this._lap.startTime,
      endTime:     pkt._ts,
      duration:    lapTime,
      sectorTimes: [...this._lap.sectorTimes],
      isBest,
      ...this._calcLapStats(this._lap.points),
    };

    this.laps.push(lap);
    this._fire('lapcomplete', lap);

    // Start next lap
    const nextNum = this._lap.num + 1;
    this._lap = this._freshLap(nextNum, pkt._ts);
    this._fire('lapstart', { num: nextNum });
  }

  _handleSectorCrossing(sectorIdx, pkt) {
    const sectorTime = pkt._ts - this._lap.sectorStartTime;
    this._lap.sectorTimes.push(sectorTime);
    this._lap.currentSector  = sectorIdx + 1;
    this._lap.sectorStartTime = pkt._ts;
    this._fire('sector', { sectorIndex: sectorIdx, time: sectorTime });
  }

  _calcLapStats(points) {
    if (!points.length) return {};
    const speeds  = points.map(p => p.spd || 0).filter(s => s > 0);
    const latGs   = points.map(p => Math.abs(p.ay || 0));
    const longGs  = points.map(p => p.ax || 0);
    return {
      avgSpeed:   speeds.length ? speeds.reduce((a, b) => a + b, 0) / speeds.length : 0,
      peakLatG:   Math.max(...latGs, 0),
      peakLongG:  Math.max(...longGs, 0),
      peakBrakeG: Math.abs(Math.min(...longGs, 0)),
    };
  }

  /* ── Private: geometry ───────────────────────────── */

  /**
   * Returns true if segment AB crosses segment CD.
   * Uses 2D cross-product orientation test.
   * Works accurately for small geographic distances (track scale).
   */
  _crosses(a, b, c, d) {
    const cross = (o, u, v) =>
      (u[0] - o[0]) * (v[1] - o[1]) - (u[1] - o[1]) * (v[0] - o[0]);
    const d1 = cross(c, d, a);
    const d2 = cross(c, d, b);
    const d3 = cross(a, b, c);
    const d4 = cross(a, b, d);
    return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) &&
           ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
  }

  /* ── Private: helpers ────────────────────────────── */

  _freshLap(num, startTime = null) {
    return {
      num,
      startTime,
      sectorStartTime: startTime,
      points:          [],
      sectorTimes:     [],
      currentSector:   0,
    };
  }

  _fire(type, detail) {
    this.dispatchEvent(
      new CustomEvent(type, detail !== undefined ? { detail } : undefined)
    );
  }

  /* ── Config persistence (localStorage) ──────────── */

  _saveConfig() {
    try {
      localStorage.setItem('kart_track_config', JSON.stringify({
        finishLine:    this.finishLine,
        sectorMarkers: this.sectorMarkers,
      }));
    } catch {}
  }

  loadConfig() {
    try {
      const cfg = JSON.parse(localStorage.getItem('kart_track_config') || 'null');
      if (cfg) {
        this.finishLine    = cfg.finishLine    || null;
        this.sectorMarkers = cfg.sectorMarkers || [];
      }
    } catch {}
  }
}

window.session = new SessionManager();
