// Programs the display board through an ST-LINK (or any probe with the same
// readMem32 / writeMem32 / readDebug32 / writeDebug32 methods), using the RAM
// loader in loader/loader.c.

import { LOADER } from "./loader-blob.js";
import { crc32 } from "./hex.js";

// Cortex-M debug registers
const DHCSR = 0xE000EDF0, DCRSR = 0xE000EDF4, DCRDR = 0xE000EDF8, DEMCR = 0xE000EDFC, AIRCR = 0xE000ED0C;
const DBG_KEY = 0xA05F0000;
const S_REGRDY = 1 << 16, S_HALT = 1 << 17, S_LOCKUP = 1 << 19, S_RESET_ST = 1 << 25;
// DEMCR: TRCENA, halt on every fault, halt on reset
const DEMCR_HALT_ON_RESET = (1 << 24) | 0x7F0 | 1;
const DEMCR_FAULTS = (1 << 24) | 0x7F0;

// STM32F7
const DBGMCU_IDCODE = 0xE0042000, DBGMCU_CR = 0xE0042004, DBGMCU_APB1_FZ = 0xE0042008;
const FLASH_SIZE = 0x1FF0F440, FLASH_OPTCR = 0x40023C14;
const DEV_F74X = 0x449;

// RAM layout (SRAM1). Must match tools/test_loader_emu.py.
const CODE_ADDR = 0x20010000, TABLE_ADDR = 0x20011000, STACK_TOP = 0x20014000;
const BUF_ADDR = 0x20014000, BUF_SIZE = 0x8000;

const CMD = { FLASH_ERASE: 1, FLASH_WRITE: 2, FLASH_LOCK: 3, QSPI_INIT: 4, QSPI_ERASE: 5, QSPI_WRITE: 6, QSPI_MMAP: 7, CRC32: 8 };
const QSPI_IDS = { 0x20BA18: "Micron N25Q128A / MT25QL128 (16 MB)" };

const hex = (n, w = 8) => "0x" + (n >>> 0).toString(16).toUpperCase().padStart(w, "0");
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const isBlank = (d) => { for (let i = 0; i < d.length; i++) if (d[i] !== 0xFF) return false; return true; };

export class FlashError extends Error {}

function loaderError(code, what) {
  if (code === 0x80000001) return `${what}: timed out`;
  if ((code & 0xFF000000) === 0x81000000) {
    const f = [];
    if (code & 0x10) f.push("write-protected");
    if (code & 0x20) f.push("alignment");
    if (code & 0x40) f.push("parallelism");
    if (code & 0x80) f.push("sequence");
    if (code & 0x02) f.push("operation");
    return `${what}: flash error (${f.join(", ") || hex(code)})`;
  }
  if ((code & 0xFF000000) === 0x83000000) return `${what}: QSPI chip is write-protected (status ${hex(code & 0xFF, 2)})`;
  return `${what}: loader error ${hex(code)}`;
}

export class Flasher {
  constructor(probe, { log = () => {}, sleepFn = sleep } = {}) {
    this.p = probe;
    this.log = log;
    this.sleep = sleepFn;
  }

  // ---- core control ----

  async halted() { return (await this.p.readDebug32(DHCSR) & S_HALT) !== 0; }

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
    const regs = [cmd, a, b, c];
    for (let i = 0; i < 4; i++) await this.writeReg(i, regs[i]);
    await this.writeReg(13, STACK_TOP);
    await this.writeReg(14, (CODE_ADDR + LOADER.done) | 1);
    await this.writeReg(15, CODE_ADDR + LOADER.entry);
    await this.writeReg(16, 0x01000000); // xPSR: Thumb
    await this.run(ms, what);
    const pc = await this.readReg(15);
    if (pc !== CODE_ADDR + LOADER.done) throw new FlashError(`${what}: loader stopped at ${hex(pc)} (fault)`);
    return (await this.readReg(0)) >>> 0;
  }

  async check(cmd, a, b, c, ms, what) {
    const r = await this.call(cmd, a, b, c, ms, what);
    if (r !== 0) throw new FlashError(loaderError(r, what));
  }

  // ---- steps ----

  // Probe must already be in SWD mode. Returns facts about the chip and
  // throws if it is not something we can safely program.
  async inspect() {
    await this.resetHalt();
    await this.p.writeDebug32(DBGMCU_CR, 0x7);            // keep debug alive in low-power modes
    await this.p.writeDebug32(DBGMCU_APB1_FZ, 0x1800);    // freeze watchdogs while halted
    const id = await this.p.readDebug32(DBGMCU_IDCODE);
    const devId = id & 0xFFF, rev = id >>> 16;
    const info = { devId, rev };
    if (devId !== DEV_F74X) {
      throw new FlashError(`This chip is not an STM32F746 (device ID ${hex(devId, 3)}). Is the right board connected?`);
    }
    info.flashKB = (await this.p.readDebug32(FLASH_SIZE)) >>> 16;
    const opt = await this.p.readDebug32(FLASH_OPTCR);
    info.rdp = (opt >>> 8) & 0xFF;
    info.nwrp = (opt >>> 16) & 0xFF;
    if (info.rdp !== 0xAA) {
      throw new FlashError("The chip has read-out protection on. It must be unlocked with STM32CubeProgrammer first (this erases it).");
    }
    return info;
  }

  async loadLoader() {
    const code = Uint8Array.from(atob(LOADER.code), ch => ch.charCodeAt(0));
    await this.p.writeMem32(CODE_ADDR, code);
    const back = await this.p.readMem32(CODE_ADDR, code.length);
    if (crc32(back) !== crc32(code)) throw new FlashError("Could not load the flashing helper into the chip's RAM (read-back mismatch).");
  }

  // plan: from makePlan(). onProgress(fraction, label)
  async program(plan, info, onProgress = () => {}) {
    const { sectors, qsectors } = plan;
    for (const s of sectors) {
      if (!(info.nwrp & (1 << s.n))) throw new FlashError(`Internal flash sector ${s.n} is write-protected. Remove protection with STM32CubeProgrammer.`);
      if (s.base + s.size > 0x08000000 + info.flashKB * 1024) throw new FlashError(`This chip has only ${info.flashKB} KB of flash; the file needs more.`);
    }

    // Progress weights (rough seconds per unit)
    const chunksOf = (list) => list.reduce((t, s) => t + Math.ceil(s.size / BUF_SIZE), 0);
    const total = sectors.length * 1.5 + chunksOf(sectors) * 0.5 + qsectors.length * 1.0 + chunksOf(qsectors) * 0.6 + 2;
    let done = 0;
    const step = (w, label) => { done += w; onProgress(Math.min(1, done / total), label); };

    // Internal flash
    for (const s of sectors) {
      this.log(`Erasing internal sector ${s.n} (${s.size / 1024} KB at ${hex(s.base)})`);
      onProgress(done / total, `Erasing internal flash sector ${s.n}…`);
      await this.check(CMD.FLASH_ERASE, s.n, 0, 0, 30000, `erase sector ${s.n}`);
      step(1.5, `Erased sector ${s.n}`);
      for (let off = 0; off < s.size; off += BUF_SIZE) {
        const part = s.data.subarray(off, off + BUF_SIZE);
        if (!isBlank(part)) {
          await this.p.writeMem32(BUF_ADDR, part);
          await this.check(CMD.FLASH_WRITE, s.base + off, BUF_ADDR, part.length, 30000, `write ${hex(s.base + off)}`);
        }
        step(0.5, `Writing internal flash ${hex(s.base + off)}`);
      }
      const want = crc32(s.data);
      const got = await this.call(CMD.CRC32, s.base, s.size, TABLE_ADDR, 30000, "verify");
      if (got !== want) throw new FlashError(`Verify failed in internal sector ${s.n} (CRC ${hex(got)}, expected ${hex(want)})`);
      this.log(`  sector ${s.n} verified (CRC ${hex(want)})`);
    }
    await this.check(CMD.FLASH_LOCK, 0, 0, 0, 5000, "lock flash");

    // QSPI
    if (qsectors.length) {
      onProgress(done / total, "Starting QSPI flash…");
      const id = await this.call(CMD.QSPI_INIT, 0, 0, 0, 10000, "QSPI init");
      if (id & 0x80000000) throw new FlashError(loaderError(id, "QSPI init"));
      this.log(`QSPI chip ID ${hex(id, 6)} — ${QSPI_IDS[id] || "unknown"}`);
      if ((id >>> 16) !== 0x20) throw new FlashError(`QSPI chip not recognised (ID ${hex(id, 6)}). Check the board.`);
      const capacity = 1 << (id & 0xFF);
      for (const s of qsectors) if (s.offset + s.size > capacity) throw new FlashError("The file is larger than the QSPI chip.");

      for (const s of qsectors) {
        onProgress(done / total, `Erasing QSPI ${hex(s.base)}…`);
        await this.check(CMD.QSPI_ERASE, s.offset, 0, 0, 30000, `erase QSPI ${hex(s.base)}`);
        step(1.0, `Erased QSPI ${hex(s.base)}`);
        for (let off = 0; off < s.size; off += BUF_SIZE) {
          const part = s.data.subarray(off, off + BUF_SIZE);
          if (!isBlank(part)) {
            await this.p.writeMem32(BUF_ADDR, part);
            await this.check(CMD.QSPI_WRITE, s.offset + off, BUF_ADDR, part.length, 30000, `write QSPI ${hex(s.base + off)}`);
          }
          step(0.6, `Writing QSPI ${hex(s.base + off)}`);
        }
      }
      this.log(`QSPI: ${qsectors.length} sectors written`);
      onProgress(done / total, "Verifying QSPI…");
      await this.check(CMD.QSPI_MMAP, 0, 0, 0, 5000, "QSPI read mode");
      for (const s of qsectors) {
        const want = crc32(s.data);
        const got = await this.call(CMD.CRC32, s.base, s.size, TABLE_ADDR, 30000, "verify QSPI");
        if (got !== want) throw new FlashError(`Verify failed in QSPI at ${hex(s.base)} (CRC ${hex(got)}, expected ${hex(want)})`);
      }
      this.log("QSPI verified");
    }
    step(2, "Done");
  }

  // Let the new firmware run.
  async resetRun() {
    await this.p.writeDebug32(DEMCR, 0);
    await this.p.writeDebug32(DHCSR, DBG_KEY); // debug off
    try { await this.p.writeDebug32(AIRCR, 0x05FA0004); } catch { /* link drops during reset */ }
  }
}
