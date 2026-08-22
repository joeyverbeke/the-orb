// The device link. One WebSocket to tools/bridge.py, shared by every page.
//
// The firmware speaks compact CSV and one-letter commands; the bridge turns
// that into JSON. Nothing above this file needs to know either format.

const DEFAULT_URL = `ws://${location.hostname || 'localhost'}:8765`;

// The firmware echoes its entire settings block after most commands, so
// driving haptics with 'H' at frame rate would flood the serial link with
// config dumps. 'v' sets the same value silently -- see console.cpp.
const HAPTIC_CMD = 'v';

// No point sending faster than the motor can respond; the ERM's own spin-up is
// 40-60 ms.
const HAPTIC_MIN_INTERVAL_MS = 16;

export class OrbLink {
  constructor(url = DEFAULT_URL) {
    this.url = url;
    this.ws = null;
    this.connected = false;   // websocket to the bridge
    this.device = false;      // orb actually plugged in
    this.port = null;
    this.latest = null;
    this.config = {};

    this._frameCbs = new Set();
    this._batchCbs = new Set();
    this._configCbs = new Set();
    this._statusCbs = new Set();

    this._haptic = { owned: false, last: -1, sentAt: 0 };
    this._retry = null;

    // Best effort only. Measured on this setup: navigating away does NOT get
    // this onto the wire -- the socket is torn down first, and no release is
    // ever written. The device is the real safety net; it times a host-driven
    // hold out by itself after HOLD_TIMEOUT_MS (console.cpp). Keep both, but
    // do not rely on this one.
    addEventListener('pagehide', () => this.releaseHaptic());

    // A page you cannot see must not be driving the thing in your hand.
    // Several experiment tabs left open otherwise all write the motor at once
    // and the last one to speak wins, which reads as the haptics being broken
    // rather than as a tab fighting you from behind another window.
    addEventListener('visibilitychange', () => {
      if (document.hidden) this.releaseHaptic();
    });
  }

  connect() {
    if (this.ws && (this.ws.readyState === 0 || this.ws.readyState === 1)) return this;

    this.ws = new WebSocket(this.url);

    this.ws.onopen = () => {
      this.connected = true;
      this._emit(this._statusCbs, this.statusOf());
    };

    this.ws.onclose = () => {
      this.connected = false;
      this.device = false;
      this._haptic.owned = false;
      this._emit(this._statusCbs, this.statusOf());
      clearTimeout(this._retry);
      this._retry = setTimeout(() => this.connect(), 1200);
    };

    this.ws.onerror = () => this.ws?.close();

    this.ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }

      if (msg.type === 'frames') {
        const frames = msg.frames;
        if (!frames?.length) return;
        this.latest = frames[frames.length - 1];
        // Per-frame subscribers see every sample -- peaks matter. Batch
        // subscribers (renderers) usually only want the newest.
        for (const f of frames) this._emit(this._frameCbs, f);
        this._emit(this._batchCbs, frames);
      } else if (msg.type === 'config') {
        this.config = msg.config;
        this._emit(this._configCbs, msg.config);
      } else if (msg.type === 'status') {
        this.device = !!msg.device;
        this.port = msg.port ?? null;
        if (!this.device) this.latest = null;
        this._emit(this._statusCbs, this.statusOf());
      }
    };

    return this;
  }

  _emit(set, arg) {
    for (const cb of set) {
      try { cb(arg); } catch (err) { console.error(err); }
    }
  }

  onFrame(cb)  { this._frameCbs.add(cb);  return () => this._frameCbs.delete(cb); }
  onFrames(cb) { this._batchCbs.add(cb);  return () => this._batchCbs.delete(cb); }
  onConfig(cb) {
    this._configCbs.add(cb);
    if (Object.keys(this.config).length) cb(this.config);
    return () => this._configCbs.delete(cb);
  }
  statusOf() {
    return { connected: this.connected, device: this.device, port: this.port };
  }

  onStatus(cb) {
    this._statusCbs.add(cb);
    cb(this.statusOf());
    return () => this._statusCbs.delete(cb);
  }

  send(cmd) {
    if (this.ws?.readyState === 1) this.ws.send(JSON.stringify({ type: 'cmd', cmd }));
  }

  /** Ask the orb to re-announce its settings. */
  refresh() { this.send('p'); }

  // --- haptics ------------------------------------------------------------
  //
  // Taking the haptics overrides the firmware's own mode pipeline: the
  // experiment decides what the hand feels, not the IMU. Release to hand it
  // back.

  setHaptic(v) {
    if (document.hidden) return;      // see the visibilitychange note above
    const clamped = Math.max(0, Math.min(1, v));
    const now = performance.now();
    const changed = Math.abs(clamped - this._haptic.last) > 0.004;
    if (!changed && now - this._haptic.sentAt < 200) return;   // keepalive only
    if (now - this._haptic.sentAt < HAPTIC_MIN_INTERVAL_MS) return;

    this._haptic.owned = true;
    this._haptic.last = clamped;
    this._haptic.sentAt = now;
    this.send(`${HAPTIC_CMD} ${clamped.toFixed(3)}`);
  }

  releaseHaptic() {
    if (!this._haptic.owned) return;
    this._haptic.owned = false;
    this._haptic.last = -1;
    this.send(`${HAPTIC_CMD} -1`);
  }

  get ownsHaptic() { return this._haptic.owned; }

  // --- mode control, for pages that want it -------------------------------

  setQuantity(q) { this.send(`Q ${q}`); }
  setSource(s)   { this.send(`S ${s}`); }
  setAxis(a)     { this.send(`a ${a}`); }
  resetReference() { this.send('R'); }
  stopMotor()    { this.send('z'); }
}

export const orb = new OrbLink();
