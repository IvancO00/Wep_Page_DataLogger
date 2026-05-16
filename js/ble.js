/**
 * ble.js — Web Bluetooth connection manager
 *
 * BLE JSON packet format (from ESP32):
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
 * Events fired on window.ble (EventTarget):
 *   'connecting'   — scan started
 *   'connected'    — detail: { name }
 *   'disconnected' — no detail
 *   'data'         — detail: parsed JSON object
 *   'error'        — detail: { message }
 */

class BLEManager extends EventTarget {
  constructor() {
    super();
    this.SERVICE_UUID   = '91bad492-b950-4226-aa2b-4ede9fa42f59';
    this.CHAR_UUID      = 'ca73b3ba-39f6-4ab3-91ae-186dc9577d99';

    this.device         = null;
    this.characteristic = null;
    this.connected      = false;
    this._reconnecting  = false;

    // Allow UUID override from localStorage (for settings panel)
    const cfg = this._loadUUIDs();
    if (cfg) {
      this.SERVICE_UUID = cfg.service || this.SERVICE_UUID;
      this.CHAR_UUID    = cfg.char    || this.CHAR_UUID;
    }

    this._boundOnData         = this._onData.bind(this);
    this._boundOnDisconnected = this._onDisconnected.bind(this);
  }

  /* ── Public API ──────────────────────────────────── */

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
      if (err.name !== 'NotFoundError') {        // User cancelled — don't show error
        this._fire('error', { message: err.message || String(err) });
      }
      this._fire('disconnected');
    }
  }

  async disconnect() {
    this._reconnecting = false;
    this._detachChar();
    if (this.device?.gatt?.connected) {
      try { this.device.gatt.disconnect(); } catch {}
    }
    this.connected = false;
    this._fire('disconnected');
  }

  /** Override UUIDs at runtime (persisted in localStorage) */
  setUUIDs(serviceUUID, charUUID) {
    this.SERVICE_UUID = serviceUUID;
    this.CHAR_UUID    = charUUID;
    localStorage.setItem('kart_ble_uuids', JSON.stringify({ service: serviceUUID, char: charUUID }));
  }

  /* ── Private ─────────────────────────────────────── */

  async _connectGATT() {
    const server  = await this.device.gatt.connect();
    const service = await server.getPrimaryService(this.SERVICE_UUID);
    this.characteristic = await service.getCharacteristic(this.CHAR_UUID);

    await this.characteristic.startNotifications();
    this.characteristic.addEventListener('characteristicvaluechanged', this._boundOnData);

    this.connected = true;
    this._fire('connected', { name: this.device.name || 'ESP32' });
  }

  _onDisconnected() {
    this.connected = false;
    this._detachChar();
    this._fire('disconnected');

    // Auto-reconnect once
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
      this._fire('data', data);
    } catch {
      // Silently drop malformed packets
    }
  }

  _detachChar() {
    if (this.characteristic) {
      try {
        this.characteristic.removeEventListener('characteristicvaluechanged', this._boundOnData);
      } catch {}
      this.characteristic = null;
    }
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
