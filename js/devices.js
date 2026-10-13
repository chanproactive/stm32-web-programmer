// Boards, chips and memory layouts this flasher knows about.

export const FLASH_BASE = 0x08000000;
export const QSPI = { base: 0x90000000, size: 0x1000000, sector: 0x10000 };

// STM32F74x/F75x (RM0385): 4 x 32 KB, 1 x 128 KB, 3 x 256 KB
export const F7_SECTORS = [
  ...[0, 1, 2, 3].map(i => ({ n: i, base: 0x08000000 + i * 0x8000, size: 0x8000 })),
  { n: 4, base: 0x08020000, size: 0x20000 },
  ...[0, 1, 2].map(i => ({ n: 5 + i, base: 0x08040000 + i * 0x40000, size: 0x40000 })),
];

// Per family: where the loader lives in RAM, and how big a staging buffer fits.
// The L4 layout fits the smallest L4 (L41x, 32 KB SRAM1).
export const FAMILIES = {
  F7: {
    name: "STM32F7", maxFlash: 0x100000, qspi: true,
    ram: { code: 0x20010000, table: 0x20011000, stack: 0x20014000, buf: 0x20014000, bufSize: 0x8000 },
  },
  L4: {
    name: "STM32L4", maxFlash: 0x100000, qspi: false, pageSize: 2048,
    ram: { code: 0x20000000, table: 0x20001000, stack: 0x20002000, buf: 0x20002000, bufSize: 0x4000 },
  },
};

// DBGMCU_IDCODE device IDs
export const CHIPS = {
  0x449: { family: "F7", name: "STM32F74x/F75x" },
  0x435: { family: "L4", name: "STM32L43x/L44x" },
  0x462: { family: "L4", name: "STM32L45x/L46x" },
  0x464: { family: "L4", name: "STM32L41x/L42x" },
  0x415: { family: "L4", name: "STM32L47x/L48x", dualBank: true },
  0x461: { family: "L4", name: "STM32L49x/L4Ax", dualBank: true },
};

export const BOARDS = {
  display: {
    label: "Display board", th: "บอร์ดจอ", family: "F7", keyword: /display/i,
    probe: "builtin",
    // Display firmware always carries its screen graphics; a file without
    // them is power/sensor firmware and must not go onto the display.
    needsQspi: true,
  },
  power: {
    label: "Power board", th: "บอร์ดพาวเวอร์", family: "L4", keyword: /power/i,
    probe: "dongle",
  },
  sensor: {
    label: "Sensor board", th: "บอร์ดเซนเซอร์", family: "L4", keyword: /sensor/i,
    probe: "dongle",
  },
};

// Which board a file name says it is for (null if it doesn't say, or says several).
export function boardFromFileName(name) {
  const hits = Object.entries(BOARDS).filter(([, b]) => b.keyword.test(name)).map(([k]) => k);
  return hits.length === 1 ? hits[0] : null;
}
