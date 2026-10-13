// Intel HEX parsing and firmware layout for the STM32F746G-DISCO display board.

export const INTERNAL = { base: 0x08000000, size: 0x100000 };
export const QSPI = { base: 0x90000000, size: 0x1000000, sector: 0x10000 };

// RM0385: 4 x 32 KB, 1 x 128 KB, 3 x 256 KB
export const F7_SECTORS = [
  ...[0, 1, 2, 3].map(i => ({ n: i, base: 0x08000000 + i * 0x8000, size: 0x8000 })),
  { n: 4, base: 0x08020000, size: 0x20000 },
  ...[0, 1, 2].map(i => ({ n: 5 + i, base: 0x08040000 + i * 0x40000, size: 0x40000 })),
];

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

const inside = (b, r) => b.addr >= r.base && b.addr + b.data.length <= r.base + r.size;

// Turns HEX blocks into what to erase and write. Each erase unit gets a full
// buffer (0xFF where the file has no data) so it can be CRC-checked whole.
export function makePlan(blocks) {
  const internal = [], qspi = [];
  for (const b of blocks) {
    if (inside(b, INTERNAL)) internal.push(b);
    else if (inside(b, QSPI)) qspi.push(b);
    else throw new Error(`File has data at 0x${b.addr.toString(16).toUpperCase()}, outside internal flash and QSPI. Is this the right file?`);
  }
  const units = (list, unitsFor) => {
    const map = new Map();
    for (const b of list) {
      for (let a = b.addr; a < b.addr + b.data.length;) {
        const u = unitsFor(a);
        let e = map.get(u.base);
        if (!e) { e = { ...u, data: new Uint8Array(u.size).fill(0xFF), used: 0 }; map.set(u.base, e); }
        const n = Math.min(b.addr + b.data.length, u.base + u.size) - a;
        e.data.set(b.data.subarray(a - b.addr, a - b.addr + n), a - u.base);
        e.used += n; a += n;
      }
    }
    return [...map.values()].sort((x, y) => x.base - y.base);
  };
  const sectors = units(internal, a => F7_SECTORS.find(s => a >= s.base && a < s.base + s.size));
  const qsectors = units(qspi, a => {
    const base = a - ((a - QSPI.base) % QSPI.sector);
    return { base, size: QSPI.sector, offset: base - QSPI.base };
  });
  const sum = l => l.reduce((t, b) => t + b.data.length, 0);
  return { sectors, qsectors, internalBytes: sum(internal), qspiBytes: sum(qspi) };
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
