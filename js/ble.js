/**
 * ble.js — Web Bluetooth connection manager
 *
 * BLE JSON packet format (from ESP32, notify characteristic):
 * {
 *   "ms":  12345,      // ESP32 millis timestamp
 *   "lat": 45.123456,  // GPS latitude  (RTK if available)
 *   "lon": 9.123456,   // GPS longitude
 *   "alt": 15.2,       // GPS altitude (m)
 *   "spd": 80.5,       // Speed km/h (Kalman-fused)
 *   "hdg": 127.3,      // Heading degrees (0=North)
 *   "fix": 2,          // GPS fix: 0=none 1=GPS 2=RTK-float 3=RTK-fixed
 *   "ax":  0.02,       // Longitudinal G (vehicle frame, gravity removed)
 *   "ay":  0.85,       // Lateral G (vehicle frame)
 *   "az":  1.01,       // Vertical G
 *   "gz":  15.3,       // Yaw rate (deg/s)
 *   "t":   45.2        // MCU temperature (°C)
 * }
 *
 * BLE Command characteristic (write, no response):
 *   Commands are plain UTF-8 strings written to CHAR_CMD_UUID.
 *   "ACQ_START"        — start SD acquisition, ESP creates new file
 *   "ACQ_STOP"         — stop SD acquisition, flush and close file
 *   "SD_LIST"          — ESP replies via notify with one JSON packet:
 *                        { "cmd":"SD_LIST", "files":[{name,size,date},...] }
 *   "SD_NEWFILE"       — force close current file, open a new one
 *
 * Wi-Fi file transfer (ESP32 runs a minimal HTTP server):
 *   GET http://<espIp>/file?name=<filename>   → raw binary (application/octet-stream)
 *   GET http://<espIp>/status                 → { sdMounted, sdFreeMB, firmware, acqRunning, acqFile }
 *
 * Events fired on window.ble (EventTarget):
 *   'connecting'   — scan started
 *   'connected'    — detail: { name }
 *   'disconnected' — no detail
 *   'data'         — detail: parsed telemetry JSON object
 *   'cmd'          — detail: parsed command-reply JSON object  (e.g. SD_LIST response)
 *   'error'        — detail: { message }
 */

class BLEManager extends EventTarget {
  constructor() {
    super();

    // ── Telemetry notify characteristic (existing)
    this.SERVICE_UUID  = '91bad492-b950-4226-aa2b-4ede9fa42f59';
    this.CHAR_UUID     = 'ca73b3ba-39f6-4ab3-91ae-186dc9577d99';

    // ── Command write characteristic (new — add this on the ESP side)
    // Generate your own UUID or use this placeholder:
    this.CHAR_CMD_UUID = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';

    this.device         = null;
    this.charData       = null;   // notify  (telemetry)
    this.charCmd        = null;   // write   (commands)
    this.connected      = false;
    this._reconnecting  = false;

    // Wi-Fi base URL — set via setEspIp() or from localStorage
    this.espIp = localStorage.getItem('kart_esp_ip') || null;

    const cfg = this._loadUUIDs();
    if (cfg) {
      this.SERVICE_UUID  = cfg.service || this.SERVICE_UUID;
      this.CHAR_UUID     = cfg.char    || this.CHAR_UUID;
      this.CHAR_CMD_UUID = cfg.cmd     || this.CHAR_CMD_UUID;
    }

    this._boundOnData         = this._onData.bind(this);
    this._boundOnDisconnected = this._onDisconnected.bind(this);
  }

  /* ══════════════════════════════════════════════════════
     Public API — connection
  ══════════════════════════════════════════════════════ */

  async connect() {
    if (!navigator.bluetooth) {
      this._fire('error', { message: 'Web Bluetooth not supported in this browser' });
      return;
    }
    try {
      this._fire('connecting');
      this.device = await navigator.bluetooth.requestDevice({
        filters: [{ services: [this.SERVICE_UUID] }],
        optionalServices: [this.SERVICE_UUID],
      });
      this.device.addEventListener('gattserverdisconnected', this._boundOnDisconnected);
      await this._connectGATT();
    } catch (err) {
      if (err.name !== 'NotFoundError') {
        this._fire('error', { message: err.message || String(err) });
      }
      this._fire('disconnected');
    }
  }

  async disconnect() {
    this._reconnecting = false;
    this._detachChars();
    if (this.device?.gatt?.connected) {
      try { this.device.gatt.disconnect(); } catch {}
    }
    this.connected = false;
    this._fire('disconnected');
  }

  /* ══════════════════════════════════════════════════════
     Public API — commands (BLE write)
  ══════════════════════════════════════════════════════ */

  /**
   * Send a command string to the ESP32 command characteristic.
   * Returns a Promise that resolves when the write completes.
   * For commands that expect a reply (e.g. SD_LIST), listen for
   * the 'cmd' event on window.ble.
   */
  async sendCommand(cmd) {
    if (!this.charCmd) {
      throw new Error('Command characteristic not available — check BLE connection');
    }
    const encoded = new TextEncoder().encode(cmd);
    await this.charCmd.writeValueWithoutResponse(encoded);
  }

  /* ══════════════════════════════════════════════════════
     Public API — file transfer (Wi-Fi HTTP)
  ══════════════════════════════════════════════════════ */

  /**
   * Set the ESP32 Wi-Fi IP address (persisted in localStorage).
   * @param {string} ip  e.g. '192.168.4.1'
   */
  setEspIp(ip) {
    this.espIp = ip.trim();
    localStorage.setItem('kart_esp_ip', this.espIp);
  }

  /**
   * Download a file from the ESP32 SD card over Wi-Fi.
   *
   * @param {string}   filename    — file name as returned by SD_LIST
   * @param {function} onProgress  — called with (bytesReceived, totalBytes)
   * @returns {Promise<ArrayBuffer>} — full file contents
   */
  async downloadFile(filename, onProgress) {
    if (!this.espIp) throw new Error('ESP IP not set — call ble.setEspIp("192.168.x.x") first');

    const url = `http://${this.espIp}/file?name=${encodeURIComponent(filename)}`;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP ${response.status} — ${response.statusText}`);

    const total = parseInt(response.headers.get('Content-Length') || '0', 10);
    const reader = response.body.getReader();
    const chunks = [];
    let received = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      received += value.byteLength;
      if (typeof onProgress === 'function') onProgress(received, total || received);
    }

    // Concatenate all chunks into a single ArrayBuffer
    const buffer = new Uint8Array(received);
    let offset = 0;
    for (const chunk of chunks) {
      buffer.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return buffer.buffer;
  }

  /**
   * Fetch ESP32 status over Wi-Fi.
   * Returns { sdMounted, sdFreeMB, firmware, acqRunning, acqFile }
   */
  async fetchStatus() {
    if (!this.espIp) throw new Error('ESP IP not set');
    const response = await fetch(`http://${this.espIp}/status`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  }

  /* ══════════════════════════════════════════════════════
     Public API — configuration
  ══════════════════════════════════════════════════════ */

  /** Override UUIDs at runtime (persisted in localStorage) */
  setUUIDs(serviceUUID, charUUID, charCmdUUID) {
    this.SERVICE_UUID  = serviceUUID;
    this.CHAR_UUID     = charUUID;
    this.CHAR_CMD_UUID = charCmdUUID || this.CHAR_CMD_UUID;
    localStorage.setItem('kart_ble_uuids', JSON.stringify({
      service: serviceUUID,
      char:    charUUID,
      cmd:     this.CHAR_CMD_UUID,
    }));
  }

  /* ══════════════════════════════════════════════════════
     Private — GATT
  ══════════════════════════════════════════════════════ */

  async _connectGATT() {
    const server  = await this.device.gatt.connect();
    const service = await server.getPrimaryService(this.SERVICE_UUID);

    // Telemetry notify characteristic (existing)
    this.charData = await service.getCharacteristic(this.CHAR_UUID);
    await this.charData.startNotifications();
    this.charData.addEventListener('characteristicvaluechanged', this._boundOnData);

    // Command write characteristic (new)
    try {
      this.charCmd = await service.getCharacteristic(this.CHAR_CMD_UUID);
      // No startNotifications needed — it's write-only from browser side.
    } catch {
      // Graceful degradation: command char not exposed yet on ESP firmware
      this.charCmd = null;
      console.warn('[BLE] Command characteristic not found — commands disabled');
    }

    this.connected = true;
    this._fire('connected', { name: this.device.name || 'ESP32' });
  }

  _onDisconnected() {
    this.connected = false;
    this._detachChars();
    this._fire('disconnected');

    if (this._reconnecting || !this.device) return;
    this._reconnecting = true;
    setTimeout(async () => {
      if (!this.device) return;
      try {
        await this._connectGATT();
        this._reconnecting = false;
      } catch {
        this._reconnecting = false;
      }
    }, 2000);
  }

  _onData(event) {
    try {
      const raw  = new TextDecoder().decode(event.target.value);
      const data = JSON.parse(raw);

      // Route command replies (e.g. SD_LIST response) separately
      if (data.cmd) {
        this._fire('cmd', data);
      } else {
        this._fire('data', data);
      }
    } catch {
      // Silently drop malformed packets
    }
  }

  _detachChars() {
    if (this.charData) {
      try {
        this.charData.removeEventListener('characteristicvaluechanged', this._boundOnData);
      } catch {}
      this.charData = null;
    }
    this.charCmd = null;
  }

  _fire(type, detail) {
    this.dispatchEvent(new CustomEvent(type, detail !== undefined ? { detail } : undefined));
  }

  _loadUUIDs() {
    try {
      return JSON.parse(localStorage.getItem('kart_ble_uuids') || 'null');
    } catch { return null; }
  }
}

window.ble = new BLEManager();