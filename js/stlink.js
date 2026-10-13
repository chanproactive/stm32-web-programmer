// ST-LINK/V2, V2-1 and V3 over WebUSB: the subset needed to reach memory and
// debug registers of a Cortex-M target over SWD.

export const ST_VID = 0x0483;
export const STLINK_MODELS = {
  0x3744: { name: "ST-LINK/V1", gen: 1 },
  0x3748: { name: "ST-LINK/V2", gen: 2 },
  0x374B: { name: "ST-LINK/V2-1", gen: 2 },
  0x3752: { name: "ST-LINK/V2-1 (no drive)", gen: 2 },
  0x374E: { name: "STLINK-V3", gen: 3 },
  0x374F: { name: "STLINK-V3", gen: 3 },
  0x3753: { name: "STLINK-V3", gen: 3 },
  0x3754: { name: "STLINK-V3 (no drive)", gen: 3 },
  0x3757: { name: "STLINK-V3PWR", gen: 3 },
};
export const USB_FILTERS = Object.keys(STLINK_MODELS).map(pid => ({ vendorId: ST_VID, productId: +pid }));

const OK = 0x80;
const STATUS_TEXT = {
  0x81: "target fault", 0x09: "no response from target (check power and cable)",
  0x10: "SWD AP wait", 0x11: "SWD AP fault", 0x12: "SWD AP error", 0x13: "SWD AP parity error",
  0x14: "SWD DP wait", 0x15: "SWD DP fault", 0x16: "SWD DP error", 0x17: "SWD DP parity error",
  0x18: "SWD AP write error", 0x19: "SWD DP write error",
};
// The ST-LINK splits nothing for us: keep each transfer inside one 1 KB
// TAR auto-increment window, as OpenOCD does.
const BLOCK = 1024;

const le32 = (v) => [v & 0xFF, (v >>> 8) & 0xFF, (v >>> 16) & 0xFF, (v >>> 24) & 0xFF];
const hex = (n, w = 8) => "0x" + (n >>> 0).toString(16).toUpperCase().padStart(w, "0");

export class StLinkError extends Error {}

function withTimeout(p, ms, what) {
  let t;
  return Promise.race([p, new Promise((_, rej) => { t = setTimeout(() => rej(new StLinkError(`ST-LINK did not answer (${what})`)), ms); })])
    .finally(() => clearTimeout(t));
}

function findBulkInterface(dev) {
  for (const intf of dev.configuration.interfaces) {
    const alt = intf.alternate || intf.alternates[0];
    if (alt.interfaceClass !== 0xFF) continue;
    const out = alt.endpoints.filter(e => e.type === "bulk" && e.direction === "out");
    const inn = alt.endpoints.filter(e => e.type === "bulk" && e.direction === "in").sort((a, b) => a.endpointNumber - b.endpointNumber);
    if (out.length && inn.length) return { num: intf.interfaceNumber, epOut: out[0].endpointNumber, epIn: inn[0].endpointNumber };
  }
  return null;
}

export class StLink {
  constructor(dev) {
    this.dev = dev;
    this.model = STLINK_MODELS[dev.productId] || { name: "Unknown ST device", gen: 2 };
    this.lock = Promise.resolve();
  }

  async open() {
    const dev = this.dev;
    if (this.model.gen < 2) throw new StLinkError("ST-LINK/V1 is not supported. Use the board's built-in ST-LINK/V2-1 or an STLINK-V3.");
    await dev.open();
    if (!dev.configuration) await dev.selectConfiguration(1);
    const ifc = findBulkInterface(dev);
    if (!ifc) throw new StLinkError("ST-LINK programming interface not found");
    await dev.claimInterface(ifc.num);
    this.ifc = ifc;
    const v = await this.version();
    this.ver = v;
    // API v2 commands need J>=11; the last-RW-status-with-detail command needs J>=15.
    if (this.model.gen === 2 && v.jtag < 13) {
      throw new StLinkError(`ST-LINK firmware V${v.stlink}J${v.jtag} is too old for this tool. Update it with ST-LinkUpgrade.`);
    }
    return v;
  }

  async close() {
    try { if (this.ifc) await this.dev.releaseInterface(this.ifc.num); } catch {}
    try { await this.dev.close(); } catch {}
  }

  // One command at a time; the probe can't interleave.
  _serial(fn) {
    const p = this.lock.then(fn, fn);
    this.lock = p.catch(() => {});
    return p;
  }

  async _out(data, what) {
    const r = await withTimeout(this.dev.transferOut(this.ifc.epOut, data), 3000, what);
    if (r.status !== "ok" || r.bytesWritten !== data.length) throw new StLinkError(`USB send failed (${what}): ${r.status}`);
  }

  async _in(len, what) {
    const buf = new Uint8Array(len);
    let got = 0;
    while (got < len) {
      const r = await withTimeout(this.dev.transferIn(this.ifc.epIn, Math.max(64, len - got)), 3000, what);
      if (r.status !== "ok") throw new StLinkError(`USB receive failed (${what}): ${r.status}`);
      const chunk = new Uint8Array(r.data.buffer, r.data.byteOffset, r.data.byteLength);
      if (!chunk.length) throw new StLinkError(`USB receive returned nothing (${what})`);
      buf.set(chunk.subarray(0, len - got), got);
      got += chunk.length;
    }
    return new DataView(buf.buffer);
  }

  _cmd(bytes, rxLen, what, txData) {
    return this._serial(async () => {
      const c = new Uint8Array(16);
      c.set(bytes);
      await this._out(c, what);
      if (txData) await this._out(txData, what);
      return rxLen ? this._in(rxLen, what) : null;
    });
  }

  _check(status, what) {
    if (status !== OK) throw new StLinkError(`${what}: ${STATUS_TEXT[status] || "status " + hex(status, 2)}`);
  }

  async version() {
    if (this.model.gen === 3) {
      const d = await this._cmd([0xFB], 12, "version");
      return { stlink: d.getUint8(0), swim: d.getUint8(1), jtag: d.getUint8(2), msd: d.getUint8(3) };
    }
    const d = await this._cmd([0xF1], 6, "version");
    const v = (d.getUint8(0) << 8) | d.getUint8(1);
    return { stlink: (v >> 12) & 0xF, jtag: (v >> 6) & 0x3F, swim: v & 0x3F };
  }

  async leaveCurrentMode() {
    const m = (await this._cmd([0xF5], 2, "mode")).getUint8(0);
    if (m === 0) await this._cmd([0xF3, 0x07], 0, "leave DFU");
    else if (m === 2) await this._cmd([0xF2, 0x21], 0, "leave debug");
    else if (m === 3) await this._cmd([0xF4, 0x01], 0, "leave SWIM");
  }

  async voltage() {
    const d = await this._cmd([0xF7], 8, "voltage");
    const a0 = d.getUint32(0, true), a1 = d.getUint32(4, true);
    return a0 ? (2 * a1 * 1.2) / a0 : 0;
  }

  // V2/V2-1 with J22+: 4 MHz SWD. Older firmware and V3 keep their default.
  async setFastSwd() {
    if (this.model.gen !== 2 || this.ver.jtag < 22) return false;
    const d = await this._cmd([0xF2, 0x43, 0, 0], 2, "SWD speed");
    return d.getUint8(0) === OK;
  }

  // 0 = low, 1 = high
  async driveNrst(level) {
    const d = await this._cmd([0xF2, 0x3C, level], 2, "reset pin");
    this._check(d.getUint8(0), "reset pin");
  }

  async enterSwd() {
    const d = await this._cmd([0xF2, 0x30, 0xA3], 2, "enter SWD");
    this._check(d.getUint8(0), "SWD connect");
  }

  async exitDebug() { await this._cmd([0xF2, 0x21], 0, "exit debug"); }

  async idcode() {
    const d = await this._cmd([0xF2, 0x31], 12, "IDCODE");
    this._check(d.getUint8(0), "read IDCODE");
    return d.getUint32(4, true);
  }

  async readDebug32(addr) {
    const d = await this._cmd([0xF2, 0x36, ...le32(addr)], 8, "read register");
    this._check(d.getUint8(0), `read ${hex(addr)}`);
    return d.getUint32(4, true);
  }

  async writeDebug32(addr, val) {
    const d = await this._cmd([0xF2, 0x35, ...le32(addr), ...le32(val)], 2, "write register");
    this._check(d.getUint8(0), `write ${hex(addr)}`);
  }

  async _lastRwStatus(what) {
    if (this.model.gen === 3 || this.ver.jtag >= 15) {
      const d = await this._cmd([0xF2, 0x3E], 12, "status");
      this._check(d.getUint8(0), what);
    } else {
      const d = await this._cmd([0xF2, 0x3B], 2, "status");
      this._check(d.getUint8(0), what);
    }
  }

  // addr and data.length must be multiples of 4.
  async writeMem32(addr, data) {
    for (let off = 0; off < data.length;) {
      const a = addr + off;
      const n = Math.min(data.length - off, BLOCK - (a % BLOCK));
      await this._cmd([0xF2, 0x08, ...le32(a), n & 0xFF, n >> 8], 0, "write memory", data.subarray(off, off + n));
      await this._lastRwStatus(`write memory at ${hex(a)}`);
      off += n;
    }
  }

  async readMem32(addr, len) {
    const out = new Uint8Array(len);
    for (let off = 0; off < len;) {
      const a = addr + off;
      const n = Math.min(len - off, BLOCK - (a % BLOCK));
      const d = await this._cmd([0xF2, 0x07, ...le32(a), n & 0xFF, n >> 8], n, "read memory");
      out.set(new Uint8Array(d.buffer, 0, n), off);
      await this._lastRwStatus(`read memory at ${hex(a)}`);
      off += n;
    }
    return out;
  }
}
