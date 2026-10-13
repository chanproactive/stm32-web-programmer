# STM32 Web Programmer

Browser-based tools for programming DOM boards from Microsoft Edge or Google Chrome, with nothing to install.

Live page: https://chanproactive.github.io/stm32-web-programmer/

## Status

- **Step 1 (this page): Board check.** Read-only. Confirms the laptop's browser can reach the board over USB, identifies the probe and MCU, and produces a report to send back.
- Step 2: Internal flash programming for the display board (STM32F746).
- Step 3: QSPI programming for the display board's GUI assets.

## Notes

- Requires a secure origin (HTTPS, e.g. GitHub Pages) and a Chromium browser on desktop.
- Firmware files are never stored in this repository. Technicians pick the `.hex` file from their own computer.
- On Windows, ST-LINK/V2 and V2-1 probes need ST's USB driver before the browser can use them; STLINK-V3 probes do not.
