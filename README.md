# STM32 Web Programmer

Browser-based flasher for the DOM boards. It runs in Microsoft Edge or Google Chrome, with nothing to install.

| Board | Chip | Connection | Time |
|---|---|---|---|
| Display | STM32F746 (F746G-DISCO) + QSPI flash | Board's built-in ST-LINK/V2-1 (USB port CN14) | ~2 min |
| Power | STM32L43x | ST-LINK V2 programmer dongle on the board's SWD header | ~15 s |
| Sensor | STM32L43x | ST-LINK V2 programmer dongle on the board's SWD header | ~15 s |

Live page: https://chanproactive.github.io/stm32-web-programmer/

- `index.html`: the flasher. The technician picks the `.hex` file and connects the board, and the page shows the steps for that board. The board is taken from the file name (`display`, `power` or `sensor`); if the name doesn't say, the technician has to choose.
- `check.html`: a read-only board check (diagnostics) that reports whether this laptop's browser can reach the board.

## What it does

Display firmware has internal flash data at `0x08000000` (boot stub and application) and screen graphics at `0x90000000` (QSPI flash: N25Q128A, or MT25QL128 on newer boards). Power and sensor firmware has internal flash data only: a boot stub at `0x08000000` and the application at `0x08004000`.

The page talks to the ST-LINK over WebUSB and SWD:

1. It resets and halts the chip, then checks the device ID against the chosen board, along with flash size, read-out protection and write protection.
2. It copies a small flash loader (`loader/loader.c`, about 2 KB) into SRAM.
3. For each erase unit the file touches, the loader erases and programs it, and the page verifies it with a CRC-32. Erase units are F7 sectors, L4 2 KB pages and 64 KB QSPI sectors. Anything the file doesn't touch is left alone: F7 sector 1, and L4 pages 1–7 on the power and sensor boards.
4. It restarts the board.

Safety checks:
- The chip must match the board: F7 for the display board, L4 for power and sensor.
- A display file must contain QSPI data, and a power or sensor file must not.

The page can't tell a power board from a sensor board, because both use the same chip. It relies on the file name or the technician's choice.

Firmware files are never stored in this repository: technicians pick the `.hex` file from their own computer.

## Windows driver requirement

On Windows, **ST-LINK/V2 and V2-1 need ST's USB driver ([STSW-LINK009](https://www.st.com/en/development-tools/stsw-link009.html))** before any browser can use them. This covers both the display board's built-in ST-LINK and the "ST-LINK V2" programmer dongle used for the power and sensor boards. ST lists this driver as mandatory for V2 and V2-1, and Windows Update doesn't install it. Each laptop needs the driver installed once by IT (it needs admin rights). Laptops that already have STM32CubeProgrammer or STM32CubeIDE already have it.

Without the driver, the page shows a "Windows won't let the browser use it" message. The board check page (`check.html`) confirms which case applies.

The driver isn't needed on:
- macOS, Linux and ChromeOS;
- Windows 10/11 with an external **STLINK-V3** probe.

Edge's `DefaultWebUsbGuardSetting` policy, if IT has set it to 2, blocks WebUSB entirely. `WebUsbAllowDevicesForUrls` can pre-allow this site, using vendor ID 1155 and product IDs 14155 (V2-1) and 14152 (V2).

## ST-LINK V2 dongle notes

- Clone "ST-LINK V2" dongles work if their firmware is V2J13 or newer. The SWD speed is raised to 4 MHz only on V2J22 and newer.
- Many dongles don't sense the target voltage, so the voltage shown in the report can be wrong. The page ignores it for the L4 boards.
- If normal connect fails, the page tries connect-under-reset, which needs the dongle's RST pin wired to the board's NRST.

## Development

```sh
python3 tools/build_loader.py                      # rebuild js/loader-blob.js (needs clang only)
node tools/test_flasher.mjs display.hex power.hex sensor.hex   # page logic + ST-LINK protocol against simulated boards
pip install unicorn
python3 tools/test_loader_emu.py display.hex 16384           # real loader in an emulator: F7 + QSPI
python3 tools/test_loader_emu.py --l4 power.hex sensor.hex    # real loader in an emulator: L4
```

The page needs a secure origin (HTTPS, or `localhost` for testing), because WebUSB is disabled elsewhere.
