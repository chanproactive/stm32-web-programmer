# STM32 Web Programmer

Browser-based flasher for the DOM display board (STM32F746G-DISCO). It runs in Microsoft Edge or Google Chrome, with nothing to install.

Live page: https://chanproactive.github.io/stm32-web-programmer/

- `index.html`: the flasher. The technician picks the `.hex` file, plugs in the board's **USB ST-LINK** port (CN14) and clicks **Flash board**.
- `check.html`: a read-only board check (diagnostics) that reports whether this laptop's browser can reach the board.

## What it does

The `.hex` file holds two kinds of data:

| Region | Address | Contents |
|---|---|---|
| Internal flash | `0x08000000` | Boot stub and application |
| QSPI flash (N25Q128A / MT25QL128) | `0x90000000` | Screen graphics |

The page talks to the board's built-in ST-LINK/V2-1 over WebUSB and SWD:

1. It resets and halts the STM32, then checks the device ID, flash size, read-out protection and write protection.
2. It copies a small flash loader (`loader/loader.c`, about 1.8 KB) into SRAM.
3. For each internal flash sector and each 64 KB QSPI sector that the file touches, the loader erases it and programs it, and the page verifies it with a CRC-32. Sectors the file doesn't touch (for example sector 1) are left alone.
4. It restarts the board.

A full flash takes about 2 minutes. Firmware files are never stored in this repository: technicians pick the `.hex` file from their own computer.

## Windows driver requirement

On Windows, the board's built-in **ST-LINK/V2-1 needs ST's USB driver ([STSW-LINK009](https://www.st.com/en/development-tools/stsw-link009.html))** before any browser can use it. ST lists this driver as mandatory for V2 and V2-1, and Windows Update doesn't install it. Each laptop needs the driver installed once by IT (it needs admin rights). Laptops that already have STM32CubeProgrammer or STM32CubeIDE already have it.

Without the driver, the page shows a "Windows won't let the browser use it" message. The board check page (`check.html`) confirms which case applies.

The driver isn't needed on:
- macOS, Linux and ChromeOS;
- Windows 10/11 with an external **STLINK-V3** probe.

Edge's `DefaultWebUsbGuardSetting` policy, if IT has set it to 2, blocks WebUSB entirely. `WebUsbAllowDevicesForUrls` can pre-allow this site, using vendor ID 1155 and product ID 14155.

## Development

```sh
python3 tools/build_loader.py                      # rebuild js/loader-blob.js (needs clang only)
node tools/test_flasher.mjs firmware.hex           # page logic + ST-LINK protocol against a simulated board
pip install unicorn
python3 tools/test_loader_emu.py firmware.hex 16384  # runs the real loader in a Cortex-M7 emulator
```

The page needs a secure origin (HTTPS, or `localhost` for testing), because WebUSB is disabled elsewhere.
