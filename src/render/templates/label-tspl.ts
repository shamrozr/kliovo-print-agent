/**
 * TSPL label renderer — TSC / Xprinter / Rongta / most cheap USB label
 * printers speak this dialect. Same LabelInput as the ESC/POS label so
 * upstream code doesn't have to branch. Dimensions come from PrinterEntry
 * (labelWidthMm / labelHeightMm / gapType).
 */

import type { LabelInput } from "./label";

export interface LabelSize {
  widthMm: number;
  heightMm: number;
  gapMm: number;
  gapType?: "die_cut" | "black_mark" | "continuous";
}

function sanitize(text: string | undefined): string {
  if (!text) return "";
  return String(text).replace(/["\r\n\t]/g, " ").trim();
}

function textLine(x: number, y: number, font: string, text: string): string {
  const t = sanitize(text);
  if (!t) return "";
  return `TEXT ${x},${y},"${font}",0,1,1,"${t}"\n`;
}

export function renderLabelTSPL(input: LabelInput, size: LabelSize): Buffer {
  let out = "";
  out += `SIZE ${size.widthMm} mm, ${size.heightMm} mm\n`;
  if (size.gapType === "black_mark")      out += `BLINE 3 mm, 0 mm\n`;
  else if (size.gapType === "continuous") out += `GAP 0 mm, 0 mm\n`;
  else                                    out += `GAP ${size.gapMm} mm, 0 mm\n`;
  out += `DIRECTION 1\n`;
  out += `REFERENCE 0,0\n`;
  out += `CLS\n`;

  const marginX = 16;
  let y = 16;

  out += textLine(marginX, y, "4", input.referenceNumber);
  y += 44;

  if (input.bagIndex && input.bagTotal) {
    out += textLine(marginX, y, "2", `Bag ${input.bagIndex} of ${input.bagTotal}`);
    y += 28;
  }

  // CODE-128 of the reference for scanner pick-up.
  out += `BARCODE ${marginX},${y},"128",56,1,0,2,2,"${sanitize(input.referenceNumber)}"\n`;
  y += 72;

  if (input.orderType)       { out += textLine(marginX, y, "2", `Type: ${input.orderType.toUpperCase()}`); y += 28; }
  if (input.scheduledFor)    { out += textLine(marginX, y, "2", `For:  ${input.scheduledFor}`);            y += 28; }
  if (input.customerName)    { out += textLine(marginX, y, "2", `Name: ${input.customerName}`);            y += 28; }
  if (input.customerPhone)   { out += textLine(marginX, y, "2", `Ph:   ${input.customerPhone}`);           y += 28; }
  if (input.deliveryAddress) { out += textLine(marginX, y, "1", input.deliveryAddress);                    y += 22; }
  if (input.itemSummary)     { out += textLine(marginX, y, "1", input.itemSummary);                        y += 22; }
  if (input.handlingNote)    { out += textLine(marginX, y, "3", `! ${input.handlingNote}`);                y += 32; }

  out += `PRINT 1,1\n`;
  return Buffer.from(out, "ascii");
}
