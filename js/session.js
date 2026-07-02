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
    this._latestPacketTs = null;
    this._historicalMode = false;
    this._historicalPackets = null;
    this._loadedSource = null;

    this.loadConfig();
  }

  /* ── Public: data ingestion ──────────────────────── */

  addPacket(data) {
    const packetTs = Number.isFinite(data?._ts) ? data._ts : Date.now();
    const pkt = { ...data, _ts: packetTs };
    this.packets.push(pkt);
    this._latestPacketTs = pkt._ts;

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

    if (this._historicalMode) {
      return Math.max(0, (this._latestPacketTs ?? this._lap.startTime) - this._lap.startTime);
    }

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
    const duration = this.sessionStartTime
      ? (this._historicalMode
          ? Math.max(0, (this._latestPacketTs ?? this.sessionStartTime) - this.sessionStartTime)
          : Date.now() - this.sessionStartTime)
      : 0;

    return {
      packets:  this.packets.length,
      laps:     this.laps.length,
      bestLap:  this.bestLapTime === Infinity ? null : this.bestLapTime,
      duration,
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
    this._latestPacketTs  = null;
    this._historicalMode  = false;
    this._historicalPackets = null;
    this._loadedSource = null;
    this._fire('cleared');
    this._fire('sourcechange', null);
  }

  loadParsedPackets(packets, metadata = {}) {
    if (!Array.isArray(packets) || packets.length === 0) {
      throw new Error('No packets parsed from selected track');
    }

    this.clearSession();
    this._historicalMode = true;
    this._historicalPackets = packets.map(packet => ({ ...packet }));
    this._loadedSource = this._buildLoadedSource(metadata, packets);

    for (const packet of packets) {
      this.addPacket(packet);
    }

    this._syncHistoricalViews();
    this._fire('sourcechange', this.getLoadedSource());

    return {
      sourceName: this._loadedSource?.displayName || metadata.sourceName || 'track.csv',
      packetCount: this.packets.length,
      lapCount: this.laps.length,
    };
  }

  rebuildHistoricalSession() {
    if (!this._historicalMode || !Array.isArray(this._historicalPackets) || this._historicalPackets.length === 0) {
      return false;
    }

    const packets = this._historicalPackets.map(packet => ({ ...packet }));
    const source = this._loadedSource ? { ...this._loadedSource } : null;

    this.clearSession();
    this._historicalMode = true;
    this._historicalPackets = packets.map(packet => ({ ...packet }));
    this._loadedSource = source;

    for (const packet of packets) {
      this.addPacket(packet);
    }

    this._syncHistoricalViews();
    this._fire('sourcechange', this.getLoadedSource());
    return true;
  }

  getLoadedSource() {
    return this._loadedSource ? { ...this._loadedSource } : null;
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

  _syncHistoricalViews() {
    if (window.mapTab?.loadPackets) {
      window.mapTab.loadPackets(this.packets);
    }
    if (window.channelsTab?.loadPackets) {
      window.channelsTab.loadPackets(this.packets);
    }
    if (window.ggplotTab?.loadPackets) {
      window.ggplotTab.loadPackets(this.packets);
    }

    const lastPacket = this.packets[this.packets.length - 1];
    if (lastPacket) {
      window.dashboardTab?.update(lastPacket);
      const speedEl = document.getElementById('headerSpeed');
      if (speedEl) speedEl.textContent = `${Math.round(lastPacket.spd ?? 0)} km/h`;
    }
  }

  _buildLoadedSource(metadata, packets) {
    const files = Array.isArray(metadata.files) ? metadata.files.filter(Boolean) : [];
    const fileNames = files.map(file => file.sourceName || file.name).filter(Boolean);
    const packetSpanMs = packets.length > 1
      ? Math.max(0, (packets[packets.length - 1]._ts ?? 0) - (packets[0]._ts ?? 0))
      : 0;

    return {
      displayName: metadata.sessionPath || metadata.displayPath || metadata.sourceName || fileNames[0] || 'track.csv',
      files: fileNames,
      hasRaw: files.some(file => file.kind === 'raw'),
      hasKf: files.some(file => file.kind === 'kf'),
      selectedFile: metadata.selectedFile || fileNames[0] || 'track.csv',
      packetCount: packets.length,
      durationMs: packetSpanMs,
    };
  }
}

window.session = new SessionManager();

window.Session = {
  loadFromBuffer(buffer, sourceName = 'track.csv') {
    return this.loadFromBuffers([{ buffer, sourceName }], { sourceName });
  },

  loadFromBuffers(fileBuffers, metadata = {}) {
    const parsedFiles = (Array.isArray(fileBuffers) ? fileBuffers : [])
      .filter(file => file?.buffer)
      .map(file => parseTrackFile(new TextDecoder().decode(file.buffer), file.sourceName || file.name || 'track.csv'));

    if (!parsedFiles.length) {
      throw new Error('No track files were provided to the parser');
    }

    const rawFile = parsedFiles.find(file => file.kind === 'raw') || null;
    const kfFile = parsedFiles.find(file => file.kind === 'kf') || null;
    const packets = mergeTrackPackets(rawFile?.packets || null, kfFile?.packets || null);

    return window.session.loadParsedPackets(packets, {
      ...metadata,
      sourceName: rawFile?.sourceName || kfFile?.sourceName || metadata.sourceName || 'track.csv',
      files: parsedFiles,
    });
  }
};

window.session.loadFromBuffer = (...args) => window.Session.loadFromBuffer(...args);
window.session.loadFromBuffers = (...args) => window.Session.loadFromBuffers(...args);

function parseTrackFile(text, sourceName) {
  const lines = String(text).replace(/^\uFEFF/, '').split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) {
    throw new Error(`Selected file ${sourceName} is empty or missing CSV rows`);
  }

  const headers = lines[0].split(',').map(h => h.trim());
  const headerSet = new Set(headers);

  if (headerSet.has('latitude') && headerSet.has('longitude')) {
    return {
      kind: 'raw',
      sourceName,
      packets: parseRawTrackCsv(lines, headers),
    };
  }

  if (headerSet.has('x_m') && headerSet.has('y_m')) {
    return {
      kind: 'kf',
      sourceName,
      packets: parseKalmanTrackCsv(lines, headers),
    };
  }

  throw new Error(`Unsupported track format in ${sourceName}`);
}

function parseRawTrackCsv(lines, headers) {
  return parseCsvDataRows(lines, headers, row => {
    const timestamp = parseTimestampMs(row.timestamp);
    return {
      _ts: timestamp,
      ms: timestamp,
      sampleId: toNumber(row.sample_id),
      lat: toNumber(row.latitude),
      lon: toNumber(row.longitude),
      alt: toNumber(row.altitude_m),
      sats: toNumber(row.satellites),
      fix: normalizeFixValue(toNumber(row.hdop)),
      hdop: toNumber(row.hdop),
      spd: msToKmh(toNumber(row.speed_ms)),
      speed_ms: toNumber(row.speed_ms),
      hdg: toNumber(row.course_deg),
      ax: toNumber(row.ax),
      ay: toNumber(row.ay),
      az: toNumber(row.az),
      gx: toNumber(row.gx),
      gy: toNumber(row.gy),
      gz: toNumber(row.gz),
      t: toNumber(row.temperature_c),
    };
  });
}

function parseKalmanTrackCsv(lines, headers) {
  return parseCsvDataRows(lines, headers, row => {
    const timestamp = parseTimestampMs(row.timestamp);
    return {
      _ts: timestamp,
      ms: timestamp,
      sampleId: toNumber(row.sample_id),
      x: toNumber(row.x_m),
      y: toNumber(row.y_m),
      spd: msToKmh(toNumber(row.speed_ms)),
      speed_ms: toNumber(row.speed_ms),
      hdg: toNumber(row.yaw_deg),
      ax: toNumber(row.ax_corr_ms2),
      ay: toNumber(row.ay_corr_ms2),
    };
  });
}

function parseCsvDataRows(lines, headers, mapRow) {
  const packets = [];

  for (let index = 1; index < lines.length; index++) {
    const line = lines[index].trim();
    if (!line) continue;

    const values = line.split(',');
    if (values.length !== headers.length) continue;

    const row = {};
    headers.forEach((header, headerIndex) => {
      row[header] = (values[headerIndex] ?? '').trim();
    });

    const packet = mapRow(row, index - 1);
    if (!packet || !Number.isFinite(packet._ts)) continue;
    packets.push(packet);
  }

  if (!packets.length) {
    throw new Error('No valid telemetry rows found in selected track');
  }

  return packets;
}

function parseTimestampMs(value) {
  const raw = String(value || '').trim();
  const match = raw.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?$/);
  if (!match) return Number.NaN;

  const [, year, month, day, hour, minute, second, fractional = '0'] = match;
  const millis = Number((fractional + '000').slice(0, 3));

  return Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second),
    millis,
  );
}

function toNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function msToKmh(speedMs) {
  return Number.isFinite(speedMs) ? speedMs * 3.6 : 0;
}

function normalizeFixValue(hdop) {
  if (!Number.isFinite(hdop)) return 0;
  if (hdop <= 1.2) return 3;
  if (hdop <= 2.5) return 2;
  if (hdop <= 5) return 1;
  return 0;
}

function mergeTrackPackets(rawPackets, kfPackets) {
  if (Array.isArray(rawPackets) && rawPackets.length) {
    const mergedPackets = rawPackets.map(packet => ({ ...packet }));

    if (Array.isArray(kfPackets) && kfPackets.length) {
      const kfBySampleId = new Map();
      const kfByTimestamp = new Map();

      for (const packet of kfPackets) {
        if (Number.isFinite(packet.sampleId)) kfBySampleId.set(packet.sampleId, packet);
        if (Number.isFinite(packet._ts)) kfByTimestamp.set(packet._ts, packet);
      }

      for (const packet of mergedPackets) {
        const kfPacket = (Number.isFinite(packet.sampleId) && kfBySampleId.get(packet.sampleId)) || kfByTimestamp.get(packet._ts);
        if (!kfPacket) continue;
        packet.x = kfPacket.x ?? null;
        packet.y = kfPacket.y ?? null;
        packet.hdgKf = kfPacket.hdg ?? null;
        packet.spdKf = kfPacket.spd ?? null;
        packet.axCorr = kfPacket.ax ?? null;
        packet.ayCorr = kfPacket.ay ?? null;
      }
    }

    return mergedPackets;
  }

  if (Array.isArray(kfPackets) && kfPackets.length) {
    return kfPackets.map(packet => ({ ...packet }));
  }

  throw new Error('No valid track packets available to load');
}
