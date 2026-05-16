/**
 * map.js — Leaflet GPS track, finish line & sector marker setup
 *
 * Features:
 *  - Live GPS track polyline colored by speed / lateral G / longitudinal G
 *  - Animated live position marker
 *  - Click-to-set finish line (2 clicks = segment)
 *  - Click-to-set sector markers (up to 2)
 *  - Distance accumulation
 *  - Restore markers from session config on load
 */

class MapTab {
  constructor() {
    this._map         = null;
    this._trackLayer  = null;
    this._markerLayer = null;
    this._posMarker   = null;

    this._trackPoints   = [];   // { lat, lon, spd, ay, ax }
    this._trackSegs     = [];   // { polyline, pt }
    this._totalDistance = 0;    // metres

    this._colorMode = 'speed';

    // Marker-placement state machine
    this._placing     = null;   // 'finish' | 'sector' | null
    this._pendingPt   = null;   // first of the two clicks

    this._init();
  }

  /* ── Init ────────────────────────────────────────── */

  _init() {
    this._map = L.map('mapContainer', {
      center: [45.0, 9.0],
      zoom:   14,
      zoomControl: true,
      preferCanvas: true,
    });

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '© <a href="https://openstreetmap.org">OpenStreetMap</a> contributors',
      maxZoom: 22,
      maxNativeZoom: 19,
    }).addTo(this._map);

    this._trackLayer  = L.layerGroup().addTo(this._map);
    this._markerLayer = L.layerGroup().addTo(this._map);

    this._map.on('click', e => this._onMapClick(e));

    this._bindSidebarControls();
    this._renderMarkers();
    this._updateSidebarCounts();
  }

  /* ── Activation (called on tab switch) ──────────── */

  onActivate() {
    setTimeout(() => this._map.invalidateSize(), 80);
  }

  /* ── Data ingestion ──────────────────────────────── */

  update(data) {
    if (!Number.isFinite(data.lat) || !Number.isFinite(data.lon)) return;
    if (data.lat === 0 && data.lon === 0) return;

    const pt = {
      lat: data.lat, lon: data.lon,
      spd: data.spd ?? 0,
      ay:  data.ay  ?? 0,
      ax:  data.ax  ?? 0,
    };

    if (this._trackPoints.length > 0) {
      const prev = this._trackPoints[this._trackPoints.length - 1];
      const dist = this._haversine(prev.lat, prev.lon, pt.lat, pt.lon);
      if (dist < 0.5) return; // deduplicate identical GPS fixes
      this._totalDistance += dist;

      const color = this._getColor(pt);
      const seg   = L.polyline([[prev.lat, prev.lon], [pt.lat, pt.lon]], {
        color,
        weight:  4,
        opacity: 0.88,
      }).addTo(this._trackLayer);
      this._trackSegs.push({ seg, pt });
    }

    this._trackPoints.push(pt);

    // Live marker
    if (!this._posMarker) {
      const icon = L.divIcon({ className: 'live-marker', html: '<div class="live-dot"></div>', iconSize: [16, 16], iconAnchor: [8, 8] });
      this._posMarker = L.marker([pt.lat, pt.lon], { icon, zIndexOffset: 1000 }).addTo(this._map);
      this._map.setView([pt.lat, pt.lon], 18);
    } else {
      this._posMarker.setLatLng([pt.lat, pt.lon]);
      // Pan only if the marker drifts near edge
      const bounds = this._map.getBounds().pad(-0.15);
      if (!bounds.contains([pt.lat, pt.lon])) {
        this._map.panTo([pt.lat, pt.lon]);
      }
    }

    this._updateSidebarCounts();
  }

  clearTrack() {
    this._trackLayer.clearLayers();
    this._trackPoints   = [];
    this._trackSegs     = [];
    this._totalDistance = 0;
    if (this._posMarker) {
      this._map.removeLayer(this._posMarker);
      this._posMarker = null;
    }
    this._updateSidebarCounts();
  }

  /* ── Sidebar controls ────────────────────────────── */

  _bindSidebarControls() {
    document.getElementById('setFinishBtn').addEventListener('click', () => {
      this._placing   = 'finish';
      this._pendingPt = null;
      document.getElementById('finishLineStatus').textContent = 'Click point 1 on map…';
      this._map.getContainer().style.cursor = 'crosshair';
    });

    document.getElementById('addSectorBtn').addEventListener('click', () => {
      if (session.sectorMarkers.length >= 2) {
        showToast('Maximum 2 sector markers already set', 'error');
        return;
      }
      this._placing   = 'sector';
      this._pendingPt = null;
      document.getElementById('sectorStatus').textContent = 'Click point 1…';
      this._map.getContainer().style.cursor = 'crosshair';
    });

    document.getElementById('clearMarkersBtn').addEventListener('click', () => {
      session.clearMarkers();
      this._markerLayer.clearLayers();
      document.getElementById('finishLineStatus').textContent = 'Not set';
      document.getElementById('sectorStatus').textContent     = '0 / 2 sectors set';
    });

    document.getElementById('clearTrackBtn').addEventListener('click', () => {
      if (confirm('Clear GPS track from map?')) this.clearTrack();
    });

    // Color-mode buttons
    document.querySelectorAll('[data-color]').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('[data-color]').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        this._colorMode = btn.dataset.color;
        this._updateLegend();
        this._recolorTrack();
      });
    });

    this._updateLegend();
  }

  /* ── Map click handler ───────────────────────────── */

  _onMapClick(e) {
    if (!this._placing) return;
    const pt = [e.latlng.lat, e.latlng.lng];

    if (!this._pendingPt) {
      this._pendingPt = pt;
      const label = this._placing === 'finish' ? 'Click point 2…' : 'Click point 2 for sector…';
      document.getElementById(
        this._placing === 'finish' ? 'finishLineStatus' : 'sectorStatus'
      ).textContent = label;

      // Preview dot
      L.circleMarker(pt, { radius: 5, color: '#cf5c36', fillColor: '#cf5c36', fillOpacity: 1 })
        .addTo(this._markerLayer);
      return;
    }

    // Second click — finalise
    const p1 = this._pendingPt;
    const p2 = pt;

    if (this._placing === 'finish') {
      session.setFinishLine(p1, p2);
      document.getElementById('finishLineStatus').textContent = '✓ Set';
      showToast('Finish line set');
    } else {
      session.addSectorMarker(p1, p2);
      const n = session.sectorMarkers.length;
      document.getElementById('sectorStatus').textContent = `${n} / 2 sectors set`;
      showToast(`Sector ${n} set`);
    }

    this._placing   = null;
    this._pendingPt = null;
    this._map.getContainer().style.cursor = '';
    this._renderMarkers();
  }

  /* ── Marker rendering ────────────────────────────── */

  _renderMarkers() {
    this._markerLayer.clearLayers();

    if (session.finishLine) {
      this._drawMarkerLine(session.finishLine.p1, session.finishLine.p2, '#cf5c36', '10 6');
      this._addMarkerLabel(session.finishLine.p1, session.finishLine.p2, 'FINISH', '#cf5c36');
    }

    session.sectorMarkers.forEach((sm, i) => {
      this._drawMarkerLine(sm.p1, sm.p2, '#f5a623', '7 5');
      this._addMarkerLabel(sm.p1, sm.p2, `S${i + 1}`, '#f5a623');
    });
  }

  _drawMarkerLine(p1, p2, color, dash) {
    L.polyline([p1, p2], {
      color, weight: 4, dashArray: dash,
    }).addTo(this._markerLayer);
    L.circleMarker(p1, { radius: 5, color, fillColor: color, fillOpacity: 1, weight: 1 }).addTo(this._markerLayer);
    L.circleMarker(p2, { radius: 5, color, fillColor: color, fillOpacity: 1, weight: 1 }).addTo(this._markerLayer);
  }

  _addMarkerLabel(p1, p2, label, color) {
    const midLat = (p1[0] + p2[0]) / 2;
    const midLon = (p1[1] + p2[1]) / 2;
    L.marker([midLat, midLon], {
      icon: L.divIcon({
        className: '',
        html: `<div style="background:${color};color:white;font:bold 10px monospace;padding:2px 5px;border-radius:4px;white-space:nowrap;">${label}</div>`,
        iconAnchor: [20, 8],
      }),
    }).addTo(this._markerLayer);
  }

  /* ── Track coloring ──────────────────────────────── */

  _getColor(pt) {
    let val, min, max;
    if (this._colorMode === 'speed')   { val = pt.spd;          min = 0;  max = 150; }
    else if (this._colorMode === 'lateral') { val = Math.abs(pt.ay); min = 0;  max = 3;   }
    else                               { val = pt.ax + 3;        min = 0;  max = 6;   } // longG shifted so 0 = -3g

    const t = Math.max(0, Math.min(1, (val - min) / (max - min)));
    // Green → Yellow → Red
    const r = Math.round(t < 0.5 ? t * 2 * 255 : 255);
    const g = Math.round(t < 0.5 ? 200 : (1 - t) * 2 * 200);
    return `rgb(${r},${g},40)`;
  }

  _recolorTrack() {
    this._trackSegs.forEach(({ seg, pt }) => {
      seg.setStyle({ color: this._getColor(pt) });
    });
  }

  _updateLegend() {
    const cfg = {
      speed:   { min: '0', max: '150 km/h' },
      lateral: { min: '0 g', max: '3 g' },
      longG:   { min: '-3 g', max: '+3 g' },
    };
    const c = cfg[this._colorMode];
    document.getElementById('legendMin').textContent = c.min;
    document.getElementById('legendMax').textContent = c.max;
  }

  /* ── Helpers ─────────────────────────────────────── */

  _updateSidebarCounts() {
    document.getElementById('mapGpsCount').textContent = this._trackPoints.length;
    document.getElementById('mapDistance').textContent =
      this._totalDistance >= 1000
        ? `${(this._totalDistance / 1000).toFixed(2)} km`
        : `${Math.round(this._totalDistance)} m`;
  }

  /** Haversine distance in metres */
  _haversine(lat1, lon1, lat2, lon2) {
    const R  = 6371000;
    const φ1 = lat1 * Math.PI / 180;
    const φ2 = lat2 * Math.PI / 180;
    const Δφ = (lat2 - lat1) * Math.PI / 180;
    const Δλ = (lon2 - lon1) * Math.PI / 180;
    const a  = Math.sin(Δφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }
}

window.mapTab = null;
document.addEventListener('DOMContentLoaded', () => {
  window.mapTab = new MapTab();
});
