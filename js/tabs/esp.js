/**
 * js/tabs/esp.js — ESP32 Control tab
 *
 * Depends on:
 *   window.ble      (BLEManager, ble.js)
 *   window.Session  (session.js — must expose Session.loadFromBuffer)
 *   showToast()     (app.js)
 *
 * BLE commands sent:
 *   ACQ_START  — begin SD acquisition
 *   ACQ_STOP   — stop and close file
 *   SD_LIST    — request file list (reply arrives as 'cmd' event)
 *   SD_NEWFILE — open a new file mid-session
 *
 * Wi-Fi endpoints expected on ESP32:
 *   GET /status  → { sdMounted, sdFreeMB, firmware, acqRunning, acqFile }
 *   GET /file?name=<name> → raw binary (Content-Length header required)
 */

const EspTab = (() => {

  /* ── state ── */
  let acqRunning   = false;
  let acqStartTime = null;
  let acqInterval  = null;
  let transferring = false;

  /* ── DOM helpers ── */
  const $ = id => document.getElementById(id);

  /* ══════════════════════════════════════════════════════
     Console log
  ══════════════════════════════════════════════════════ */

  function log(msg, type = 'info') {
    const el = $('espConsole');
    if (!el) return;
    const now = new Date();
    const ts  = [now.getHours(), now.getMinutes(), now.getSeconds()]
                  .map(n => String(n).padStart(2, '0')).join(':');
    const line = document.createElement('div');
    line.className = `esp-log esp-log-${type}`;
    line.innerHTML =
      `<span class="esp-log-ts">[${ts}]</span>` +
      `<span>${escHtml(msg)}</span>`;
    el.appendChild(line);
    el.scrollTop = el.scrollHeight;
  }

  function escHtml(s) {
    return String(s)
      .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }

  /* ══════════════════════════════════════════════════════
     Acquisition timer
  ══════════════════════════════════════════════════════ */

  function startTimer() {
    acqStartTime = Date.now();
    acqInterval  = setInterval(() => {
      const secs = Math.floor((Date.now() - acqStartTime) / 1000);
      const mm   = String(Math.floor(secs / 60)).padStart(2, '0');
      const ss   = String(secs % 60).padStart(2, '0');
      if ($('acqDuration')) $('acqDuration').textContent = `${mm}:${ss}`;
    }, 1000);
  }

  function stopTimer() {
    clearInterval(acqInterval);
    acqInterval = null;
  }

  /* ══════════════════════════════════════════════════════
     Acquisition toggle
  ══════════════════════════════════════════════════════ */

  async function toggleAcquisition() {
    const btn = $('acqToggleBtn');
    if (!btn) return;

    if (!window.ble.connected) {
      showToast('Connetti prima il dispositivo BLE');
      return;
    }

    if (!acqRunning) {
      try {
        await window.ble.sendCommand('ACQ_START');
      } catch (e) {
        log('Errore avvio acquisizione: ' + e.message, 'err');
        return;
      }
      acqRunning = true;
      btn.textContent = '⏹ Stop acquisizione';
      btn.classList.remove('btn-connect');
      btn.classList.add('btn-disconnect');
      setAcqBadge(true);
      startTimer();
      log('Acquisizione avviata', 'ok');
    } else {
      try {
        await window.ble.sendCommand('ACQ_STOP');
      } catch (e) {
        log('Errore stop acquisizione: ' + e.message, 'err');
      }
      acqRunning = false;
      btn.textContent = '▶ Avvia acquisizione';
      btn.classList.remove('btn-disconnect');
      btn.classList.add('btn-connect');
      setAcqBadge(false);
      stopTimer();
      if ($('acqFile')) $('acqFile').textContent = '--';
      log('Acquisizione fermata', 'warn');
      // Refresh file list after a short delay (ESP needs to flush)
      setTimeout(refreshFileList, 1200);
    }
  }

  function setAcqBadge(running) {
    const badge = $('acqStatus');
    if (!badge) return;
    badge.textContent = running ? '● REC' : 'IDLE';
    badge.className   = running ? 'fix-badge fix-rtk' : 'fix-badge fix-none';
  }

  /* ══════════════════════════════════════════════════════
     File list (via BLE command + notify reply)
  ══════════════════════════════════════════════════════ */

  async function refreshFileList() {
    if (!window.ble.connected) {
      log('Non connesso — impossibile leggere SD', 'warn');
      return;
    }
    log('Richiesta lista file SD...', 'info');
    try {
      await window.ble.sendCommand('SD_LIST');
      // Reply arrives as 'cmd' event → handled in onBleCmd()
    } catch (e) {
      log('Errore SD_LIST: ' + e.message, 'err');
    }
  }

  function renderFileList(files) {
    const body = $('sdFileBody');
    if (!body) return;
    body.innerHTML = '';

    if (!files || !files.length) {
      body.innerHTML =
        '<tr><td colspan="4" style="text-align:center;color:var(--text-2);padding:16px">Nessun file trovato</td></tr>';
      return;
    }

    files.forEach(f => {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td class="mono">${escHtml(f.name)}</td>
        <td>${formatSize(f.size)}</td>
        <td>${escHtml(f.date || '--')}</td>
        <td>
          <button class="btn btn-sm" data-file="${escHtml(f.name)}">⤓ Carica</button>
        </td>`;
      tr.querySelector('button').addEventListener('click', () => loadFile(f));
      body.appendChild(tr);
    });

    log(`${files.length} file trovati sulla SD`, 'ok');
  }

  function formatSize(bytes) {
    if (!bytes || bytes < 0) return '--';
    if (bytes < 1024)        return bytes + ' B';
    if (bytes < 1048576)     return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / 1048576).toFixed(1) + ' MB';
  }

  /* ══════════════════════════════════════════════════════
     File transfer (Wi-Fi HTTP)
  ══════════════════════════════════════════════════════ */

  async function loadFile(f) {
    if (transferring) {
      showToast('Trasferimento già in corso');
      return;
    }
    if (!window.ble.espIp) {
      const ip = prompt('Inserisci IP Wi-Fi dell\'ESP32 (es. 192.168.4.1):');
      if (!ip) return;
      window.ble.setEspIp(ip);
    }

    transferring = true;
    setTransferUI(true, f.name, 0);
    log(`Download: ${f.name}`, 'info');

    try {
      const buffer = await window.ble.downloadFile(f.name, (rx, tot) => {
        const pct = tot ? Math.round((rx / tot) * 100) : 0;
        setTransferUI(true, f.name, pct);
      });

      setTransferUI(true, f.name, 100);
      log(`File ricevuto: ${f.name} (${formatSize(buffer.byteLength)})`, 'ok');

      // Hand off to Session for parsing and visualization
      if (window.Session?.loadFromBuffer) {
        window.Session.loadFromBuffer(buffer, f.name);
        showToast(`${f.name} caricato — visualizza nelle altre tab`);
      } else {
        showToast(`File ricevuto (${formatSize(buffer.byteLength)})`);
      }
    } catch (e) {
      log('Errore download: ' + e.message, 'err');
      showToast('Errore trasferimento file');
    }

    setTimeout(() => setTransferUI(false), 2000);
    transferring = false;
  }

  function setTransferUI(visible, name, pct) {
    const wrap  = $('fileTransferWrap');
    const bar   = $('transferBar');
    const label = $('transferLabel');
    if (!wrap) return;
    wrap.style.display = visible ? 'block' : 'none';
    if (visible && bar)   bar.style.width     = (pct || 0) + '%';
    if (visible && label) label.textContent   =
      pct >= 100 ? `Caricato: ${name}` : `Download: ${name} — ${pct}%`;
  }

  /* ══════════════════════════════════════════════════════
     ESP status (Wi-Fi /status)
  ══════════════════════════════════════════════════════ */

  async function fetchEspStatus() {
    if (!window.ble.espIp) return;
    try {
      const s = await window.ble.fetchStatus();
      updateStatusUI(s);
    } catch (e) {
      // Wi-Fi status optional — don't spam console
    }
  }

  function updateStatusUI(s) {
    if ($('sdStatus'))   $('sdStatus').textContent   = s.sdMounted ? 'Montata' : 'Assente';
    if ($('sdFree'))     $('sdFree').textContent     = s.sdFreeMB != null ? s.sdFreeMB + ' MB' : '--';
    if ($('espFirmware'))$('espFirmware').textContent = s.firmware  || '--';
    if ($('acqFile'))    $('acqFile').textContent    = s.acqFile   || '--';

    // Sync acquisition state if ESP reports it
    if (typeof s.acqRunning === 'boolean' && s.acqRunning !== acqRunning) {
      acqRunning = s.acqRunning;
      setAcqBadge(acqRunning);
      if (acqRunning && !acqInterval) startTimer();
      if (!acqRunning) stopTimer();
    }
  }

  /* ══════════════════════════════════════════════════════
     IP input field
  ══════════════════════════════════════════════════════ */

  function setupIpField() {
    const input = $('espIpInput');
    const btn   = $('espIpSaveBtn');
    if (!input || !btn) return;

    if (window.ble.espIp) input.value = window.ble.espIp;

    btn.addEventListener('click', () => {
      const ip = input.value.trim();
      if (!ip) return;
      window.ble.setEspIp(ip);
      log(`IP ESP32 salvato: ${ip}`, 'ok');
      showToast('IP salvato');
      fetchEspStatus();
    });
  }

  /* ══════════════════════════════════════════════════════
     BLE event listeners
  ══════════════════════════════════════════════════════ */

  function onBleConnected() {
    const badge = $('espStatus');
    if (badge) { badge.textContent = 'CONNESSO'; badge.className = 'fix-badge fix-3d'; }
    log('ESP32 connesso via BLE', 'ok');
    // Fetch SD status and file list on connect
    setTimeout(fetchEspStatus, 500);
    setTimeout(refreshFileList, 800);
  }

  function onBleDisconnected() {
    const badge = $('espStatus');
    if (badge) { badge.textContent = 'DISCONNESSO'; badge.className = 'fix-badge fix-none'; }
    log('ESP32 disconnesso', 'warn');
    acqRunning = false;
    stopTimer();
    setAcqBadge(false);
  }

  function onBleCmd(detail) {
    // Handles command replies routed from ble.js 'cmd' event
    if (!detail || !detail.cmd) return;

    switch (detail.cmd) {
      case 'SD_LIST':
        renderFileList(detail.files || []);
        break;
      case 'ACQ_STATE':
        // ESP can push state changes proactively
        updateStatusUI(detail);
        break;
      default:
        log(`CMD reply: ${JSON.stringify(detail)}`, 'info');
    }
  }

  /* ══════════════════════════════════════════════════════
     Init
  ══════════════════════════════════════════════════════ */

  function init() {
    // Buttons
    $('acqToggleBtn')  ?.addEventListener('click', toggleAcquisition);
    $('refreshFilesBtn')?.addEventListener('click', refreshFileList);
    $('newFileBtn')    ?.addEventListener('click', async () => {
      if (!window.ble.connected) { showToast('Non connesso'); return; }
      try {
        await window.ble.sendCommand('SD_NEWFILE');
        log('Nuovo file aperto', 'ok');
        setTimeout(refreshFileList, 600);
      } catch (e) { log('Errore: ' + e.message, 'err'); }
    });
    $('fetchStatusBtn')?.addEventListener('click', fetchEspStatus);

    // IP field
    setupIpField();

    // BLE events
    window.ble.addEventListener('connected',    () => onBleConnected());
    window.ble.addEventListener('disconnected', () => onBleDisconnected());
    window.ble.addEventListener('cmd',          e  => onBleCmd(e.detail));

    // Sync stato iniziale se già connesso al momento del caricamento
    if (window.ble.connected) {
        onBleConnected();
    }

    // Periodic Wi-Fi status refresh when tab is visible (every 5 s)
    setInterval(() => {
      if (document.getElementById('tab-esp')?.classList.contains('active')) {
        fetchEspStatus();
      }
    }, 5000);

    log('Tab ESP32 pronta', 'ok');
  }

  return { init };
})();

document.addEventListener('DOMContentLoaded', EspTab.init);