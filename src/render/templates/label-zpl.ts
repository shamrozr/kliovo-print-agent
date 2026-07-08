/**
 * ZPL label renderer — Zebra printers and every "ZDesigner"-driver box.
 * 8 dots/mm at 203dpi.
 */

import type { LabelInput } from "./label";
import type { LabelSize } from "./label-tspl";

const DPMM = 8;

function sanitize(text: string | undefined): string {
  if (!text) return "";
  // ^ and ~ are ZPL command prefixes — strip so field-data can't hijack them.
  return String(text).replace(/[\^~\r\n\t]/g, " ").trim();
}

function fdBlock(x: number, y: number, fontH: number, fontW: number, text: string): string {
  const t = sanitize(text);
  if (!t) return "";
  return `^FO${x},${y}^A0N,${fontH},${fontW}^FD${t}^FS\n`;
}

export function renderLabelZPL(input: LabelInput, size: LabelSize): Buffer {
  const wDots = Math.round(size.widthMm * DPMM);
  const hDots = Math.round(size.heightMm * DPMM);

  let out = "";
  out += `^XA\n`;
  out += `^CI28\n`;
  out += `^PW${wDots}\n`;
  out += `^LL${hDots}\n`;
  out += `^LH0,0\n`;

  const marginX = 16;
  let y = 12;

  out += fdBlock(marginX, y, 40, 40, input.referenceNumber);
  y += 46;

  if (input.bagIndex && input.bagTotal) {
    out += fdBlock(marginX, y, 24, 24, `Bag ${input.bagIndex} of ${input.bagTotal}`);
    y += 28;
  }

  out += `^FO${marginX},${y}^BY2\n^BCN,60,Y,N,N\n^FD${sanitize(input.referenceNumber)}^FS\n`;
  y += 92;

  if (input.orderType)       { out += fdBlock(marginX, y, 24, 24, `Type: ${input.orderType.toUpperCase()}`); y += 28; }
  if (input.scheduledFor)    { out += fdBlock(marginX, y, 24, 24, `For:  ${input.scheduledFor}`);            y += 28; }
  if (input.customerName)    { out += fdBlock(marginX, y, 24, 24, `Name: ${input.customerName}`);            y += 28; }
  if (input.customerPhone)   { out += fdBlock(marginX, y, 24, 24, `Ph:   ${input.customerPhone}`);           y += 28; }
  if (input.deliveryAddress) { out += fdBlock(marginX, y, 22, 22, input.deliveryAddress);                    y += 26; }
  if (input.itemSummary)     { out += fdBlock(marginX, y, 22, 22, input.itemSummary);                        y += 26; }
  if (input.handlingNote)    { out += fdBlock(marginX, y, 28, 28, `! ${input.handlingNote}`);                y += 32; }

  out += `^PQ1\n`;
  out += `^XZ\n`;
  return Buffer.from(out, "utf-8");
}
