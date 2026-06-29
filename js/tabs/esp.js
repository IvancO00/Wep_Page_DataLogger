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
 *   GET /status  → { sdMounted, sdTotalMB, sdFreeMB, sdUsedMB, firmware, acqRunning, acqFile }
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

  /* ══════════════════════════════════════════════════════
     File manager state and navigation
  ══════════════════════════════════════════════════════ */
  let currentSdPath = '/';
  let cachedFiles = [];
  let sdSearchTerm = '';
  let sdSortKey = 'name';
  let sdSortDir = 'asc';

  $('sdUpDirBtn')?.addEventListener('click', () => {
    // Navigate up one directory: e.g. "/sessions/boot_123" -> "/sessions"
    let parts = currentSdPath.split('/').filter(Boolean);
    if (parts.length > 0) {
      parts.pop();
      currentSdPath = parts.length > 0 ? '/' + parts.join('/') : '/';
      refreshFileList(); // Request list for the new path
    }
  });

  async function refreshFileList() {
    log(`Richiesta lista file SD path: ${currentSdPath}...`, 'info');

    // Prefer Wi-Fi listing: no BLE payload size limits, full directory visibility.
    if (window.ble.espIp) {
      try {
        const reply = await window.ble.fetchFileList(currentSdPath);
        if (reply?.files) {
          renderFileList(reply.files);
          return;
        }
      } catch (e) {
        log('Wi-Fi list fallita, fallback BLE: ' + e.message, 'warn');
      }
    }

    if (!window.ble.connected) {
      log('Non connesso BLE e Wi-Fi list non disponibile', 'warn');
      return;
    }

    try {
      await window.ble.sendCommand(`SD_LIST_DIR:${currentSdPath}`);
      // Reply arrives as 'cmd' event → handled in onBleCmd()
    } catch (e) {
      log('Errore SD_LIST via BLE: ' + e.message, 'err');
    }
  }

  function parseDateValue(dateStr) {
    const t = Date.parse(dateStr || '');
    return Number.isFinite(t) ? t : 0;
  }

  function compareFileEntries(a, b) {
    const aIsDir = !!a.isDir;
    const bIsDir = !!b.isDir;

    // Keep folders on top for easier navigation.
    if (aIsDir !== bIsDir) return aIsDir ? -1 : 1;

    let cmp = 0;
    if (sdSortKey === 'size') {
      const sizeA = Number(a.size) || 0;
      const sizeB = Number(b.size) || 0;
      cmp = sizeA - sizeB;
    } else if (sdSortKey === 'date') {
      cmp = parseDateValue(a.date) - parseDateValue(b.date);
    } else {
      cmp = String(a.name || '').localeCompare(String(b.name || ''), undefined, {
        numeric: true,
        sensitivity: 'base'
      });
    }

    if (cmp === 0) {
      cmp = String(a.name || '').localeCompare(String(b.name || ''), undefined, {
        numeric: true,
        sensitivity: 'base'
      });
    }

    return sdSortDir === 'asc' ? cmp : -cmp;
  }

  function getVisibleFiles() {
    const term = sdSearchTerm.trim().toLowerCase();
    const list = Array.isArray(cachedFiles) ? cachedFiles.slice() : [];

    const filtered = term
      ? list.filter(f => String(f?.name || '').toLowerCase().includes(term))
      : list;

    filtered.sort(compareFileEntries);
    return filtered;
  }

  function updateSortDirectionButton() {
    const btn = $('sdSortDirBtn');
    if (!btn) return;
    const asc = sdSortDir === 'asc';
    btn.textContent = asc ? '↑' : '↓';
    btn.title = asc ? 'Ordinamento crescente' : 'Ordinamento decrescente';
  }

  function renderCachedFileList() {
    renderFileList(cachedFiles, true);
  }

  function renderFileList(files, fromCache = false) {
    const body = $('sdFileBody');
    if (!body) return;
    body.innerHTML = '';

    if (!fromCache) {
      cachedFiles = Array.isArray(files) ? files.slice() : [];
    }

    const visibleFiles = getVisibleFiles();
    
    // Update path UI
    const pathEl = $('sdCurrentPath');
    const upBtn = $('sdUpDirBtn');
    if (pathEl) pathEl.textContent = currentSdPath;
    if (upBtn) upBtn.style.display = currentSdPath === '/' ? 'none' : 'inline-block';

    if (!visibleFiles.length) {
      const msg = cachedFiles.length
        ? 'Nessun risultato con il filtro corrente'
        : 'Nessuna voce trovata in questa cartella';
      body.innerHTML =
        `<tr><td colspan="4" class="sd-empty">${msg}</td></tr>`;
      return;
    }

    visibleFiles.forEach(f => {
      const tr = document.createElement('tr');
      const isDir = f.isDir;
      const icon = isDir ? '📁' : '📄';
      const nameWithIcon = `${icon} ${escHtml(f.name)}`;
      tr.className = isDir ? 'sd-row sd-row-dir' : 'sd-row sd-row-file';

      let actionHtml = '';
      if (isDir) {
          actionHtml = `<button class="btn btn-sm action-open" data-folder="${escHtml(f.name)}">Apri</button>`;
      } else {
          actionHtml = `
            <div class="sd-actions">
              <button class="btn btn-sm action-load" title="Carica nella Dashboard">Carica</button>
              <button class="btn btn-sm action-save" title="Salva in locale">Salva</button>
            </div>
          `;
      }

      tr.innerHTML = `
        <td class="mono sd-name-cell" data-label="Nome">${nameWithIcon}</td>
        <td class="sd-size-cell" data-label="Dimensione">${isDir ? '--' : formatSize(f.size)}</td>
        <td class="sd-date-cell" data-label="Data">${escHtml(f.date || '--')}</td>
        <td class="sd-action-cell" data-label="Azione">${actionHtml}</td>`;
      
      // Events
      if (isDir) {
        tr.querySelector('.action-open')?.addEventListener('click', () => {
           currentSdPath = (currentSdPath === '/' ? '' : currentSdPath) + '/' + f.name;
           refreshFileList();
        });
        tr.querySelector('.sd-name-cell')?.addEventListener('click', () => {
          currentSdPath = (currentSdPath === '/' ? '' : currentSdPath) + '/' + f.name;
          refreshFileList();
        });
      } else {
        tr.querySelector('.action-load').addEventListener('click', () => loadFile(f, false));
        tr.querySelector('.action-save').addEventListener('click', () => saveFileToDisk(f));
      }
      body.appendChild(tr);
    });

    const filteredLabel = sdSearchTerm.trim()
      ? ` (filtro: ${visibleFiles.length}/${cachedFiles.length})`
      : '';
    log(`${visibleFiles.length} voci mostrate sulla SD (${currentSdPath})${filteredLabel}`, 'ok');
  }

  function setupFileListControls() {
    const searchInput = $('sdSearchInput');
    const sortSelect = $('sdSortSelect');
    const sortDirBtn = $('sdSortDirBtn');

    if (searchInput) {
      searchInput.addEventListener('input', () => {
        sdSearchTerm = searchInput.value || '';
        renderCachedFileList();
      });
    }

    if (sortSelect) {
      sortSelect.value = sdSortKey;
      sortSelect.addEventListener('change', () => {
        sdSortKey = sortSelect.value || 'name';
        renderCachedFileList();
      });
    }

    if (sortDirBtn) {
      sortDirBtn.addEventListener('click', () => {
        sdSortDir = sdSortDir === 'asc' ? 'desc' : 'asc';
        updateSortDirectionButton();
        renderCachedFileList();
      });
    }

    updateSortDirectionButton();
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

  async function loadFile(f, isSaveToDisk = false) {
    if (transferring) {
      showToast('Trasferimento già in corso');
      return;
    }
    if (!window.ble.espIp) {
      const ip = prompt('Inserisci IP Wi-Fi dell\'ESP32 (es. 192.168.4.1):');
      if (!ip) return;
      window.ble.setEspIp(ip);
    }

    if (isSaveToDisk) {
      saveFileToDisk(f);
      return;
    }

    transferring = true;
    setTransferUI(true, f.name, 0);
    log(`Download: ${f.name}`, 'info');

    try {
      const fullPath = buildFullPath(f.name);

      const buffer = await window.ble.downloadFile(fullPath, (rx, tot) => {
        const pct = tot ? Math.round((rx / tot) * 100) : 0;
        setTransferUI(true, f.name, pct);
      });

      setTransferUI(true, f.name, 100);
      log(`File ricevuto: ${f.name} (${formatSize(buffer.byteLength)})`, 'ok');

      if (window.Session?.loadFromBuffer) {
        window.Session.loadFromBuffer(buffer, f.name);
        showToast(`${f.name} caricato — visualizza nelle altre tab`);
      } else {
        showToast(`File ricevuto (${formatSize(buffer.byteLength)}) ma parser non trovato`);
      }
    } catch (e) {
      log('Errore download: ' + e.message, 'err');
      showToast('Errore trasferimento file');
    }

    setTimeout(() => setTransferUI(false), 2000);
    transferring = false;
  }

  function buildFullPath(fileName) {
    return (currentSdPath === '/' ? '' : currentSdPath) + '/' + fileName;
  }

  function saveFileToDisk(f) {
    try {
      const fullPath = buildFullPath(f.name);
      triggerBrowserDownload(fullPath, f.name);
      log(`Download browser avviato: ${f.name}`, 'ok');
      showToast(`${f.name} inviato ai download del browser`);
    } catch (e) {
      log('Errore avvio download browser: ' + (e?.message || String(e)), 'err');
      showToast('Impossibile avviare il download');
    }
  }

  // Trigger direct browser download to default Downloads folder.
  function triggerBrowserDownload(fullPath, filename) {
    const url = window.ble.getFileUrl(fullPath);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
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

  async function fetchEspStatus(silent = true) {
    if (!window.ble.espIp) {
      if (!silent) {
        showToast('IP ESP32 non impostato');
        log('Test Wi-Fi fallito: IP ESP32 non impostato', 'warn');
      }
      return false;
    }
    try {
      const s = await window.ble.fetchStatus();
      updateStatusUI(s);
      if (!silent) {
        log('Test Wi-Fi OK: endpoint /status raggiunto', 'ok');
        showToast('Wi-Fi OK: /status raggiungibile');
      }
      return true;
    } catch (e) {
      if (!silent) {
        log('Test Wi-Fi fallito: ' + (e?.message || String(e)), 'err');
        showToast('Wi-Fi non raggiungibile: controlla IP/AP');
      }
      return false;
    }
  }

  function updateStatusUI(s) {
    if ($('sdStatus'))   $('sdStatus').textContent   = s.sdMounted ? 'Montata' : 'Assente';
    if ($('sdTotal'))    $('sdTotal').textContent    = s.sdTotalMB != null ? s.sdTotalMB + ' MB' : '--';
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
      fetchEspStatus(false);
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
    setTimeout(() => fetchEspStatus(true), 500);
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
    setupFileListControls();

    // BLE events
    window.ble.addEventListener('connected',    () => onBleConnected());
    window.ble.addEventListener('disconnected', () => onBleDisconnected());
    window.ble.addEventListener('cmd',          e  => onBleCmd(e.detail));

    // Sync stato iniziale se già connesso al momento del caricamento
    if (window.ble.connected) {
        onBleConnected();
    }

    // Try one immediate Wi-Fi status fetch even without BLE connection.
    fetchEspStatus(true);

    // Periodic Wi-Fi status refresh when tab is visible (every 5 s)
    setInterval(() => {
      if (document.getElementById('tab-esp')?.classList.contains('active')) {
        fetchEspStatus(true);
      }
    }, 5000);

    log('Tab ESP32 pronta', 'ok');
  }

  return { init };
})();

document.addEventListener('DOMContentLoaded', EspTab.init);