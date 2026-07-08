/**
 * Test-print byte builders for label printers. ESC/POS is for receipt
 * printers — sending those bytes to a label printer produces nothing (or a
 * garbled feed), which is why the previous test print worked from a receipt
 * printer's own software but not from Kliovo. Label printers speak TSPL
 * (TSC/Xprinter/Rongta and most cheap USB label printers), ZPL (Zebra), or
 * EPL2 (older Zebra). Each function returns a self-contained ~1-label buffer
 * that renders "Kliovo / Test Print / <target> / <timestamp>".
 */
import type { PrinterEntry } from "../config";

function mmOr(v: number | undefined, fallback: number): number {
  return typeof v === "number" && isFinite(v) && v > 0 ? v : fallback;
}

export function buildTsplTest(printer: PrinterEntry, target: string): Buffer {
  const widthMm  = mmOr(printer.labelWidthMm, 60);
  const heightMm = mmOr(printer.labelHeightMm, 40);
  const gapType  = printer.gapType || "die_cut";

  const lines: string[] = [];
  lines.push(`SIZE ${widthMm} mm, ${heightMm} mm`);
  if (gapType === "black_mark")      lines.push("BLINE 3 mm, 0 mm");
  else if (gapType === "continuous") lines.push("GAP 0 mm, 0 mm");
  else                               lines.push("GAP 2 mm, 0 mm");
  lines.push("DIRECTION 1");
  lines.push("CLS");
  lines.push(`TEXT 20,20,"3",0,1,1,"Kliovo"`);
  lines.push(`TEXT 20,80,"2",0,1,1,"Test Print"`);
  lines.push(`TEXT 20,120,"2",0,1,1,"${target.replace(/"/g, "'")}"`);
  lines.push(`TEXT 20,160,"2",0,1,1,"${new Date().toLocaleString().replace(/"/g, "'")}"`);
  lines.push("PRINT 1,1");
  return Buffer.from(lines.join("\r\n") + "\r\n", "ascii");
}

export function buildZplTest(printer: PrinterEntry, target: string): Buffer {
  // ZPL positions in dots. Assume 203 dpi (8 dots/mm) — the default for
  // nearly every desktop Zebra. Height/width don't need to match the media;
  // Zebra prints to whatever's loaded as long as ^PW covers it.
  const dotsPerMm = 8;
  const widthDots = Math.round(mmOr(printer.labelWidthMm, 60) * dotsPerMm);
  const zpl = [
    "^XA",
    `^PW${widthDots}`,
    "^LH0,0",
    `^FO30,30^A0N,60,60^FDKliovo^FS`,
    `^FO30,110^A0N,40,40^FDTest Print^FS`,
    `^FO30,170^A0N,30,30^FD${target}^FS`,
    `^FO30,220^A0N,30,30^FD${new Date().toLocaleString()}^FS`,
    "^XZ",
  ].join("\n");
  return Buffer.from(zpl, "ascii");
}

export function buildEplTest(printer: PrinterEntry, target: string): Buffer {
  const epl = [
    "N",
    `A30,20,0,4,1,1,N,"Kliovo"`,
    `A30,80,0,3,1,1,N,"Test Print"`,
    `A30,120,0,2,1,1,N,"${target}"`,
    `A30,150,0,2,1,1,N,"${new Date().toLocaleString()}"`,
    "P1",
  ].join("\n");
  return Buffer.from(epl + "\n", "ascii");
}

export function buildLabelTest(printer: PrinterEntry, target: string): Buffer {
  const lang = printer.labelLanguage || "tspl";
  if (lang === "zpl") return buildZplTest(printer, target);
  if (lang === "epl") return buildEplTest(printer, target);
  return buildTsplTest(printer, target);
}
