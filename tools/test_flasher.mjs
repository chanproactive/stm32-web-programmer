// Runs the page's Flasher against a simulated probe + STM32F746, with the
// real firmware file. Usage: node tools/test_flasher.mjs firmware.hex
import { readFileSync } from "node:fs";
import { parseHex, makePlan, crc32, F7_SECTORS } from "../js/hex.js";
import { Flasher } from "../js/flasher.js";
import { LOADER } from "../js/loader-blob.js";

globalThis.atob ??= (s) => Buffer.from(s, "base64").toString("binary");
const assert = (c, m) => { if (!c) throw new Error("ASSERT: " + m); };

class SimTarget {
  constructor() {
    this.ram = new Uint8Array(0x50000);
    this.flash = new Uint8Array(0x100000).fill(0xA5);
    this.qspi = new Uint8Array(0x1000000).fill(0x5A);
    this.regs = new Uint32Array(20);
    this.halted = false; this.demcr = 0; this.dcrdr = 0; this.flashLocked = true;
    this.mmap = false; this.qspiReady = false; this.calls = [];
    this.wrp = 0xFF; this.rdp = 0xAA;
  }
  mem(addr) {
    if (addr >= 0x20000000 && addr < 0x20050000) return [this.ram, addr - 0x20000000];
    if (addr >= 0x08000000 && addr < 0x08100000) return [this.flash, addr - 0x08000000];
    if (addr >= 0x90000000 && addr < 0x91000000) { assert(this.mmap, "QSPI read before memory-mapped"); return [this.qspi, addr - 0x90000000]; }
    throw new Error("bad address " + addr.toString(16));
  }
  async readMem32(addr, len) {
    assert(addr % 4 === 0 && len % 4 === 0, "unaligned read");
    const [m, o] = this.mem(addr); return m.slice(o, o + len);
  }
  async writeMem32(addr, data) {
    assert(addr % 4 === 0 && data.length % 4 === 0, "unaligned write");
    assert(addr >= 0x20000000 && addr < 0x20050000, "probe wrote outside RAM");
    const [m, o] = this.mem(addr); m.set(data, o);
  }
  async readDebug32(addr) {
    switch (addr) {
      case 0xE000EDF0: return (this.halted ? 1 << 17 : 0) | (1 << 16);
      case 0xE000EDF8: return this.dcrdr;
      case 0xE0042000: return 0x10010449;
      case 0x1FF0F440: return 0x0400 << 16;
      case 0x40023C14: return (this.wrp << 16) | (this.rdp << 8);
    }
    throw new Error("unexpected debug read " + addr.toString(16));
  }
  async writeDebug32(addr, v) {
    switch (addr) {
      case 0xE000EDF0:
        if (!(v & 1)) { this.halted = false; this.released = true; return; } // debug off: app runs
        if (v & 2) this.halted = true;
        else if (this.halted) { assert(v & 8, "running loader without MASKINTS"); this.halted = false; this.exec(); }
        return;
      case 0xE000EDFC: this.demcr = v; return;
      case 0xE000ED0C: if (this.demcr & 1) { this.halted = true; this.wasReset = true; } return;
      case 0xE000EDF8: this.dcrdr = v; return;
      case 0xE000EDF4:
        assert(this.halted, "register access while running");
        if (v & 0x10000) this.regs[v & 0x1F] = this.dcrdr; else this.dcrdr = this.regs[v & 0x1F];
        return;
      case 0xE0042004: case 0xE0042008: return;
    }
    throw new Error("unexpected debug write " + addr.toString(16));
  }
  exec() {
    const [cmd, a, b, c] = this.regs;
    const code = Uint8Array.from(atob(LOADER.code), ch => ch.charCodeAt(0));
    assert(this.regs[15] === 0x20010000 + LOADER.entry && this.regs[14] === (0x20010000 + LOADER.done | 1), "bad entry/LR");
    assert(this.ram.subarray(0x10000, 0x10000 + code.length).every((x, i) => x === code[i]), "loader not in RAM");
    assert(this.regs[16] === 0x01000000 && this.regs[13] === 0x20014000, "bad xPSR/SP");
    this.calls.push(cmd);
    let r = 0;
    const buf = (p, n) => this.ram.subarray(p - 0x20000000, p - 0x20000000 + n);
    switch (cmd) {
      case 1: { const s = F7_SECTORS[a]; this.flash.fill(0xFF, s.base - 0x08000000, s.base - 0x08000000 + s.size); this.flashLocked = false; break; }
      case 2: {
        assert(!this.flashLocked, "write to locked flash"); const d = buf(b, c);
        for (let i = 0; i < c; i++) { assert(this.flash[a - 0x08000000 + i] === 0xFF, "write to non-erased flash"); this.flash[a - 0x08000000 + i] = d[i]; }
        break;
      }
      case 3: this.flashLocked = true; break;
      case 4: this.qspiReady = true; this.mmap = false; r = 0x20BA18; break;
      case 5: assert(this.qspiReady && a % 0x10000 === 0, "qspi erase"); this.qspi.fill(0xFF, a, a + 0x10000); break;
      case 6: { assert(this.qspiReady && !this.mmap, "qspi write"); const d = buf(b, c);
        for (let i = 0; i < c; i++) { assert(this.qspi[a + i] === 0xFF, "qspi write non-erased"); this.qspi[a + i] = d[i]; } break; }
      case 7: this.mmap = true; break;
      case 8: { const [m, o] = this.mem(a); r = crc32(m.subarray(o, o + b)); break; }
      default: r = 0x82000000;
    }
    this.regs[0] = r; this.regs[15] = 0x20010000 + LOADER.done; this.halted = true;
  }
}

const file = process.argv[2];
const blocks = parseHex(readFileSync(file, "latin1"));
const plan = makePlan(blocks);
console.log(`plan: internal sectors [${plan.sectors.map(s => s.n)}], ${plan.qsectors.length} QSPI sectors, ` +
  `${plan.internalBytes} + ${plan.qspiBytes} bytes`);

const sim = new SimTarget();
const sector1Before = sim.flash.slice(0x8000, 0x10000);
const f = new Flasher(sim, { log: () => {}, sleepFn: async () => {} });
const info = await f.inspect();
assert(sim.wasReset && sim.halted, "not reset-halted");
assert(info.flashKB === 1024, "flash size");
await f.loadLoader();
let last = 0;
await f.program(plan, info, (p) => { assert(p >= last - 1e-9, "progress went backwards"); last = p; });
assert(Math.abs(last - 1) < 1e-9, "progress did not reach 100%: " + last);

for (const b of blocks) {
  const isQ = b.addr >= 0x90000000;
  const mem = isQ ? sim.qspi : sim.flash, off = b.addr - (isQ ? 0x90000000 : 0x08000000);
  for (let i = 0; i < b.data.length; i++) if (mem[off + i] !== b.data[i]) throw new Error(`mismatch at ${(b.addr + i).toString(16)}`);
}
assert(sim.flash.subarray(0x8000, 0x10000).every((x, i) => x === sector1Before[i]), "sector 1 (not in file) was modified");
assert(sim.flashLocked, "flash left unlocked");
console.log(`OK: ${sim.calls.length} loader calls, all data matches, sector 1 untouched`);

// Failure paths
const bad = new SimTarget(); bad.rdp = 0xBB;
await new Flasher(bad, { sleepFn: async () => {} }).inspect().then(() => { throw new Error("RDP not detected"); }, e => console.log("RDP check OK:", e.message.slice(0, 50)));
const wp = new SimTarget(); wp.wrp = 0xFE;
const fw = new Flasher(wp, { sleepFn: async () => {} });
const i2 = await fw.inspect(); await fw.loadLoader();
await fw.program(plan, i2).then(() => { throw new Error("WRP not detected"); }, e => console.log("WRP check OK:", e.message.slice(0, 50)));
for (const t of [":10000000", ":020000040800F2\n:0400000001020304F2\n"]) {
  try { parseHex(t); throw new Error("bad hex accepted"); } catch (e) { assert(!/accepted/.test(e.message), e.message); }
}
console.log("hex error checks OK");

// ---- Same flow through the real StLink packet layer, with a fake ST-LINK/V2-1 USB device ----
import { StLink } from "../js/stlink.js";

class FakeStLinkDevice {
  constructor(target) {
    this.t = target; this.productId = 0x374B; this.vendorId = 0x0483; this.pending = null; this.queue = [];
    this.configuration = { interfaces: [
      { interfaceNumber: 0, alternate: { interfaceClass: 0x08, endpoints: [] } },
      { interfaceNumber: 1, alternate: { interfaceClass: 0xFF, endpoints: [
        { endpointNumber: 1, direction: "out", type: "bulk" }, { endpointNumber: 1, direction: "in", type: "bulk" },
        { endpointNumber: 2, direction: "in", type: "bulk" }] } }] };
    this.stats = { cmds: 0, bytesOut: 0 };
  }
  async open() {} async close() {} async selectConfiguration() {} async claimInterface(n) { assert(n === 1, "claimed wrong interface"); }
  async releaseInterface() {}
  reply(arr) { this.queue.push(Uint8Array.from(arr)); }
  async transferOut(ep, data) {
    assert(ep === 1, "wrong OUT endpoint");
    const d = new Uint8Array(data.buffer ? data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) : data);
    this.stats.bytesOut += d.length;
    if (this.pending) { // data phase of write memory
      const { addr, len } = this.pending; this.pending = null;
      assert(d.length === len, "write data length mismatch");
      assert(Math.floor(addr / 1024) === Math.floor((addr + len - 1) / 1024), "write crosses 1 KB boundary");
      await this.t.writeMem32(addr, d); this.lastOk = true;
      return { status: "ok", bytesWritten: d.length };
    }
    assert(d.length === 16, "command not 16 bytes");
    this.stats.cmds++;
    const u32 = (o) => (d[o] | d[o + 1] << 8 | d[o + 2] << 16 | d[o + 3] << 24) >>> 0;
    const w32 = (v) => [v & 255, v >>> 8 & 255, v >>> 16 & 255, v >>> 24];
    if (d[0] === 0xF1) this.reply([0x29, 0x80, 0x83, 0x04, 0x4B, 0x37]); // V2 J38 S0
    else if (d[0] === 0xF5) this.reply([1, 0]);
    else if (d[0] === 0xF7) this.reply([...w32(1600), ...w32(2200)]);
    else if (d[0] === 0xF2) {
      switch (d[1]) {
        case 0x43: case 0x30: this.reply([0x80, 0]); break;
        case 0x31: this.reply([0x80, 0, 0, 0, ...w32(0x5BA02477), ...w32(0)]); break;
        case 0x36: this.reply([0x80, 0, 0, 0, ...w32(await this.t.readDebug32(u32(2)))]); break;
        case 0x35: await this.t.writeDebug32(u32(2), u32(6)); this.reply([0x80, 0]); break;
        case 0x08: this.pending = { addr: u32(2), len: d[6] | d[7] << 8 }; break;
        case 0x07: {
          const addr = u32(2), len = d[6] | d[7] << 8;
          assert(Math.floor(addr / 1024) === Math.floor((addr + len - 1) / 1024), "read crosses 1 KB boundary");
          this.reply(await this.t.readMem32(addr, len)); break;
        }
        case 0x3E: this.reply([0x80, ...new Array(11).fill(0)]); break;
        case 0x21: break;
        default: throw new Error("fake ST-LINK: unknown F2 " + d[1].toString(16));
      }
    } else throw new Error("fake ST-LINK: unknown cmd " + d[0].toString(16));
    return { status: "ok", bytesWritten: d.length };
  }
  async transferIn(ep, len) {
    assert(ep === 1, "wrong IN endpoint");
    const q = this.queue.shift();
    assert(q, "read with no pending reply");
    // deliver in 64-byte USB packets like real hardware may
    const chunk = q.subarray(0, 64);
    if (q.length > 64) this.queue.unshift(q.subarray(64));
    assert(len >= chunk.length, "transferIn buffer too small");
    return { status: "ok", data: new DataView(chunk.slice().buffer) };
  }
}

{
  const sim2 = new SimTarget();
  const dev = new FakeStLinkDevice(sim2);
  const st = new StLink(dev);
  const v = await st.open();
  assert(v.stlink === 2 && v.jtag === 38, "version decode " + JSON.stringify(v));
  await st.leaveCurrentMode();
  const volts = await st.voltage();
  assert(Math.abs(volts - 3.3) < 0.01, "voltage decode " + volts);
  assert(await st.setFastSwd(), "fast swd");
  await st.enterSwd();
  assert(await st.idcode() === 0x5BA02477, "idcode");
  const f2 = new Flasher(st, { sleepFn: async () => {} });
  const info2 = await f2.inspect();
  await f2.loadLoader();
  await f2.program(plan, info2);
  await f2.resetRun();
  for (const b of blocks) {
    const isQ = b.addr >= 0x90000000;
    const mem = isQ ? sim2.qspi : sim2.flash, off = b.addr - (isQ ? 0x90000000 : 0x08000000);
    for (let i = 0; i < b.data.length; i++) if (mem[off + i] !== b.data[i]) throw new Error(`stlink path mismatch at ${(b.addr + i).toString(16)}`);
  }
  assert(dev.queue.length === 0, "unread replies left");
  assert(sim2.released, "board not released to run");
  console.log(`StLink packet path OK: ${dev.stats.cmds} USB commands, ${(dev.stats.bytesOut / 1048576).toFixed(1)} MB sent`);
}
