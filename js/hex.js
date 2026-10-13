// Intel HEX parsing and turning a file into an erase/write plan.

import { FLASH_BASE, QSPI, F7_SECTORS, FAMILIES } from "./devices.js";

// Returns a sorted list of contiguous { addr, data } blocks.
export function parseHex(text) {
  const blocks = [];
  let base = 0, cur = null, sawEof = false;
  const lines = text.split(/\r?\n/);
  for (let ln = 0; ln < lines.length; ln++) {
    const line = lines[ln].trim();
    if (!line) continue;
    if (line[0] !== ":" || line.length < 11 || line.length % 2 === 0) throw new Error(`Line ${ln + 1}: not an Intel HEX record`);
    const n = (line.length - 1) / 2;
    const rec = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      const b = parseInt(line.substr(1 + i * 2, 2), 16);
      if (Number.isNaN(b)) throw new Error(`Line ${ln + 1}: bad hex digit`);
      rec[i] = b;
    }
    const len = rec[0];
    if (len + 5 !== n) throw new Error(`Line ${ln + 1}: wrong record length`);
    let sum = 0;
    for (const b of rec) sum = (sum + b) & 0xFF;
    if (sum !== 0) throw new Error(`Line ${ln + 1}: checksum error (file is damaged)`);
    const off = (rec[1] << 8) | rec[2], type = rec[3], data = rec.subarray(4, 4 + len);
    if (type === 0) {
      const addr = (base + off) >>> 0;
      if (cur && cur.end === addr) {
        cur.parts.push(data); cur.end += len;
      } else {
        cur = { addr, end: addr + len, parts: [data] };
        blocks.push(cur);
      }
    } else if (type === 1) {
      sawEof = true; break;
    } else if (type === 2) {
      base = ((data[0] << 8) | data[1]) << 4;
    } else if (type === 4) {
      base = (((data[0] << 8) | data[1]) << 16) >>> 0;
    } // 3 and 5 (start address) are not needed
  }
  if (!sawEof) throw new Error("File is incomplete (no end-of-file record). Download it again.");
  const out = blocks.map(b => {
    const data = new Uint8Array(b.end - b.addr);
    let o = 0;
    for (const p of b.parts) { data.set(p, o); o += p.length; }
    return { addr: b.addr, data };
  }).sort((a, b) => a.addr - b.addr);
  for (let i = 1; i < out.length; i++) {
    if (out[i].addr < out[i - 1].addr + out[i - 1].data.length) throw new Error("File has overlapping data");
  }
  return out;
}

const inside = (b, base, size) => b.addr >= base && b.addr + b.data.length <= base + size;
const hexAddr = (a) => "0x" + a.toString(16).toUpperCase();

// Fill erase units with the file's data. Each unit gets a full buffer
// (0xFF where the file has no data) so it can be CRC-checked whole.
function fillUnits(list, unitFor) {
  const map = new Map();
  for (const b of list) {
    for (let a = b.addr; a < b.addr + b.data.length;) {
      const u = unitFor(a);
      let e = map.get(u.base);
      if (!e) { e = { ...u, data: new Uint8Array(u.size).fill(0xFF) }; map.set(u.base, e); }
      const n = Math.min(b.addr + b.data.length, u.base + u.size) - a;
      e.data.set(b.data.subarray(a - b.addr, a - b.addr + n), a - u.base);
      a += n;
    }
  }
  return [...map.values()].sort((x, y) => x.base - y.base);
}

// family: "F7" (display board) or "L4" (power / sensor boards).
// Returns { family, units, qunits, internalBytes, qspiBytes }:
//   units  - internal flash erase units: F7 sectors { n, base, size, data },
//            L4 runs of up to bufSize/2 KB pages { n: first page, count, base, size, data }
//   qunits - QSPI 64 KB sectors { offset, base, size, data } (F7 only)
export function makePlan(blocks, family) {
  const fam = FAMILIES[family];
  const internal = [], qspi = [];
  for (const b of blocks) {
    if (inside(b, FLASH_BASE, fam.maxFlash)) internal.push(b);
    else if (inside(b, QSPI.base, QSPI.size)) {
      if (!fam.qspi) throw new Error("This file has screen-graphics (QSPI) data, so it is display board firmware, not for this board.");
      qspi.push(b);
    } else throw new Error(`File has data at ${hexAddr(b.addr)}, outside this board's flash. Is this the right file?`);
  }

  let units;
  if (family === "F7") {
    units = fillUnits(internal, a => F7_SECTORS.find(s => a >= s.base && a < s.base + s.size));
  } else {
    // Pages the file touches, grouped into consecutive runs that fit the RAM buffer.
    const ps = fam.pageSize, maxRun = fam.ram.bufSize / ps;
    const pages = fillUnits(internal, a => {
      const n = Math.floor((a - FLASH_BASE) / ps);
      return { n, count: 1, base: FLASH_BASE + n * ps, size: ps };
    });
    units = [];
    for (const p of pages) {
      const last = units[units.length - 1];
      if (last && last.n + last.count === p.n && last.count < maxRun) {
        const data = new Uint8Array(last.size + ps);
        data.set(last.data); data.set(p.data, last.size);
        last.count++; last.size += ps; last.data = data;
      } else units.push({ ...p });
    }
  }
  const qunits = fillUnits(qspi, a => {
    const base = a - ((a - QSPI.base) % QSPI.sector);
    return { base, size: QSPI.sector, offset: base - QSPI.base };
  });
  const sum = l => l.reduce((t, b) => t + b.data.length, 0);
  return { family, units, qunits, internalBytes: sum(internal), qspiBytes: sum(qspi) };
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();

export function crc32(data) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}
