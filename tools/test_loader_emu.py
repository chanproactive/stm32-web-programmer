#!/usr/bin/env python3
"""Run the flash loader in a Cortex-M emulator against simple models of the
STM32F7 flash controller + QUADSPI + N25Q128A (display board) and the
STM32L4 flash controller (power and sensor boards).

Needs `pip install unicorn`.
Usage: test_loader_emu.py display.hex [qspi_kb]   (F7 path)
       test_loader_emu.py --l4 power.hex          (L4 path)
qspi_kb limits how much of the QSPI image is exercised (default 256) to keep
the run short; internal flash is always programmed in full.
"""
import base64, pathlib, re, sys, zlib
from unicorn import Uc, UC_ARCH_ARM, UC_MODE_THUMB, UC_MODE_MCLASS
from unicorn.arm_const import *

ROOT = pathlib.Path(__file__).resolve().parent.parent
blob = (ROOT / "js" / "loader-blob.js").read_text()
CODE = base64.b64decode(re.search(r'code: "([^"]+)"', blob).group(1))
ENTRY = int(re.search(r"entry: (0x[0-9a-f]+)", blob).group(1), 16)
DONE = int(re.search(r"done: (0x[0-9a-f]+)", blob).group(1), 16)

# Same RAM layout the page uses (js/flasher.js)
CODE_ADDR, TABLE_ADDR, STACK_TOP, BUF_ADDR = 0x20010000, 0x20011000, 0x20014000, 0x20014000
SECTORS = [(0x08000000 + i * 0x8000, 0x8000) for i in range(4)] + [(0x08020000, 0x20000)] + \
          [(0x08040000 + i * 0x40000, 0x40000) for i in range(3)]


class Flash:
    def __init__(s):
        s.mem = bytearray(b"\xA5" * 0x100000)  # stale contents
        s.cr, s.sr, s.locked, s.keys, s.busy = 0x80000000, 0, True, [], 0

    def read(s, off):
        if off == 0x0C:
            if s.busy:
                s.busy -= 1
            return s.sr | (1 << 16 if s.busy else 0)
        if off == 0x10:
            return s.cr | (0x80000000 if s.locked else 0)
        return 0

    def write(s, off, v):
        if off == 0x04:
            s.keys.append(v)
            if s.keys[-2:] == [0x45670123, 0xCDEF89AB]:
                s.locked = False
        elif off == 0x0C:
            s.sr &= ~v
        elif off == 0x10:
            if v & 0x80000000:
                s.locked = True
            if s.locked:
                return
            s.cr = v & 0x7FFFFFFF
            if v & (1 << 16) and v & 2:
                assert (v >> 8) & 3 == 2, "PSIZE must be x32"
                base, size = SECTORS[(v >> 3) & 0xF]
                s.mem[base - 0x08000000:base - 0x08000000 + size] = b"\xFF" * size
                s.erased.append((v >> 3) & 0xF)
                s.busy = 3

    def program(s, addr, size, v):
        assert s.cr & 1 and not s.locked, "flash write without PG/unlock"
        assert size == 4, "expected 32-bit writes"
        o = addr - 0x08000000
        assert s.mem[o:o + 4] == b"\xFF" * 4, f"programming non-erased word {addr:#x}"
        s.mem[o:o + 4] = v.to_bytes(4, "little")
        s.busy = 2


class Chip:
    """N25Q128A in extended-SPI mode (left in quad mode by the app at start)."""
    def __init__(s):
        s.mem = bytearray(b"\x5A" * 0x1000000)
        s.quad, s.wel, s.wip, s.sr_bp, s.reset_en = True, False, 0, 0x1C, False

    def execute(s, ins, lines, addr, data_in, nread):
        if s.quad and lines != 4 or not s.quad and lines != 1:
            return b"\0" * nread  # wrong protocol: ignored
        if ins == 0x66:
            s.reset_en = True; return b""
        if ins == 0x99 and s.reset_en:
            s.quad = False; s.wel = False; s.reset_en = False; return b""
        s.reset_en = False
        if ins == 0x05:
            st = (1 if s.wip else 0) | (2 if s.wel else 0) | s.sr_bp
            if s.wip:
                s.wip -= 1
            return bytes([st]) * nread
        if ins == 0x9F:
            return bytes([0x20, 0xBA, 0x18])[:nread]
        if ins == 0x06:
            s.wel = True; return b""
        assert not s.wip, f"command {ins:#x} while busy"
        if ins == 0x01:
            assert s.wel; s.sr_bp = data_in[0] & 0x7C; s.wel = False; return b""
        if ins == 0xD8:
            assert s.wel and not s.sr_bp, "erase while protected / no WEL"
            assert addr % 0x10000 == 0
            s.mem[addr:addr + 0x10000] = b"\xFF" * 0x10000; s.wel = False; s.wip = 3; s.erased.append(addr); return b""
        if ins == 0x02:
            assert s.wel and not s.sr_bp and 1 <= len(data_in) <= 256
            assert (addr & 0xFF) + len(data_in) <= 256, "page program crosses page"
            for i, b in enumerate(data_in):
                o = (addr & ~0xFF) | ((addr + i) & 0xFF)
                assert s.mem[o] == 0xFF, f"QSPI programming non-erased byte {o:#x}"
                s.mem[o] = b
            s.wel = False; s.wip = 2; return b""
        raise AssertionError(f"unexpected QSPI command {ins:#x}")


class Qspi:
    def __init__(s, chip):
        s.chip, s.r = chip, {k: 0 for k in range(0, 0x34, 4)}
        s.fifo, s.pending, s.tcf, s.mmap = bytearray(), None, False, False

    def _start(s):
        ccr, dlr = s.r[0x14], s.r[0x10]
        imode, admode, dmode, fmode = (ccr >> 8) & 3, (ccr >> 10) & 3, (ccr >> 24) & 3, (ccr >> 26) & 3
        assert s.r[0] & 1, "QSPI not enabled"
        lines = {1: 1, 2: 2, 3: 4}[imode]
        if fmode == 3:
            assert ccr & 0xFF == 0x03 and dmode == 1 and admode == 1
            s.mmap = True; return
        if fmode == 1:
            s.fifo += s.chip.execute(ccr & 0xFF, lines, s.r[0x18] if admode else None, b"", dlr + 1)
            s.tcf = True
        elif dmode == 0:
            s.chip.execute(ccr & 0xFF, lines, s.r[0x18] if admode else None, b"", 0); s.tcf = True
        else:
            s.pending = (ccr & 0xFF, lines, s.r[0x18] if admode else None, dlr + 1, bytearray())

    def read(s, off, size):
        if off == 0x08:
            busy = s.pending is not None or len(s.fifo) > 0
            ftf = (s.pending is not None) or len(s.fifo) > 0
            return (2 if s.tcf else 0) | (4 if ftf else 0) | (0x20 if busy else 0) | (len(s.fifo) << 8)
        if off == 0x20:
            assert size == 1
            return s.fifo.pop(0)
        return s.r.get(off, 0)

    def write(s, off, v, size):
        if off == 0x20:
            assert size == 1 and s.pending
            p = s.pending; p[4].append(v & 0xFF)
            if len(p[4]) == p[3]:
                s.chip.execute(p[0], p[1], p[2], bytes(p[4]), 0); s.pending = None; s.tcf = True
            return
        if off == 0x0C:
            if v & 2: s.tcf = False
            return
        s.r[off] = v
        if off == 0x14:
            admode, dmode, fmode = (v >> 10) & 3, (v >> 24) & 3, (v >> 26) & 3
            if admode == 0 or fmode == 3:
                s._start()
        elif off == 0x18 and ((s.r[0x14] >> 10) & 3):
            s._start()


def run_test(hexpath, qspi_kb):
    image = {}
    base = 0
    for line in open(hexpath):
        b = bytes.fromhex(line.strip()[1:])
        if b[3] == 4: base = int.from_bytes(b[4:6], "big") << 16
        elif b[3] == 0:
            a = base + (b[1] << 8 | b[2])
            for i, x in enumerate(b[4:4 + b[0]]): image[a + i] = x

    flash, chip = Flash(), Chip()
    flash.erased, chip.erased = [], []
    qspi = Qspi(chip)
    uc = Uc(UC_ARCH_ARM, UC_MODE_THUMB | UC_MODE_MCLASS)
    uc.mem_map(0x20000000, 0x50000)
    uc.mem_map(0x08000000, 0x100000)
    plain = {}
    for base, size in ((0x40020000, 0x2000), (0x40023800, 0x400)):  # GPIO, RCC
        uc.mmio_map(base, size, lambda u, o, sz, d, b=base: plain.get(b + o, 0), None,
                    lambda u, o, sz, v, d, b=base: plain.__setitem__(b + o, v), None)
    uc.mmio_map(0x40023C00, 0x400, lambda u, o, sz, d: flash.read(o), None, lambda u, o, sz, v, d: flash.write(o, v), None)
    uc.mmio_map(0xA0001000, 0x1000, lambda u, o, sz, d: qspi.read(o, sz), None, lambda u, o, sz, v, d: qspi.write(o, v, sz), None)
    from unicorn import UC_HOOK_MEM_WRITE
    uc.hook_add(UC_HOOK_MEM_WRITE, lambda u, acc, addr, sz, v, d: flash.program(addr, sz, v), begin=0x08000000, end=0x080FFFFF)
    uc.mem_write(CODE_ADDR, CODE)

    def call(cmd, a=0, b=0, c=0):
        for r, v in zip((UC_ARM_REG_R0, UC_ARM_REG_R1, UC_ARM_REG_R2, UC_ARM_REG_R3), (cmd, a, b, c)):
            uc.reg_write(r, v)
        uc.reg_write(UC_ARM_REG_SP, STACK_TOP)
        uc.reg_write(UC_ARM_REG_LR, (CODE_ADDR + DONE) | 1)
        uc.emu_start((CODE_ADDR + ENTRY) | 1, CODE_ADDR + DONE, count=400_000_000)
        assert uc.reg_read(UC_ARM_REG_PC) == CODE_ADDR + DONE, "loader did not return"
        return uc.reg_read(UC_ARM_REG_R0)

    # ---- internal flash ----
    lo = {a: v for a, v in image.items() if a < 0x08100000}
    hi = {a - 0x90000000: v for a, v in image.items() if a >= 0x90000000}
    sectors = sorted({i for a in lo for i, (sb, sz) in enumerate(SECTORS) if sb <= a < sb + sz})
    for sn in sectors:
        assert call(1, sn) == 0
    assert flash.erased == sectors, flash.erased
    want = bytearray(flash.mem)
    for sn in sectors:
        sb, sz = SECTORS[sn]; want[sb - 0x08000000:sb - 0x08000000 + sz] = b"\xFF" * sz
    for a, v in lo.items(): want[a - 0x08000000] = v
    CH = 16384
    for sn in sectors:
        sb, sz = SECTORS[sn]
        for off in range(0, sz, CH):
            addrs = range(sb + off, sb + off + CH)
            if not any(x in lo for x in addrs): continue
            data = bytes(want[sb - 0x08000000 + off: sb - 0x08000000 + off + CH])
            uc.mem_write(BUF_ADDR, data)
            assert call(2, sb + off, BUF_ADDR, CH) == 0
    assert call(3) == 0 and flash.locked
    assert flash.mem == want, "internal flash mismatch"
    uc.mem_write(0x08000000, bytes(flash.mem))  # make flash readable for CRC
    for sn in sectors:
        sb, sz = SECTORS[sn]
        got = call(8, sb, sz, TABLE_ADDR)
        assert got == zlib.crc32(want[sb - 0x08000000:sb - 0x08000000 + sz]), f"crc sector {sn}"
    print(f"internal flash OK: sectors {sectors}, {len(lo)} bytes, CRC matches")

    # ---- QSPI ----
    jid = call(4)
    assert jid == 0x20BA18, hex(jid)
    assert not chip.quad and chip.sr_bp == 0
    pins = {(0x40020400, 2): 9, (0x40020400, 6): 10, (0x40020C00, 11): 9, (0x40020C00, 12): 9,
            (0x40021000, 2): 9, (0x40020C00, 13): 9}
    for (port, pin), af in pins.items():
        assert (plain[port] >> (pin * 2)) & 3 == 2, f"pin {port:#x}.{pin} not AF"
        afr = plain[port + (0x20 if pin < 8 else 0x24)]
        assert (afr >> ((pin & 7) * 4)) & 0xF == af
    limit = qspi_kb * 1024
    end = min(max(hi) + 1, limit)
    for sa in range(0, end, 0x10000):
        assert call(5, sa) == 0
    qwant = bytearray(b"\xFF" * ((end + 0xFFFF) & ~0xFFFF))
    for a, v in hi.items():
        if a < len(qwant): qwant[a] = v
    QCH = 32768
    for off in range(0, end, QCH):
        n = min(QCH, end - off)
        # odd chunk boundary to exercise page splitting
        uc.mem_write(BUF_ADDR, bytes(qwant[off:off + n]))
        assert call(6, off, BUF_ADDR, n) == 0
    assert chip.mem[:end] == qwant[:end], "QSPI mismatch"
    assert call(7) == 0 and qspi.mmap
    uc.mem_map(0x90000000, len(qwant)); uc.mem_write(0x90000000, bytes(chip.mem[:len(qwant)]))
    assert call(8, 0x90000000, end, TABLE_ADDR) == zlib.crc32(qwant[:end])
    print(f"QSPI OK: id {jid:#08x}, {len(chip.erased)} sectors erased, {end} bytes programmed, CRC matches")
    # unaligned write that crosses a page
    assert call(5, 0xF00000) == 0
    uc.mem_write(BUF_ADDR, bytes(range(256)) * 2)
    assert call(6, 0xF000F0, BUF_ADDR, 300) == 0
    assert chip.mem[0xF000F0:0xF000F0 + 300] == (bytes(range(256)) * 2)[:300]
    assert call(99) == 0x82000000
    print("page-crossing write and bad-command checks OK")


class L4Flash:
    """STM32L43x: 2 KB pages, double-word programming, single bank."""
    def __init__(s, size=0x40000):
        s.mem = bytearray(b"\xA5" * size)
        s.cr, s.sr, s.locked, s.keys, s.busy, s.half = 0, 0x8000, True, [], 0, None  # OPTVERR set after reset
        s.erased = []

    def read(s, off):
        if off == 0x10:
            if s.busy: s.busy -= 1
            return s.sr | (1 << 16 if s.busy else 0)
        if off == 0x14:
            return s.cr | (0x80000000 if s.locked else 0)
        return 0

    def write(s, off, v):
        if off == 0x08:
            s.keys.append(v)
            if s.keys[-2:] == [0x45670123, 0xCDEF89AB]: s.locked = False
        elif off == 0x10:
            s.sr &= ~v
        elif off == 0x14:
            if v & 0x80000000: s.locked = True
            if s.locked: return
            s.cr = v & 0x7FFFFFFF
            if v & (1 << 16):
                assert v & 2 and not v & 1, "STRT without PER"
                assert not (s.sr & 0xC3FA), "erase started with stale error flags (PGSERR on real chip)"
                pg = (v >> 3) & 0xFF
                s.mem[pg * 2048:(pg + 1) * 2048] = b"\xFF" * 2048
                s.erased.append(pg); s.busy = 3

    def program(s, addr, size, v):
        assert s.cr & 1 and not s.locked, "flash write without PG/unlock"
        assert not (s.sr & 0xC3FA), "program with stale error flags"
        assert size == 4
        o = addr - 0x08000000
        if s.half is None:
            assert o % 8 == 0, "double-word not 8-byte aligned"
            s.half = (o, v)
        else:
            assert o == s.half[0] + 4, "second word not consecutive"
            for oo, vv in (s.half, (o, v)):
                assert s.mem[oo:oo + 4] == b"\xFF" * 4, f"programming non-erased word {oo:#x}"
                s.mem[oo:oo + 4] = vv.to_bytes(4, "little")
            s.half = None; s.busy = 2


def run_l4(hexpath):
    image, base = {}, 0
    for line in open(hexpath):
        b = bytes.fromhex(line.strip()[1:])
        if b[3] == 4: base = int.from_bytes(b[4:6], "big") << 16
        elif b[3] == 0:
            for i, x in enumerate(b[4:4 + b[0]]): image[base + (b[1] << 8 | b[2]) + i] = x
    CODE, TABLE, STACK, BUF = 0x20000000, 0x20001000, 0x20002000, 0x20002000  # js/devices.js L4 layout
    fl = L4Flash()
    uc = Uc(UC_ARCH_ARM, UC_MODE_THUMB | UC_MODE_MCLASS)
    uc.mem_map(0x20000000, 0xC000)  # 48 KB SRAM1
    uc.mem_map(0x08000000, len(fl.mem))
    uc.mmio_map(0x40022000, 0x400, lambda u, o, sz, d: fl.read(o), None, lambda u, o, sz, v, d: fl.write(o, v), None)
    from unicorn import UC_HOOK_MEM_WRITE
    uc.hook_add(UC_HOOK_MEM_WRITE, lambda u, acc, addr, sz, v, d: fl.program(addr, sz, v), begin=0x08000000, end=0x08000000 + len(fl.mem) - 1)
    uc.mem_write(CODE, CODE_BYTES)

    def call(cmd, a=0, b=0, c=0):
        for r, v in zip((UC_ARM_REG_R0, UC_ARM_REG_R1, UC_ARM_REG_R2, UC_ARM_REG_R3), (cmd, a, b, c)): uc.reg_write(r, v)
        uc.reg_write(UC_ARM_REG_SP, STACK); uc.reg_write(UC_ARM_REG_LR, (CODE + DONE) | 1)
        uc.emu_start((CODE + ENTRY) | 1, CODE + DONE, count=100_000_000)
        assert uc.reg_read(UC_ARM_REG_PC) == CODE + DONE
        return uc.reg_read(UC_ARM_REG_R0)

    pages = sorted({(a - 0x08000000) // 2048 for a in image})
    runs = []
    for pg in pages:
        if runs and runs[-1][0] + runs[-1][1] == pg and runs[-1][1] < 8: runs[-1][1] += 1
        else: runs.append([pg, 1])
    want = bytearray(fl.mem)
    for pg in pages: want[pg * 2048:(pg + 1) * 2048] = b"\xFF" * 2048
    for a, v in image.items(): want[a - 0x08000000] = v
    for first, n in runs:
        assert call(9, first, n, 0) == 0
        lo, hi = first * 2048, (first + n) * 2048
        uc.mem_write(BUF, bytes(want[lo:hi]))
        assert call(10, 0x08000000 + lo, BUF, hi - lo) == 0
    assert fl.erased == pages
    assert call(11) == 0 and fl.locked
    assert fl.mem == want, "L4 flash mismatch"
    uc.mem_write(0x08000000, bytes(fl.mem))
    for first, n in runs:
        lo, hi = first * 2048, (first + n) * 2048
        assert call(8, 0x08000000 + lo, hi - lo, TABLE) == zlib.crc32(want[lo:hi])
    untouched = [p for p in range(max(pages)) if p not in pages]
    assert all(fl.mem[p * 2048:(p + 1) * 2048] == b"\xA5" * 2048 for p in untouched)
    print(f"L4 OK: {len(pages)} pages in {len(runs)} runs, {len(image)} bytes, CRC matches, "
          f"pages {untouched[0]}-{untouched[-1]} untouched")
    # bank-2 page number maths: global page 300 with 256 pages/bank -> BKER, PNB 44
    seen = []
    orig = fl.write
    fl.write = lambda off, v: (seen.append(v) if off == 0x14 and v & (1 << 16) else None, orig(off, v))
    call(9, 300, 1, 256)
    assert seen and seen[0] & (1 << 11) and (seen[0] >> 3) & 0xFF == 44, hex(seen[0] if seen else 0)
    print("L4 dual-bank page addressing OK")


CODE_BYTES = CODE

if __name__ == "__main__":
    if sys.argv[1] == "--l4":
        for f in sys.argv[2:]: run_l4(f)
    else:
        run_test(sys.argv[1], int(sys.argv[2]) if len(sys.argv) > 2 else 256)
