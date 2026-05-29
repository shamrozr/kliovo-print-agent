// VENDORED from Kliovo-Dine: src/lib/print/escpos/builder.ts
// Keep in sync with the canonical source. Pure ESC/POS byte builder (Buffer only).

/**
 * ESC/POS Builder — fluent byte-level builder for thermal printers
 *
 * Centralised, server-rendered command stream per DECISIONS D11.1.
 * Output: raw `Buffer` of ESC/POS bytes the print agent (or a USB bridge)
 * can stream directly to a 58mm / 80mm thermal printer.
 *
 * Reference command set: Epson ESC/POS (which Star and most Chinese
 * generic printers implement). CP-1256 chosen for Urdu/Arabic glyph
 * support — most Epson TM-T20II / TM-T82 / Bixolon SRP-350 ship CP-1256
 * by default and accept code page 22 (Iran System) for additional
 * fallbacks.
 *
 * NOTE: This file is additive — `src/lib/receipt-renderer.ts` still
 * produces the legacy structured ESC/POS command list for the existing
 * pipeline. The Buffer output of this builder is the canonical bytes
 * the new print queue → agent path will ship.
 */

// ── Control bytes ────────────────────────────────────────────
const ESC = 0x1b;
const GS = 0x1d;
const LF = 0x0a;
const NUL = 0x00;

// ── Code page constants (per Epson manual) ───────────────────
/** PC437 — USA, default for most Epson printers */
export const CP_PC437 = 0;
/** PC850 — Multilingual Latin 1 */
export const CP_PC850 = 2;
/** WPC1252 — Windows Latin 1, accents and currency */
export const CP_WPC1252 = 16;
/** PC864 — Arabic */
export const CP_PC864 = 22;
/** WPC1256 — Windows Arabic / Urdu (THE one for Pakistan) */
export const CP_WPC1256 = 32;

export type Alignment = "left" | "center" | "right";
export type FontSize = "small" | "normal" | "large" | "xlarge";

export interface QrOptions {
  /** Model: 1 = QR Model 1, 2 = QR Model 2 (default) */
  model?: 1 | 2;
  /** Module size 1-16 (default 6) */
  size?: number;
  /** Error correction: L | M | Q | H */
  ec?: "L" | "M" | "Q" | "H";
}

export interface BarcodeOptions {
  type?: "UPC-A" | "UPC-E" | "EAN13" | "EAN8" | "CODE39" | "ITF" | "CODE93" | "CODE128";
  height?: number;
  width?: number;
  /** 0=none, 1=above, 2=below, 3=above+below */
  hriPosition?: 0 | 1 | 2 | 3;
}

/**
 * Fluent ESC/POS command builder.
 *
 * @example
 *   const bytes = new ESCPOSBuilder()
 *     .codePage(CP_WPC1256)
 *     .align("center").size("large").text("BurgerLub").newline()
 *     .size("normal").text("شکریہ").newline()
 *     .qr("https://kliovo.com/verify/123").feed(2).cut().build();
 */
export class ESCPOSBuilder {
  private chunks: Buffer[] = [];
  private currentCodePage = CP_WPC1256;

  // ── Initialisation ───────────────────────────────────────────

  /** Reset printer to default state. Call at start of every job. */
  init(): this {
    this.chunks.push(Buffer.from([ESC, 0x40])); // ESC @
    // Default to Windows-1256 so Urdu strings render correctly.
    return this.codePage(CP_WPC1256);
  }

  /** Set ESC/POS character code table. */
  codePage(cp: number): this {
    this.currentCodePage = cp;
    this.chunks.push(Buffer.from([ESC, 0x74, cp])); // ESC t n
    return this;
  }

  // ── Text & formatting ────────────────────────────────────────

  /** Append raw text using the current code page. */
  text(s: string): this {
    if (!s) return this;
    this.chunks.push(encodeText(s, this.currentCodePage));
    return this;
  }

  /** Convenience: text + newline. */
  line(s = ""): this {
    return this.text(s).newline();
  }

  newline(count = 1): this {
    if (count <= 0) return this;
    this.chunks.push(Buffer.from(Array(count).fill(LF)));
    return this;
  }

  /** Multiple line feed via ESC d n (more efficient than N x LF). */
  feed(lines: number): this {
    if (lines <= 0) return this;
    this.chunks.push(Buffer.from([ESC, 0x64, Math.min(lines, 255)]));
    return this;
  }

  align(a: Alignment): this {
    const n = a === "left" ? 0 : a === "center" ? 1 : 2;
    this.chunks.push(Buffer.from([ESC, 0x61, n])); // ESC a n
    return this;
  }

  bold(on: boolean): this {
    this.chunks.push(Buffer.from([ESC, 0x45, on ? 1 : 0])); // ESC E n
    return this;
  }

  underline(level: 0 | 1 | 2 = 1): this {
    this.chunks.push(Buffer.from([ESC, 0x2d, level])); // ESC - n
    return this;
  }

  invert(on: boolean): this {
    this.chunks.push(Buffer.from([GS, 0x42, on ? 1 : 0])); // GS B n
    return this;
  }

  /** Sets character size by multiplier (1-8 width, 1-8 height). */
  size(size: FontSize): this {
    let n = 0;
    if (size === "small") n = 0x00;
    else if (size === "normal") n = 0x00;
    else if (size === "large") n = 0x11; // 2x width + 2x height
    else if (size === "xlarge") n = 0x22; // 3x width + 3x height
    // GS ! n
    this.chunks.push(Buffer.from([GS, 0x21, n]));
    // Mode select Font B for "small" (narrower glyph)
    if (size === "small") this.chunks.push(Buffer.from([ESC, 0x4d, 0x01]));
    else this.chunks.push(Buffer.from([ESC, 0x4d, 0x00]));
    return this;
  }

  // ── Layout helpers ───────────────────────────────────────────

  /** Horizontal divider sized to paper width (48 chars for 80mm, 32 for 58mm). */
  rule(paperWidth: 80 | 58 = 80, char = "-"): this {
    const width = paperWidth === 80 ? 48 : 32;
    return this.line(char.repeat(width));
  }

  /**
   * Two-column row: label left-aligned, value right-aligned.
   * Useful for totals lines: `subtotal | Rs 1,200.00`.
   */
  row(label: string, value: string, paperWidth: 80 | 58 = 80): this {
    const width = paperWidth === 80 ? 48 : 32;
    const gap = Math.max(1, width - label.length - value.length);
    return this.line(label + " ".repeat(gap) + value);
  }

  // ── Graphics ─────────────────────────────────────────────────

  /**
   * QR Code via GS ( k commands (Model 2).
   * Stable across Epson / Star / most generic printers.
   */
  qr(data: string, opts: QrOptions = {}): this {
    const model = opts.model ?? 2;
    const size = Math.max(1, Math.min(16, opts.size ?? 6));
    const ec = opts.ec ?? "M";
    const ecMap = { L: 48, M: 49, Q: 50, H: 51 } as const;

    // Model (fn 65)
    this.chunks.push(Buffer.from([GS, 0x28, 0x6b, 4, 0, 49, 65, model + 49, 0]));
    // Module size (fn 67)
    this.chunks.push(Buffer.from([GS, 0x28, 0x6b, 3, 0, 49, 67, size]));
    // Error correction (fn 69)
    this.chunks.push(Buffer.from([GS, 0x28, 0x6b, 3, 0, 49, 69, ecMap[ec]]));

    // Store data (fn 80)
    const dataBuf = Buffer.from(data, "utf8");
    const len = dataBuf.length + 3;
    const pL = len & 0xff;
    const pH = (len >> 8) & 0xff;
    this.chunks.push(Buffer.from([GS, 0x28, 0x6b, pL, pH, 49, 80, 48]));
    this.chunks.push(dataBuf);

    // Print (fn 81)
    this.chunks.push(Buffer.from([GS, 0x28, 0x6b, 3, 0, 49, 81, 48]));
    return this;
  }

  /** Linear barcode via GS k. Defaults to CODE128. */
  barcode(data: string, opts: BarcodeOptions = {}): this {
    const typeMap = {
      "UPC-A": 65,
      "UPC-E": 66,
      EAN13: 67,
      EAN8: 68,
      CODE39: 69,
      ITF: 70,
      CODE93: 72,
      CODE128: 73,
    } as const;
    const t = typeMap[opts.type ?? "CODE128"];
    const height = Math.max(1, Math.min(255, opts.height ?? 80));
    const width = Math.max(2, Math.min(6, opts.width ?? 3));
    const hri = opts.hriPosition ?? 2;

    // Height
    this.chunks.push(Buffer.from([GS, 0x68, height])); // GS h n
    // Width (module)
    this.chunks.push(Buffer.from([GS, 0x77, width])); // GS w n
    // HRI position (0=none,1=above,2=below,3=both)
    this.chunks.push(Buffer.from([GS, 0x48, hri])); // GS H n

    const data128 = Buffer.from(data, "ascii");
    this.chunks.push(Buffer.from([GS, 0x6b, t, data128.length]));
    this.chunks.push(data128);
    return this;
  }

  /**
   * Raster image from base64 PNG/JPEG bytes is non-trivial (needs
   * dithering); for v1 we accept a pre-rendered raw raster buffer
   * (1bpp, width must be multiple of 8). Caller renders via sharp / pngjs.
   *
   * For most tenant logos, callers should print logo via a pre-loaded
   * NV image slot (GS ( L) — out of scope here.
   */
  rasterImage(rasterBytes: Buffer, widthBytes: number, heightDots: number): this {
    // GS v 0 m xL xH yL yH d1...dk
    const m = 0; // normal density
    const xL = widthBytes & 0xff;
    const xH = (widthBytes >> 8) & 0xff;
    const yL = heightDots & 0xff;
    const yH = (heightDots >> 8) & 0xff;
    this.chunks.push(Buffer.from([GS, 0x76, 0x30, m, xL, xH, yL, yH]));
    this.chunks.push(rasterBytes);
    return this;
  }

  // ── Drawer & cut ─────────────────────────────────────────────

  /** Open cash drawer pin (kicks the drawer). */
  drawerKick(pin: 0 | 1 = 0): this {
    // ESC p m t1 t2 — t1=50ms on, t2=120ms wait
    this.chunks.push(Buffer.from([ESC, 0x70, pin, 0x32, 0x78]));
    return this;
  }

  /**
   * Paper cut.
   * full=true  → GS V 0x00 (full guillotine cut  — most printers)
   * full=false → GS V 0x01 (partial cut          — printers with partial-cut blade)
   *
   * We feed just 1 line before cutting. The printer itself advances paper
   * to its cutter position; adding extra feed here only wastes paper.
   * Templates that want more blank space should call feed() themselves.
   */
  cut(full = true): this {
    this.feed(1);
    this.chunks.push(Buffer.from([GS, 0x56, full ? 0x00 : 0x01]));
    return this;
  }

  // ── Output ───────────────────────────────────────────────────

  build(): Buffer {
    return Buffer.concat(this.chunks);
  }

  /** Base64 representation — handy for storing in `PrintJob` payload. */
  toBase64(): string {
    return this.build().toString("base64");
  }
}

// ──────────────────────────────────────────────────────────────
// Encoding helpers — CP1256 for Urdu glyphs.
// Node's `Buffer.from(str, "binary")` truncates >0xFF cleanly but
// loses Arabic codepoints, so we hand-build the lookup.
// Only the printable Arabic / Urdu range that CP1256 carries is mapped;
// glyphs outside the table fall back to "?" so the printer never chokes.
// ──────────────────────────────────────────────────────────────

const CP1256_LOOKUP: Record<number, number> = (() => {
  // CP-1256 lower 0x00-0x7F is identical to ASCII.
  const map: Record<number, number> = {};
  for (let i = 0; i < 0x80; i++) map[i] = i;
  // Upper bank — Unicode → CP-1256
  // Selected glyphs commonly used in Urdu menus / receipts.
  const pairs: [number, number][] = [
    [0x20ac, 0x80], [0x067e, 0x81], [0x201a, 0x82], [0x0192, 0x83], [0x201e, 0x84],
    [0x2026, 0x85], [0x2020, 0x86], [0x2021, 0x87], [0x02c6, 0x88], [0x2030, 0x89],
    [0x0679, 0x8a], [0x2039, 0x8b], [0x0152, 0x8c], [0x0686, 0x8d], [0x0698, 0x8e],
    [0x0688, 0x8f], [0x06af, 0x90], [0x2018, 0x91], [0x2019, 0x92], [0x201c, 0x93],
    [0x201d, 0x94], [0x2022, 0x95], [0x2013, 0x96], [0x2014, 0x97], [0x06a9, 0x98],
    [0x2122, 0x99], [0x0691, 0x9a], [0x203a, 0x9b], [0x0153, 0x9c], [0x200c, 0x9d],
    [0x200d, 0x9e], [0x06ba, 0x9f], [0x00a0, 0xa0], [0x060c, 0xa1], [0x00a2, 0xa2],
    [0x00a3, 0xa3], [0x00a4, 0xa4], [0x00a5, 0xa5], [0x00a6, 0xa6], [0x00a7, 0xa7],
    [0x00a8, 0xa8], [0x00a9, 0xa9], [0x06be, 0xaa], [0x00ab, 0xab], [0x00ac, 0xac],
    [0x00ad, 0xad], [0x00ae, 0xae], [0x00af, 0xaf], [0x00b0, 0xb0], [0x00b1, 0xb1],
    [0x00b2, 0xb2], [0x00b3, 0xb3], [0x00b4, 0xb4], [0x00b5, 0xb5], [0x00b6, 0xb6],
    [0x00b7, 0xb7], [0x00b8, 0xb8], [0x00b9, 0xb9], [0x061b, 0xba], [0x00bb, 0xbb],
    [0x00bc, 0xbc], [0x00bd, 0xbd], [0x00be, 0xbe], [0x061f, 0xbf], [0x06c1, 0xc0],
    [0x0621, 0xc1], [0x0622, 0xc2], [0x0623, 0xc3], [0x0624, 0xc4], [0x0625, 0xc5],
    [0x0626, 0xc6], [0x0627, 0xc7], [0x0628, 0xc8], [0x0629, 0xc9], [0x062a, 0xca],
    [0x062b, 0xcb], [0x062c, 0xcc], [0x062d, 0xcd], [0x062e, 0xce], [0x062f, 0xcf],
    [0x0630, 0xd0], [0x0631, 0xd1], [0x0632, 0xd2], [0x0633, 0xd3], [0x0634, 0xd4],
    [0x0635, 0xd5], [0x0636, 0xd6], [0x00d7, 0xd7], [0x0637, 0xd8], [0x0638, 0xd9],
    [0x0639, 0xda], [0x063a, 0xdb], [0x0640, 0xdc], [0x0641, 0xdd], [0x0642, 0xde],
    [0x0643, 0xdf], [0x00e0, 0xe0], [0x0644, 0xe1], [0x00e2, 0xe2], [0x0645, 0xe3],
    [0x0646, 0xe4], [0x0647, 0xe5], [0x0648, 0xe6], [0x00e7, 0xe7], [0x00e8, 0xe8],
    [0x00e9, 0xe9], [0x00ea, 0xea], [0x00eb, 0xeb], [0x0649, 0xec], [0x064a, 0xed],
    [0x00ee, 0xee], [0x00ef, 0xef], [0x064b, 0xf0], [0x064c, 0xf1], [0x064d, 0xf2],
    [0x064e, 0xf3], [0x00f4, 0xf4], [0x064f, 0xf5], [0x0650, 0xf6], [0x00f7, 0xf7],
    [0x0651, 0xf8], [0x00f9, 0xf9], [0x0652, 0xfa], [0x00fb, 0xfb], [0x00fc, 0xfc],
    [0x200e, 0xfd], [0x200f, 0xfe], [0x06d2, 0xff],
  ];
  for (const [u, c] of pairs) map[u] = c;
  return map;
})();

function encodeCP1256(s: string): Buffer {
  const out: number[] = [];
  for (const ch of s) {
    const code = ch.codePointAt(0)!;
    const mapped = CP1256_LOOKUP[code];
    if (mapped !== undefined) {
      out.push(mapped);
    } else if (code < 0x80) {
      out.push(code);
    } else {
      out.push(0x3f); // "?"
    }
  }
  return Buffer.from(out);
}

function encodeText(s: string, codePage: number): Buffer {
  if (codePage === CP_WPC1256) return encodeCP1256(s);
  // PC437 / Latin defaults — Buffer.from handles best-effort, drops
  // non-ASCII gracefully because we already initialised the printer
  // to a Latin codepage.
  return Buffer.from(s, "binary");
}

// ── Re-exports for callers ───────────────────────────────────
export const CONTROL_BYTES = { ESC, GS, LF, NUL } as const;
