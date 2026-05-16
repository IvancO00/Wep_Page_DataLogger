/**
 * app.js — Main orchestrator
 * Wires together BLE, Session, Tab modules and handles global UI.
 */

document.addEventListener('DOMContentLoaded', () => {

  /* ── Tab switching ──────────────────────────────── */
  const tabBtns   = document.querySelectorAll('.tab-btn');
  const tabPanels = document.querySelectorAll('.tab-panel');

  tabBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      const tab = btn.dataset.tab;
      tabBtns.forEach(b => b.classList.remove('active'));
      tabPanels.forEach(p => p.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById(`tab-${tab}`).classList.add('active');
      // Notify tabs that need resize / activation
      if (tab === 'map')      window.mapTab?.onActivate();
      if (tab === 'channels') window.channelsTab?.onActivate();
      if (tab === 'ggplot')   window.ggplotTab?.onActivate();
    });
  });

  /* ── BLE events ─────────────────────────────────── */
  ble.addEventListener('connecting', () => {
    setStatus('connecting', 'Connecting…');
    document.getElementById('connectBtn').disabled = true;
  });

  ble.addEventListener('connected', e => {
    setStatus('connected', e.detail.name);
    document.getElementById('connectBtn').disabled    = true;
    document.getElementById('disconnectBtn').disabled = false;
    showToast(`Connected to ${e.detail.name}`);
  });

  ble.addEventListener('disconnected', () => {
    setStatus('disconnected', 'Disconnected');
    document.getElementById('connectBtn').disabled    = false;
    document.getElementById('disconnectBtn').disabled = true;
    showToast('Disconnected');
  });

  ble.addEventListener('error', e => {
    setStatus('disconnected', 'Disconnected');
    document.getElementById('connectBtn').disabled    = false;
    document.getElementById('disconnectBtn').disabled = true;
    showToast(e.detail.message, 'error');
  });

  ble.addEventListener('data', e => {
    const data = e.detail;

    // Feed session engine
    session.addPacket(data);

    // Header quick stats
    document.getElementById('headerSpeed').textContent =
      `${Math.round(data.spd ?? 0)} km/h`;

    // Broadcast to all active tabs
    window.dashboardTab?.update(data);
    window.mapTab?.update(data);
    window.ggplotTab?.update(data);
    window.channelsTab?.update(data);
    window.exportTab?.updateStats();
  });

  /* ── BLE button handlers ─────────────────────────── */
  document.getElementById('connectBtn').addEventListener('click', () => ble.connect());
  document.getElementById('disconnectBtn').addEventListener('click', () => ble.disconnect());

  /* ── Session events ──────────────────────────────── */
  session.addEventListener('lapstart', e => {
    document.getElementById('headerLap').textContent = `${e.detail.num}`;
    window.timingTab?.onLapStart(e.detail);
  });

  session.addEventListener('lapcomplete', e => {
    window.timingTab?.onLapComplete(e.detail);
    window.exportTab?.updateStats();
    showToast(`Lap ${e.detail.num}  —  ${session.formatTime(e.detail.duration)}${e.detail.isBest ? '  ★ BEST' : ''}`);
    // Add lap to GG + Channels selects
    _addLapOption(e.detail.num);
  });

  session.addEventListener('sector', e => {
    window.timingTab?.onSector(e.detail);
  });

  session.addEventListener('cleared', () => {
    document.getElementById('headerLap').textContent      = '--';
    document.getElementById('headerLapTime').textContent  = '--:--.---';
    window.timingTab?.clear();
    window.mapTab?.clearTrack();
    window.ggplotTab?.clearHistory();
    window.exportTab?.updateStats();
    // Reset lap selects
    ['ggLapSelect', 'channelsLapSelect'].forEach(id => {
      const sel = document.getElementById(id);
      sel.innerHTML = '<option value="live">Live / Current</option>';
    });
    showToast('Session cleared');
  });

  /* ── Live lap timer (50 ms tick) ────────────────── */
  setInterval(() => {
    const ms = session.getCurrentLapTime();
    document.getElementById('headerLapTime').textContent = session.formatTime(ms);
    window.timingTab?.updateLiveTimer(ms);
  }, 50);

  /* ── Theme toggle ─────────────────────────────────── */
  document.getElementById('themeBtn').addEventListener('click', () => {
    document.body.classList.toggle('dark');
    localStorage.setItem('kart_theme', document.body.classList.contains('dark') ? 'dark' : 'light');
  });
  if (localStorage.getItem('kart_theme') === 'dark') {
    document.body.classList.add('dark');
  }

  /* ── Helpers ──────────────────────────────────────── */

  function setStatus(state, text) {
    document.getElementById('bleDot').className      = `ble-dot ${state}`;
    document.getElementById('bleStatusText').textContent = text;
  }

  function _addLapOption(lapNum) {
    const opt = document.createElement('option');
    opt.value       = lapNum;
    opt.textContent = `Lap ${lapNum}`;
    document.getElementById('ggLapSelect').appendChild(opt.cloneNode(true));
    document.getElementById('channelsLapSelect').appendChild(opt);
  }

});

/* Exposed globally so tabs can call it */
function showToast(msg, type = 'info') {
  const toast = document.getElementById('toast');
  toast.textContent = msg;
  toast.className   = `toast ${type}`;
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => toast.classList.add('hidden'), 3500);
}
