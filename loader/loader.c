/*
 * RAM-resident flash loader for the STM32F746G-DISCO display board.
 *
 * The web page copies this code into SRAM over SWD, then calls
 * loader(cmd, a, b, c) with LR pointing at a BKPT, so every call ends
 * with the core halted and the result in R0. Data to program is copied
 * by the page into a RAM buffer before each call.
 *
 * Runs on the reset clock (HSI 16 MHz), no interrupts, no FPU.
 * Build: tools/build_loader.py (clang, no libc, no relocations).
 */
#include <stdint.h>

#define REG(a) (*(volatile uint32_t *)(a))
#define REG8(a) (*(volatile uint8_t *)(a))

/* ---- Internal flash (RM0385 ch.3) ---- */
#define FLASH_KEYR REG(0x40023C04)
#define FLASH_SR REG(0x40023C0C)
#define FLASH_CR REG(0x40023C10)
#define SR_BSY (1u << 16)
#define SR_ERRS 0xF2u /* OPERR WRPERR PGAERR PGPERR ERSERR */
#define CR_PG (1u << 0)
#define CR_SER (1u << 1)
#define CR_PSIZE_X32 (2u << 8)
#define CR_STRT (1u << 16)
#define CR_LOCK (1u << 31)

/* ---- RCC / GPIO ---- */
#define RCC_AHB1ENR REG(0x40023830)
#define RCC_AHB3ENR REG(0x40023838)
#define GPIOB 0x40020400u
#define GPIOD 0x40020C00u
#define GPIOE 0x40021000u

/* ---- QUADSPI (RM0385 ch.13) ---- */
#define QSPI_CR REG(0xA0001000)
#define QSPI_DCR REG(0xA0001004)
#define QSPI_SR REG(0xA0001008)
#define QSPI_FCR REG(0xA000100C)
#define QSPI_DLR REG(0xA0001010)
#define QSPI_CCR REG(0xA0001014)
#define QSPI_AR REG(0xA0001018)
#define QSPI_DR 0xA0001020u
#define QSR_TCF (1u << 1)
#define QSR_FTF (1u << 2)
#define QSR_BUSY (1u << 5)
#define QCR_EN (1u << 0)
#define QCR_ABORT (1u << 1)

/* CCR fields */
#define IMODE(n) ((uint32_t)(n) << 8)
#define ADMODE(n) ((uint32_t)(n) << 10)
#define ADSIZE24 (2u << 12)
#define DCYC(n) ((uint32_t)(n) << 18)
#define DMODE(n) ((uint32_t)(n) << 24)
#define FMODE_WRITE (0u << 26)
#define FMODE_READ (1u << 26)
#define FMODE_MMAP (3u << 26)

/* N25Q128A commands */
#define CMD_RESET_EN 0x66
#define CMD_RESET 0x99
#define CMD_RDID 0x9F
#define CMD_RDSR 0x05
#define CMD_WRSR 0x01
#define CMD_WREN 0x06
#define CMD_SE64K 0xD8
#define CMD_PP 0x02
#define CMD_READ 0x03

/* Commands from the page */
#define LDR_FLASH_ERASE 1  /* a = sector number */
#define LDR_FLASH_WRITE 2  /* a = dest, b = src, c = bytes (multiple of 4) */
#define LDR_FLASH_LOCK 3
#define LDR_QSPI_INIT 4    /* returns JEDEC ID (mfr<<16 | type<<8 | cap) */
#define LDR_QSPI_ERASE 5   /* a = flash offset of a 64 KB sector */
#define LDR_QSPI_WRITE 6   /* a = flash offset, b = src, c = bytes */
#define LDR_QSPI_MMAP 7    /* memory-map QSPI at 0x90000000 for reads */
#define LDR_CRC32 8        /* a = addr, b = bytes, c = 1 KB scratch for table */

/* Errors: 0x8xxxxxxx so they can't be confused with a JEDEC ID or CRC
 * that a caller checks separately. Low bits carry detail. */
#define ERR_TIMEOUT 0x80000001u
#define ERR_FLASH 0x81000000u   /* | FLASH_SR error bits */
#define ERR_BADCMD 0x82000000u
#define ERR_QSPI_WP 0x83000000u /* | status register */

/* Loop-count timeouts, generous for 16 MHz. A 256 KB sector erase can take
 * up to 4 s, a 64 KB QSPI sector erase up to 3 s. */
#define T_LONG 40000000u

static int flash_wait(void)
{
    uint32_t n = T_LONG;
    while (FLASH_SR & SR_BSY)
        if (--n == 0)
            return -1;
    return 0;
}

static uint32_t flash_unlock(void)
{
    if (FLASH_CR & CR_LOCK) {
        FLASH_KEYR = 0x45670123u;
        FLASH_KEYR = 0xCDEF89ABu;
    }
    if (flash_wait())
        return ERR_TIMEOUT;
    FLASH_SR = SR_ERRS | 1u; /* clear EOP and errors */
    return 0;
}

static uint32_t flash_erase(uint32_t sector)
{
    uint32_t r = flash_unlock();
    if (r)
        return r;
    FLASH_CR = CR_SER | CR_PSIZE_X32 | (sector << 3);
    FLASH_CR |= CR_STRT;
    __asm__ volatile("dsb" ::: "memory");
    if (flash_wait())
        return ERR_TIMEOUT;
    FLASH_CR = 0;
    r = FLASH_SR & SR_ERRS;
    return r ? (ERR_FLASH | r) : 0;
}

static uint32_t flash_write(uint32_t dst, const uint32_t *src, uint32_t len)
{
    uint32_t r = flash_unlock();
    if (r)
        return r;
    FLASH_CR = CR_PG | CR_PSIZE_X32;
    volatile uint32_t *d = (volatile uint32_t *)dst;
    for (uint32_t i = 0; i < len / 4; i++) {
        d[i] = src[i];
        __asm__ volatile("dsb" ::: "memory");
        if (flash_wait()) {
            FLASH_CR = 0;
            return ERR_TIMEOUT;
        }
        r = FLASH_SR & SR_ERRS;
        if (r) {
            FLASH_CR = 0;
            return ERR_FLASH | r;
        }
    }
    FLASH_CR = 0;
    return 0;
}

/* ---- QSPI ---- */

static void gpio_af(uint32_t port, uint32_t pin, uint32_t af)
{
    REG(port + 0x00) = (REG(port + 0x00) & ~(3u << (pin * 2))) | (2u << (pin * 2)); /* MODER: AF */
    REG(port + 0x08) |= 3u << (pin * 2);                                           /* OSPEEDR: very high */
    REG(port + 0x0C) = (REG(port + 0x0C) & ~(3u << (pin * 2))) | (1u << (pin * 2)); /* PUPDR: pull-up */
    uint32_t afr = port + (pin < 8 ? 0x20 : 0x24);
    uint32_t sh = (pin & 7) * 4;
    REG(afr) = (REG(afr) & ~(0xFu << sh)) | (af << sh);
}

static int qspi_idle(void)
{
    uint32_t n = T_LONG;
    while (QSPI_SR & QSR_BUSY)
        if (--n == 0)
            return -1;
    return 0;
}

static int qspi_wait_tc(void)
{
    uint32_t n = T_LONG;
    while (!(QSPI_SR & QSR_TCF))
        if (--n == 0)
            return -1;
    QSPI_FCR = QSR_TCF;
    return 0;
}

/* Instruction only. lines = 1 (SPI) or 4 (quad), for the reset sequence. */
static int qspi_cmd(uint32_t ins, uint32_t lines)
{
    if (qspi_idle())
        return -1;
    QSPI_CCR = FMODE_WRITE | IMODE(lines == 4 ? 3 : 1) | ins;
    return qspi_wait_tc();
}

/* Instruction + 24-bit address, no data (sector erase). */
static int qspi_cmd_addr(uint32_t ins, uint32_t addr)
{
    if (qspi_idle())
        return -1;
    QSPI_CCR = FMODE_WRITE | IMODE(1) | ADMODE(1) | ADSIZE24 | ins;
    QSPI_AR = addr;
    return qspi_wait_tc();
}

/* Instruction then read n bytes on one line, returned big-endian packed. */
static int qspi_read_reg(uint32_t ins, uint32_t n, uint32_t *out)
{
    if (qspi_idle())
        return -1;
    QSPI_DLR = n - 1;
    QSPI_CCR = FMODE_READ | IMODE(1) | DMODE(1) | ins;
    uint32_t v = 0;
    for (uint32_t i = 0; i < n; i++) {
        uint32_t t = T_LONG;
        while (!(QSPI_SR & (QSR_FTF | QSR_TCF)))
            if (--t == 0)
                return -1;
        v = (v << 8) | REG8(QSPI_DR);
    }
    if (qspi_wait_tc())
        return -1;
    *out = v;
    return 0;
}

/* Instruction (+ optional address) then write n bytes on one line. */
static int qspi_write_data(uint32_t ins, int has_addr, uint32_t addr, const uint8_t *p, uint32_t n)
{
    if (qspi_idle())
        return -1;
    QSPI_DLR = n - 1;
    QSPI_CCR = FMODE_WRITE | IMODE(1) | DMODE(1) | ins | (has_addr ? (ADMODE(1) | ADSIZE24) : 0);
    if (has_addr)
        QSPI_AR = addr;
    for (uint32_t i = 0; i < n; i++) {
        uint32_t t = T_LONG;
        while (!(QSPI_SR & QSR_FTF))
            if (--t == 0)
                return -1;
        REG8(QSPI_DR) = p[i];
    }
    return qspi_wait_tc();
}

/* Poll the flash status register until WIP clears. */
static int qspi_wait_ready(void)
{
    uint32_t sr, n = T_LONG / 64;
    do {
        if (qspi_read_reg(CMD_RDSR, 1, &sr))
            return -1;
        if (--n == 0)
            return -1;
    } while (sr & 1u);
    return 0;
}

static int qspi_write_enable(void)
{
    if (qspi_cmd(CMD_WREN, 1))
        return -1;
    uint32_t sr, n = 100000;
    do {
        if (qspi_read_reg(CMD_RDSR, 1, &sr))
            return -1;
        if (--n == 0)
            return -1;
    } while (!(sr & 2u));
    return 0;
}

static uint32_t qspi_init(void)
{
    RCC_AHB1ENR |= (1u << 1) | (1u << 3) | (1u << 4); /* GPIOB, GPIOD, GPIOE */
    RCC_AHB3ENR |= (1u << 1);                         /* QSPI */
    (void)RCC_AHB3ENR;

    /* Pins as in ST's stm32746g_discovery_qspi.h */
    gpio_af(GPIOB, 2, 9);   /* CLK */
    gpio_af(GPIOB, 6, 10);  /* NCS */
    gpio_af(GPIOD, 11, 9);  /* IO0 */
    gpio_af(GPIOD, 12, 9);  /* IO1 */
    gpio_af(GPIOE, 2, 9);   /* IO2 */
    gpio_af(GPIOD, 13, 9);  /* IO3 */

    QSPI_CR = 0;
    if (QSPI_SR & QSR_BUSY) {
        QSPI_CR = QCR_ABORT;
        if (qspi_idle())
            return ERR_TIMEOUT;
    }
    /* 16 MHz / (1+1) = 8 MHz clock, 16 MB, CS high >= 6 cycles,
     * sample shifted half a cycle, FIFO threshold 1 byte. */
    QSPI_DCR = (23u << 16) | (5u << 8);
    QSPI_CR = (1u << 24) | (1u << 4) | QCR_EN;
    QSPI_FCR = 0x1B;

    /* Reset the memory whether it was left in quad or single mode by the app. */
    if (qspi_cmd(CMD_RESET_EN, 4) || qspi_cmd(CMD_RESET, 4) ||
        qspi_cmd(CMD_RESET_EN, 1) || qspi_cmd(CMD_RESET, 1))
        return ERR_TIMEOUT;
    for (volatile uint32_t d = 0; d < 2000; d++) /* tSHSL3 ~ 40 us */
        ;
    if (qspi_wait_ready())
        return ERR_TIMEOUT;

    /* Clear block protection if the app set it. */
    uint32_t sr;
    if (qspi_read_reg(CMD_RDSR, 1, &sr))
        return ERR_TIMEOUT;
    if (sr & 0x7C) {
        uint8_t zero = 0;
        if (qspi_write_enable() || qspi_write_data(CMD_WRSR, 0, 0, &zero, 1) || qspi_wait_ready())
            return ERR_TIMEOUT;
        if (qspi_read_reg(CMD_RDSR, 1, &sr))
            return ERR_TIMEOUT;
        if (sr & 0x7C)
            return ERR_QSPI_WP | sr;
    }

    uint32_t id;
    if (qspi_read_reg(CMD_RDID, 3, &id))
        return ERR_TIMEOUT;
    return id;
}

static uint32_t qspi_erase(uint32_t addr)
{
    if (qspi_write_enable() || qspi_cmd_addr(CMD_SE64K, addr) || qspi_wait_ready())
        return ERR_TIMEOUT;
    return 0;
}

static uint32_t qspi_write(uint32_t addr, const uint8_t *src, uint32_t len)
{
    while (len) {
        uint32_t n = 256 - (addr & 255); /* stay inside one page */
        if (n > len)
            n = len;
        if (qspi_write_enable() || qspi_write_data(CMD_PP, 1, addr, src, n) || qspi_wait_ready())
            return ERR_TIMEOUT;
        addr += n;
        src += n;
        len -= n;
    }
    return 0;
}

static uint32_t qspi_mmap(void)
{
    if (qspi_idle())
        return ERR_TIMEOUT;
    QSPI_CCR = FMODE_MMAP | IMODE(1) | ADMODE(1) | ADSIZE24 | DMODE(1) | CMD_READ;
    return 0;
}

/* Standard CRC-32 (zlib). The table is built in caller-provided RAM so the
 * loader has no data section. */
static uint32_t crc32(const uint8_t *p, uint32_t len, uint32_t *table)
{
    for (uint32_t i = 0; i < 256; i++) {
        uint32_t c = i;
        for (int k = 0; k < 8; k++)
            c = (c & 1) ? (0xEDB88320u ^ (c >> 1)) : (c >> 1);
        table[i] = c;
    }
    uint32_t c = 0xFFFFFFFFu;
    for (uint32_t i = 0; i < len; i++)
        c = table[(c ^ p[i]) & 0xFF] ^ (c >> 8);
    return ~c;
}

uint32_t loader(uint32_t cmd, uint32_t a, uint32_t b, uint32_t c)
{
    switch (cmd) {
    case LDR_FLASH_ERASE:
        return flash_erase(a);
    case LDR_FLASH_WRITE:
        return flash_write(a, (const uint32_t *)b, c);
    case LDR_FLASH_LOCK:
        FLASH_CR = CR_LOCK;
        return 0;
    case LDR_QSPI_INIT:
        return qspi_init();
    case LDR_QSPI_ERASE:
        return qspi_erase(a);
    case LDR_QSPI_WRITE:
        return qspi_write(a, (const uint8_t *)b, c);
    case LDR_QSPI_MMAP:
        return qspi_mmap();
    case LDR_CRC32:
        return crc32((const uint8_t *)a, b, (uint32_t *)c);
    }
    return ERR_BADCMD;
}

/* The page sets LR here so each call ends halted. */
__attribute__((naked)) void loader_done(void)
{
    __asm__ volatile("bkpt #0\n b .");
}
