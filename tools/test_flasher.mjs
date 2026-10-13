// Runs the page's Flasher against a simulated probe + STM32 (F746 display
// board or L4 power/sensor board), with real firmware files, both directly and
// through the real StLink USB packet layer with a fake ST-LINK.
// Usage: node tools/test_flasher.mjs display.hex power.hex sensor.hex
import { readFileSync } from "node:fs";
import { parseHex, makePlan, crc32 } from "../js/hex.js";
import { F7_SECTORS, boardFromFileName, BOARDS } from "../js/devices.js";
import { Flasher } from "../js/flasher.js";
import { StLink } from "../js/stlink.js";
import { LOADER } from "../js/loader-blob.js";

globalThis.atob ??= (s) => Buffer.from(s, "base64").toString("binary");
const assert = (c, m) => { if (!c) throw new Error("ASSERT: " + m); };
const noSleep = { sleepFn: async () => {} };

const CHIP = {
  F7: { idcode: 0x10010449, ram: [0x20000000, 0x50000], flashSize: 0x100000, code: 0x20010000, stack: 0x20014000 },
  L4: { idcode: 0x10006435, ram: [0x20000000, 0xC000], flashSize: 0x40000, code: 0x20000000, stack: 0x20002000 },
};

class SimTarget {
  constructor(family) {
    this.f = family; this.c = CHIP[family];
    this.ram = new Uint8Array(this.c.ram[1]);
    this.flash = new Uint8Array(this.c.flashSize).fill(0xA5);
    this.qspi = family === "F7" ? new Uint8Array(0x1000000).fill(0x5A) : null;
    this.regs = new Uint32Array(20);
    this.halted = false; this.demcr = 0; this.dcrdr = 0; this.flashLocked = true;
    this.mmap = false; this.qspiReady = false; this.calls = [];
    this.wrp = 0xFF; this.rdp = 0xAA; this.l4wrp = 0x000000FF;
  }
  mem(addr) {
    if (addr >= 0x20000000 && addr < 0x20000000 + this.ram.length) return [this.ram, addr - 0x20000000];
    if (addr >= 0x08000000 && addr < 0x08000000 + this.flash.length) return [this.flash, addr - 0x08000000];
    if (this.qspi && addr >= 0x90000000 && addr < 0x91000000) { assert(this.mmap, "QSPI read before memory-mapped"); return [this.qspi, addr - 0x90000000]; }
    throw new Error("bad address " + addr.toString(16));
  }
  async readMem32(addr, len) {
    assert(addr % 4 === 0 && len % 4 === 0, "unaligned read");
    const [m, o] = this.mem(addr); return m.slice(o, o + len);
  }
  async writeMem32(addr, data) {
    assert(addr % 4 === 0 && data.length % 4 === 0, "unaligned write");
    assert(addr >= 0x20000000 && addr + data.length <= 0x20000000 + this.ram.length, "probe wrote outside RAM");
    const [m, o] = this.mem(addr); m.set(data, o);
  }
  async readDebug32(addr) {
    switch (addr) {
      case 0xE000EDF0: return (this.halted ? 1 << 17 : 0) | (1 << 16);
      case 0xE000EDF8: return this.dcrdr;
      case 0xE0042000: return this.c.idcode;
    }
    if (this.f === "F7") {
      if (addr === 0x1FF0F440) return 0x0400 << 16;
      if (addr === 0x40023C14) return (this.wrp << 16) | (this.rdp << 8);
    } else {
      if (addr === 0x1FFF75E0) return 0xFFFF0000 | (this.flash.length / 1024);
      if (addr === 0x40022020) return 0xFFEFF800 | this.rdp;
      if (addr === 0x4002202C) return this.l4wrp;
      if (addr === 0x40022030) return 0x000000FF;
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
    const base = this.c.code;
    assert(this.regs[15] === base + LOADER.entry && this.regs[14] === (base + LOADER.done | 1), "bad entry/LR");
    assert(this.ram.subarray(base - 0x20000000, base - 0x20000000 + code.length).every((x, i) => x === code[i]), "loader not in RAM");
    assert(this.regs[16] === 0x01000000 && this.regs[13] === this.c.stack, "bad xPSR/SP");
    const f7only = () => assert(this.f === "F7", `F7 command ${cmd} sent to L4`);
    const l4only = () => assert(this.f === "L4", `L4 command ${cmd} sent to F7`);
    this.calls.push(cmd);
    let r = 0;
    const buf = (p, n) => { const [m, o] = this.mem(p); assert(m === this.ram, "buffer not in RAM"); return m.subarray(o, o + n); };
    const program = (addr, d, align) => {
      assert(!this.flashLocked, "write to locked flash");
      assert(addr % align === 0 && d.length % align === 0, "write alignment");
      for (let i = 0; i < d.length; i++) { assert(this.flash[addr - 0x08000000 + i] === 0xFF, "write to non-erased flash"); this.flash[addr - 0x08000000 + i] = d[i]; }
    };
    switch (cmd) {
      case 1: { f7only(); const s = F7_SECTORS[a]; this.flash.fill(0xFF, s.base - 0x08000000, s.base - 0x08000000 + s.size); this.flashLocked = false; break; }
      case 2: f7only(); program(a, buf(b, c), 4); break;
      case 3: f7only(); this.flashLocked = true; break;
      case 4: f7only(); this.qspiReady = true; this.mmap = false; r = 0x20BA18; break;
      case 5: f7only(); assert(this.qspiReady && a % 0x10000 === 0, "qspi erase"); this.qspi.fill(0xFF, a, a + 0x10000); break;
      case 6: { f7only(); assert(this.qspiReady && !this.mmap, "qspi write"); const d = buf(b, c);
        for (let i = 0; i < c; i++) { assert(this.qspi[a + i] === 0xFF, "qspi write non-erased"); this.qspi[a + i] = d[i]; } break; }
      case 7: f7only(); this.mmap = true; break;
      case 8: { const [m, o] = this.mem(a); r = crc32(m.subarray(o, o + b)); break; }
      case 9: l4only(); assert(c === 0, "single-bank chip got pages-per-bank");
        for (let p = a; p < a + b; p++) this.flash.fill(0xFF, p * 2048, (p + 1) * 2048);
        this.flashLocked = false; break;
      case 10: l4only(); program(a, buf(b, c), 8); break;
      case 11: l4only(); this.flashLocked = true; break;
      default: r = 0x82000000;
    }
    this.regs[0] = r; this.regs[15] = base + LOADER.done; this.halted = true;
  }
}

// Fake ST-LINK USB device. v2 = dongle (ST-LINK/V2, PID 3748, OUT ep 2, old J17
// firmware); otherwise the display board's built-in V2-1 (PID 374B, OUT ep 1, J38).
class FakeStLinkDevice {
  constructor(target, v2) {
    this.t = target; this.v2 = v2; this.vendorId = 0x0483;
    this.productId = v2 ? 0x3748 : 0x374B; this.epOut = v2 ? 2 : 1;
    this.jtag = v2 ? 17 : 38;
    this.pending = null; this.queue = [];
    this.configuration = { interfaces: v2
      ? [{ interfaceNumber: 0, alternate: { interfaceClass: 0xFF, endpoints: [
          { endpointNumber: 1, direction: "in", type: "bulk" }, { endpointNumber: 2, direction: "out", type: "bulk" },
          { endpointNumber: 3, direction: "in", type: "bulk" }] } }]
      : [{ interfaceNumber: 0, alternate: { interfaceClass: 0x08, endpoints: [] } },
         { interfaceNumber: 1, alternate: { interfaceClass: 0xFF, endpoints: [
          { endpointNumber: 1, direction: "out", type: "bulk" }, { endpointNumber: 1, direction: "in", type: "bulk" },
          { endpointNumber: 2, direction: "in", type: "bulk" }] } }] };
    this.stats = { cmds: 0, bytesOut: 0 };
  }
  async open() {} async close() {} async selectConfiguration() {} async releaseInterface() {}
  async claimInterface(n) { assert(n === (this.v2 ? 0 : 1), "claimed wrong interface"); }
  reply(arr) { this.queue.push(Uint8Array.from(arr)); }
  async transferOut(ep, data) {
    assert(ep === this.epOut, `wrong OUT endpoint ${ep}`);
    const d = new Uint8Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
    this.stats.bytesOut += d.length;
    if (this.pending) { // data phase of write memory
      const { addr, len } = this.pending; this.pending = null;
      assert(d.length === len, "write data length mismatch");
      assert(Math.floor(addr / 1024) === Math.floor((addr + len - 1) / 1024), "write crosses 1 KB boundary");
      await this.t.writeMem32(addr, d);
      return { status: "ok", bytesWritten: d.length };
    }
    assert(d.length === 16, "command not 16 bytes");
    this.stats.cmds++;
    const u32 = (o) => (d[o] | d[o + 1] << 8 | d[o + 2] << 16 | d[o + 3] << 24) >>> 0;
    const w32 = (v) => [v & 255, v >>> 8 & 255, v >>> 16 & 255, v >>> 24];
    const ver = (2 << 12) | (this.jtag << 6);
    if (d[0] === 0xF1) this.reply([ver >> 8, ver & 255, 0x83, 0x04, this.productId & 255, this.productId >> 8]);
    else if (d[0] === 0xF5) this.reply([1, 0]);
    else if (d[0] === 0xF7) this.reply([...w32(1600), ...w32(2200)]);
    else if (d[0] === 0xF2) {
      switch (d[1]) {
        case 0x43: assert(this.jtag >= 22, "SWD speed command on old firmware"); this.reply([0x80, 0]); break;
        case 0x30: this.reply([0x80, 0]); break;
        case 0x31: this.reply([0x80, 0, 0, 0, ...w32(0x2BA01477), ...w32(0)]); break;
        case 0x36: this.reply([0x80, 0, 0, 0, ...w32(await this.t.readDebug32(u32(2)))]); break;
        case 0x35: await this.t.writeDebug32(u32(2), u32(6)); this.reply([0x80, 0]); break;
        case 0x08: this.pending = { addr: u32(2), len: d[6] | d[7] << 8 }; break;
        case 0x07: {
          const addr = u32(2), len = d[6] | d[7] << 8;
          assert(Math.floor(addr / 1024) === Math.floor((addr + len - 1) / 1024), "read crosses 1 KB boundary");
          this.reply(await this.t.readMem32(addr, len)); break;
        }
        case 0x3E: assert(this.jtag >= 15, "0x3E on old firmware"); this.reply([0x80, ...new Array(11).fill(0)]); break;
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
    const chunk = q.subarray(0, 64); // 64-byte USB packets
    if (q.length > 64) this.queue.unshift(q.subarray(64));
    assert(len >= chunk.length, "transferIn buffer too small");
    return { status: "ok", data: new DataView(chunk.slice().buffer) };
  }
}

function checkImage(sim, blocks) {
  for (const b of blocks) {
    const isQ = b.addr >= 0x90000000;
    const mem = isQ ? sim.qspi : sim.flash, off = b.addr - (isQ ? 0x90000000 : 0x08000000);
    for (let i = 0; i < b.data.length; i++) if (mem[off + i] !== b.data[i]) throw new Error(`mismatch at ${(b.addr + i).toString(16)}`);
  }
}

for (const file of process.argv.slice(2)) {
  const board = boardFromFileName(file);
  assert(board, "file name doesn't name a board: " + file);
  const family = BOARDS[board].family;
  const blocks = parseHex(readFileSync(file, "latin1"));
  const plan = makePlan(blocks, family);
  console.log(`\n== ${board} (${family}): ${plan.units.length} flash units, ${plan.qunits.length} QSPI sectors, ${plan.internalBytes} + ${plan.qspiBytes} bytes`);

  // Direct
  const sim = new SimTarget(family);
  const before = sim.flash.slice();
  const f = new Flasher(sim, noSleep);
  const info = await f.inspect(family);
  assert(sim.wasReset && sim.halted, "not reset-halted");
  await f.loadLoader();
  let last = 0;
  await f.program(plan, (p) => { assert(p >= last - 1e-9, "progress went backwards"); last = p; });
  assert(Math.abs(last - 1) < 1e-9, "progress did not reach 100%: " + last);
  checkImage(sim, blocks);
  assert(sim.flashLocked, "flash left unlocked");
  // Everything outside the erase units is untouched
  const touched = (a) => plan.units.some(u => a >= u.base && a < u.base + u.size);
  for (let i = 0; i < sim.flash.length; i++) if (!touched(0x08000000 + i) && sim.flash[i] !== before[i]) throw new Error(`modified outside plan at ${i.toString(16)}`);
  console.log(`direct OK: ${sim.calls.length} loader calls, data matches, nothing else touched (${info.chip.name})`);

  // Wrong board: the same file on the other family's chip must be refused
  const other = new Flasher(new SimTarget(family === "F7" ? "L4" : "F7"), noSleep);
  await other.inspect(family).then(() => { throw new Error("wrong chip accepted"); }, e => assert(/doesn't match/.test(e.message), e.message));

  // Through the StLink packet layer, with the probe that board uses
  const sim2 = new SimTarget(family);
  const dev = new FakeStLinkDevice(sim2, BOARDS[board].probe === "dongle");
  const st = new StLink(dev);
  const v = await st.open();
  assert(v.stlink === 2 && v.jtag === dev.jtag, "version decode " + JSON.stringify(v));
  await st.leaveCurrentMode();
  assert(Math.abs(await st.voltage() - 3.3) < 0.01, "voltage decode");
  await st.setFastSwd();
  await st.enterSwd();
  assert(await st.idcode() === 0x2BA01477, "idcode");
  const f2 = new Flasher(st, noSleep);
  await f2.inspect(family);
  await f2.loadLoader();
  await f2.program(plan);
  await f2.resetRun();
  checkImage(sim2, blocks);
  assert(dev.queue.length === 0, "unread replies left");
  assert(sim2.released, "board not released to run");
  console.log(`StLink ${st.model.name} path OK: ${dev.stats.cmds} USB commands, ${(dev.stats.bytesOut / 1024).toFixed(0)} KB sent`);
}

// Failure paths
{
  const tiny = ":020000040800F2\n:0400000001020304F2\n:00000001FF\n";
  const bad = new SimTarget("F7"); bad.rdp = 0xBB;
  await new Flasher(bad, noSleep).inspect("F7").then(() => { throw new Error("RDP not detected"); }, e => assert(/read-out/.test(e.message), e.message));
  const wp = new SimTarget("F7"); wp.wrp = 0xFE;
  const fw = new Flasher(wp, noSleep); await fw.inspect("F7"); await fw.loadLoader();
  await fw.program(makePlan(parseHex(tiny), "F7")).then(() => { throw new Error("F7 WRP not detected"); }, e => assert(/write-protected/.test(e.message), e.message));
  const wp4 = new SimTarget("L4"); wp4.l4wrp = 0x00030000; // pages 0..3 protected
  const f4 = new Flasher(wp4, noSleep); await f4.inspect("L4"); await f4.loadLoader();
  await f4.program(makePlan(parseHex(tiny), "L4")).then(() => { throw new Error("L4 WRP not detected"); }, e => assert(/write-protected/.test(e.message), e.message));
  // Display file planned for an L4 board is refused up front
  let refused = false;
  try { makePlan(parseHex(":0200000490006A\n:0400000001020304F2\n:00000001FF\n"), "L4"); } catch (e) { refused = /display/.test(e.message); }
  assert(refused, "QSPI data accepted for L4");
  for (const t of [":10000000", ":020000040800F2\n:0400000001020304F2\n"]) {
    try { parseHex(t); throw new Error("bad hex accepted"); } catch (e) { assert(!/accepted/.test(e.message), e.message); }
  }
  assert(boardFromFileName("scgp_dom_power_board_6_0_0_manual.hex") === "power" && boardFromFileName("fw.hex") === null, "board from name");
  console.log("\nfailure-path checks OK (RDP, F7/L4 write protection, wrong chip, wrong file, bad hex)");
}
