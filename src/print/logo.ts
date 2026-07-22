/**
 * Receipt logo — loaded LOCALLY, no cloud/mirror needed.
 *
 * The web→agent mirror does not carry logo image bytes offline, so the agent
 * rasterizes a logo from a local PNG file to 1bpp ESC/POS (GS v 0) at print
 * time. Drop a black-on-white PNG and it prints on every receipt.
 *
 * Where to put the file (checked in this order):
 *   1. settings key `receipt_logo_path` → an absolute path (optional override)
 *   2. <userData>/offline/receipt-logo.png   ← default; alongside the DB
 *
 * Any PNG works; it is auto-scaled to the paper width (80mm ≈ 576 dots,
 * 58mm ≈ 384 dots) and thresholded to black/white. Result is cached until the
 * file's mtime changes, so replacing the file takes effect on the next print.
 */
import fs from "fs";
import path from "path";
import { app } from "electron";
import { PNG } from "pngjs";
import { getStore } from "../store/db";
import { logger } from "../logger";
import type { RasterLogo } from "./render-map";

const MAX_DOTS: Record<80 | 58, number> = { 80: 576, 58: 384 };

/** Absolute path to the logo file (explicit setting wins, else the default). */
export function receiptLogoPath(): string {
  try {
    const row = getStore().prepare("SELECT value FROM settings WHERE key = ?").get("receipt_logo_path") as
      | { value?: string }
      | undefined;
    if (row?.value) {
      try {
        const v = JSON.parse(row.value);
        if (typeof v === "string" && v.trim()) return v;
      } catch {
        if (row.value.trim()) return row.value;
      }
    }
  } catch {
    /* store not ready — fall through to default */
  }
  return path.join(app.getPath("userData"), "offline", "receipt-logo.png");
}

let cache: { path: string; mtimeMs: number; paperWidth: 80 | 58; logo: RasterLogo | null } | null = null;

/** Rasterized receipt logo for the given paper width, or null if no/invalid file. */
export function loadReceiptLogo(paperWidth: 80 | 58 = 80): RasterLogo | null {
  const p = receiptLogoPath();
  let st: fs.Stats;
  try {
    st = fs.statSync(p);
  } catch {
    return null; // no logo file → print without a logo (unchanged behavior)
  }
  if (cache && cache.path === p && cache.mtimeMs === st.mtimeMs && cache.paperWidth === paperWidth) {
    return cache.logo;
  }
  let logo: RasterLogo | null = null;
  try {
    logo = rasterizePng(fs.readFileSync(p), MAX_DOTS[paperWidth]);
    logger.info(`[logo] receipt logo loaded from ${p} (${logo.widthBytes * 8}x${logo.heightDots} dots)`);
  } catch (e) {
    logger.error(`[logo] failed to rasterize ${p}: ${(e as Error).message}`);
    logo = null;
  }
  cache = { path: p, mtimeMs: st.mtimeMs, paperWidth, logo };
  return logo;
}

/** Decode a PNG and pack it into an ESC/POS GS v 0 raster (row-major, MSB-left,
 *  1 = black dot), scaled down to fit `maxDots` wide. Pure + synchronous. */
function rasterizePng(buf: Buffer, maxDots: number): RasterLogo {
  const png = PNG.sync.read(buf); // normalized to RGBA
  const { width: srcW, height: srcH, data } = png;
  const scale = srcW > maxDots ? maxDots / srcW : 1;
  const outW = Math.max(1, Math.floor(srcW * scale));
  const outH = Math.max(1, Math.floor(srcH * scale));
  const widthBytes = Math.ceil(outW / 8);
  const bytes = Buffer.alloc(widthBytes * outH, 0);

  for (let y = 0; y < outH; y++) {
    const sy = Math.min(srcH - 1, Math.floor(y / scale));
    for (let x = 0; x < outW; x++) {
      const sx = Math.min(srcW - 1, Math.floor(x / scale));
      const idx = (sy * srcW + sx) * 4;
      const a = data[idx + 3];
      // Transparent counts as white; otherwise luma-threshold at 128 → black.
      const lum = a < 128 ? 255 : data[idx] * 0.299 + data[idx + 1] * 0.587 + data[idx + 2] * 0.114;
      if (lum < 128) bytes[y * widthBytes + (x >> 3)] |= 0x80 >> (x & 7);
    }
  }
  return { bytes, widthBytes, heightDots: outH };
}
