// Programs a DOM board through an ST-LINK (or any probe with the same
// readMem32 / writeMem32 / readDebug32 / writeDebug32 methods), using the RAM
// loader in loader/loader.c.

import { LOADER } from "./loader-blob.js";
import { crc32 } from "./hex.js";
import { CHIPS, FAMILIES, FLASH_BASE } from "./devices.js";

// Cortex-M debug registers
const DHCSR = 0xE000EDF0, DCRSR = 0xE000EDF4, DCRDR = 0xE000EDF8, DEMCR = 0xE000EDFC, AIRCR = 0xE000ED0C;
const DBG_KEY = 0xA05F0000;
const S_REGRDY = 1 << 16, S_HALT = 1 << 17, S_LOCKUP = 1 << 19;
// DEMCR: TRCENA, halt on every fault, halt on reset
const DEMCR_HALT_ON_RESET = (1 << 24) | 0x7F0 | 1;
const DEMCR_FAULTS = (1 << 24) | 0x7F0;

// Same addresses on STM32F7 and STM32L4
const DBGMCU_IDCODE = 0xE0042000, DBGMCU_CR = 0xE0042004, DBGMCU_APB1_FZ = 0xE0042008;

const CMD = {
  FLASH_ERASE: 1, FLASH_WRITE: 2, FLASH_LOCK: 3, QSPI_INIT: 4, QSPI_ERASE: 5, QSPI_WRITE: 6, QSPI_MMAP: 7, CRC32: 8,
  L4_ERASE: 9, L4_WRITE: 10, L4_LOCK: 11,
};
const QSPI_IDS = { 0x20BA18: "Micron N25Q128A / MT25QL128 (16 MB)" };

const hex = (n, w = 8) => "0x" + (n >>> 0).toString(16).toUpperCase().padStart(w, "0");
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const isBlank = (d) => { for (let i = 0; i < d.length; i++) if (d[i] !== 0xFF) return false; return true; };

export class FlashError extends Error {}

function loaderError(code, what) {
  if (code === 0x80000001) return `${what}: timed out`;
  const kind = code & 0xFF000000;
  if (kind === 0x81000000 || kind === 0x84000000) {
    // F7 and L4 share these bit positions; L4 adds the others
    const names = kind === 0x81000000
      ? { 0x02: "operation", 0x10: "write-protected", 0x20: "alignment", 0x40: "parallelism", 0x80: "sequence" }
      : { 0x02: "operation", 0x08: "programming", 0x10: "write-protected", 0x20: "alignment", 0x40: "size",
          0x80: "sequence", 0x100: "missed data", 0x200: "fast programming", 0x4000: "PCROP read", 0x8000: "option validity" };
    const f = Object.entries(names).filter(([b]) => code & b).map(([, n]) => n);
    return `${what}: flash error (${f.join(", ") || hex(code)})`;
  }
  if (kind === 0x83000000) return `${what}: QSPI chip is write-protected (status ${hex(code & 0xFF, 2)})`;
  return `${what}: loader error ${hex(code)}`;
}

export class Flasher {
  constructor(probe, { log = () => {}, sleepFn = sleep } = {}) {
    this.p = probe;
    this.log = log;
    this.sleep = sleepFn;
  }

  // ---- core control ----

  async waitHalt(ms, what) {
    const t0 = Date.now();
    for (;;) {
      let s;
      try { s = await this.p.readDebug32(DHCSR); } catch (e) { s = 0; if (Date.now() - t0 > ms) throw e; }
      if (s & S_HALT) return s;
      if (s & S_LOCKUP) throw new FlashError(`${what}: the chip crashed (lockup)`);
      if (Date.now() - t0 > ms) throw new FlashError(`${what}: timed out after ${Math.round(ms / 1000)} s`);
      await this.sleep(2);
    }
  }

  async writeReg(n, v) {
    await this.p.writeDebug32(DCRDR, v >>> 0);
    await this.p.writeDebug32(DCRSR, (1 << 16) | n);
    for (let i = 0; i < 50; i++) if (await this.p.readDebug32(DHCSR) & S_REGRDY) return;
    throw new FlashError(`could not write core register ${n}`);
  }

  async readReg(n) {
    await this.p.writeDebug32(DCRSR, n);
    for (let i = 0; i < 50; i++) if (await this.p.readDebug32(DHCSR) & S_REGRDY) return this.p.readDebug32(DCRDR);
    throw new FlashError(`could not read core register ${n}`);
  }

  // Reset the chip and stop it before it runs any of the old firmware.
  async resetHalt() {
    await this.p.writeDebug32(DHCSR, DBG_KEY | 3);
    await this.p.writeDebug32(DEMCR, DEMCR_HALT_ON_RESET);
    await this.p.readDebug32(DHCSR); // clears sticky S_RESET_ST
    try { await this.p.writeDebug32(AIRCR, 0x05FA0004); } catch { /* link can drop during reset */ }
    await this.sleep(20);
    const s = await this.waitHalt(2000, "reset");
    await this.p.writeDebug32(DEMCR, DEMCR_FAULTS);
    return s;
  }

  async run(ms, what) {
    // MASKINTS may only change while halted, so set it first, then release.
    await this.p.writeDebug32(DHCSR, DBG_KEY | 0xB);
    await this.p.writeDebug32(DHCSR, DBG_KEY | 0x9);
    await this.waitHalt(ms, what);
  }

  async call(cmd, a = 0, b = 0, c = 0, ms = 30000, what = "loader") {
    const ram = this.ram;
    const regs = [cmd, a, b, c];
    for (let i = 0; i < 4; i++) await this.writeReg(i, regs[i]);
    await this.writeReg(13, ram.stack);
    await this.writeReg(14, (ram.code + LOADER.done) | 1);
    await this.writeReg(15, ram.code + LOADER.entry);
    await this.writeReg(16, 0x01000000); // xPSR: Thumb
    await this.run(ms, what);
    const pc = await this.readReg(15);
    if (pc !== ram.code + LOADER.done) throw new FlashError(`${what}: loader stopped at ${hex(pc)} (fault)`);
    return (await this.readReg(0)) >>> 0;
  }

  async check(cmd, a, b, c, ms, what) {
    const r = await this.call(cmd, a, b, c, ms, what);
    if (r !== 0) throw new FlashError(loaderError(r, what));
  }

  // ---- steps ----

  // Probe must already be in SWD mode. family: what the chosen board needs.
  // Returns facts about the chip; throws if it is not something we can
  // safely program.
  async inspect(family) {
    await this.resetHalt();
    await this.p.writeDebug32(DBGMCU_CR, 0x7);            // keep debug alive in low-power modes
    await this.p.writeDebug32(DBGMCU_APB1_FZ, 0x1800);    // freeze watchdogs while halted
    const id = await this.p.readDebug32(DBGMCU_IDCODE);
    const devId = id & 0xFFF, rev = id >>> 16;
    const chip = CHIPS[devId];
    if (!chip) throw new FlashError(`Unsupported chip (device ID ${hex(devId, 3)}). Is the right board connected?`);
    if (chip.family !== family) {
      throw new FlashError(`The connected chip is an ${chip.name}, which doesn't match the firmware file. ` +
        (chip.family === "F7" ? "This looks like a display board." : "This looks like a power or sensor board, not the display board."));
    }
    const info = { devId, rev, chip, family };
    if (family === "F7") {
      info.flashKB = (await this.p.readDebug32(0x1FF0F440)) >>> 16;
      const opt = await this.p.readDebug32(0x40023C14); // FLASH_OPTCR
      info.rdp = (opt >>> 8) & 0xFF;
      info.nwrp = (opt >>> 16) & 0xFF;
    } else {
      info.flashKB = (await this.p.readDebug32(0x1FFF75E0)) & 0xFFFF;
      const optr = await this.p.readDebug32(0x40022020); // FLASH_OPTR
      info.rdp = optr & 0xFF;
      const ps = FAMILIES.L4.pageSize;
      info.pagesPerBank = chip.dualBank ? (info.flashKB * 1024) / 2 / ps : 0;
      // Write-protected page ranges, as global page numbers
      info.wrp = [];
      const areas = [[0x4002202C, 0], [0x40022030, 0]];
      if (chip.dualBank) areas.push([0x4002204C, info.pagesPerBank], [0x40022050, info.pagesPerBank]);
      for (const [reg, off] of areas) {
        const v = await this.p.readDebug32(reg);
        const start = v & 0xFF, end = (v >>> 16) & 0xFF;
        if (start <= end) info.wrp.push([start + off, end + off]);
      }
    }
    if (info.rdp !== 0xAA) {
      throw new FlashError("The chip has read-out protection on. It must be unlocked with STM32CubeProgrammer first (this erases it).");
    }
    this.info = info;
    this.ram = FAMILIES[family].ram;
    return info;
  }

  async loadLoader() {
    const code = Uint8Array.from(atob(LOADER.code), ch => ch.charCodeAt(0));
    await this.p.writeMem32(this.ram.code, code);
    const back = await this.p.readMem32(this.ram.code, code.length);
    if (crc32(back) !== crc32(code)) throw new FlashError("Could not load the flashing helper into the chip's RAM (read-back mismatch).");
  }

  // plan: from makePlan(). onProgress(fraction, label)
  async program(plan, onProgress = () => {}) {
    const info = this.info, ram = this.ram;
    const { units, qunits } = plan;
    if (plan.family !== info.family) throw new FlashError("Plan and chip family differ");
    const flashEnd = FLASH_BASE + info.flashKB * 1024;
    const isF7 = info.family === "F7";

    for (const u of units) {
      if (u.base + u.size > flashEnd) throw new FlashError(`This chip has only ${info.flashKB} KB of flash; the file needs more.`);
      if (isF7 && !(info.nwrp & (1 << u.n))) {
        throw new FlashError(`Flash sector ${u.n} is write-protected. Remove protection with STM32CubeProgrammer.`);
      }
      if (!isF7 && info.wrp.some(([a, b]) => u.n <= b && u.n + u.count - 1 >= a)) {
        throw new FlashError(`Flash pages ${u.n}-${u.n + u.count - 1} are write-protected. Remove protection with STM32CubeProgrammer.`);
      }
    }

    const unitName = (u) => isF7 ? `sector ${u.n}` : (u.count > 1 ? `pages ${u.n}-${u.n + u.count - 1}` : `page ${u.n}`);
    const eraseUnit = (u) => isF7
      ? this.check(CMD.FLASH_ERASE, u.n, 0, 0, 30000, `erase ${unitName(u)}`)
      : this.check(CMD.L4_ERASE, u.n, u.count, info.pagesPerBank, 30000, `erase ${unitName(u)}`);
    const writeCmd = isF7 ? CMD.FLASH_WRITE : CMD.L4_WRITE;

    // Progress weights ~ seconds: erase time + USB transfer at ~150 KB/s
    const eraseW = (u) => isF7 ? u.size / 131072 : u.count * 0.025;
    const xferW = (u) => u.size / 150000;
    const total = units.reduce((t, u) => t + eraseW(u) + xferW(u), 0)
      + qunits.reduce((t, u) => t + 0.7 + xferW(u) + 0.15, 0) + 0.5;
    let done = 0;
    const step = (w, label) => { done += w; onProgress(Math.min(1, done / total), label); };

    // Internal flash
    for (const u of units) {
      this.log(`Erasing ${unitName(u)} (${u.size / 1024} KB at ${hex(u.base)})`);
      onProgress(done / total, `Erasing flash ${unitName(u)}…`);
      await eraseUnit(u);
      step(eraseW(u), `Erased ${unitName(u)}`);
      for (let off = 0; off < u.size; off += ram.bufSize) {
        const part = u.data.subarray(off, off + ram.bufSize);
        if (!isBlank(part)) {
          await this.p.writeMem32(ram.buf, part);
          await this.check(writeCmd, u.base + off, ram.buf, part.length, 30000, `write ${hex(u.base + off)}`);
        }
        step(xferW(u) * part.length / u.size, `Writing flash ${hex(u.base + off)}`);
      }
      const want = crc32(u.data);
      const got = await this.call(CMD.CRC32, u.base, u.size, ram.table, 30000, "verify");
      if (got !== want) throw new FlashError(`Verify failed in ${unitName(u)} (CRC ${hex(got)}, expected ${hex(want)})`);
      this.log(`  ${unitName(u)} verified (CRC ${hex(want)})`);
    }
    await this.check(isF7 ? CMD.FLASH_LOCK : CMD.L4_LOCK, 0, 0, 0, 5000, "lock flash");

    // QSPI (display board)
    if (qunits.length) {
      onProgress(done / total, "Starting QSPI flash…");
      const id = await this.call(CMD.QSPI_INIT, 0, 0, 0, 10000, "QSPI init");
      if (id & 0x80000000) throw new FlashError(loaderError(id, "QSPI init"));
      this.log(`QSPI chip ID ${hex(id, 6)} — ${QSPI_IDS[id] || "unknown"}`);
      if ((id >>> 16) !== 0x20) throw new FlashError(`QSPI chip not recognised (ID ${hex(id, 6)}). Check the board.`);
      const capacity = 1 << (id & 0xFF);
      for (const s of qunits) if (s.offset + s.size > capacity) throw new FlashError("The file is larger than the QSPI chip.");

      for (const s of qunits) {
        onProgress(done / total, `Erasing QSPI ${hex(s.base)}…`);
        await this.check(CMD.QSPI_ERASE, s.offset, 0, 0, 30000, `erase QSPI ${hex(s.base)}`);
        step(0.7, `Erased QSPI ${hex(s.base)}`);
        for (let off = 0; off < s.size; off += ram.bufSize) {
          const part = s.data.subarray(off, off + ram.bufSize);
          if (!isBlank(part)) {
            await this.p.writeMem32(ram.buf, part);
            await this.check(CMD.QSPI_WRITE, s.offset + off, ram.buf, part.length, 30000, `write QSPI ${hex(s.base + off)}`);
          }
          step(xferW(s) * part.length / s.size, `Writing QSPI ${hex(s.base + off)}`);
        }
      }
      this.log(`QSPI: ${qunits.length} sectors written`);
      await this.check(CMD.QSPI_MMAP, 0, 0, 0, 5000, "QSPI read mode");
      for (const s of qunits) {
        const want = crc32(s.data);
        const got = await this.call(CMD.CRC32, s.base, s.size, ram.table, 30000, "verify QSPI");
        if (got !== want) throw new FlashError(`Verify failed in QSPI at ${hex(s.base)} (CRC ${hex(got)}, expected ${hex(want)})`);
        step(0.15, "Verifying QSPI");
      }
      this.log("QSPI verified");
    }
    step(0.5, "Done");
  }

  // Let the new firmware run.
  async resetRun() {
    await this.p.writeDebug32(DEMCR, 0);
    await this.p.writeDebug32(DHCSR, DBG_KEY); // debug off
    try { await this.p.writeDebug32(AIRCR, 0x05FA0004); } catch { /* link drops during reset */ }
  }
}
