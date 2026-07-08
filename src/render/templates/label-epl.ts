/**
 * EPL2 label renderer — older Zebra desktops (LP2824, TLP2844) and some
 * OEM boxes that never got a ZPL firmware. 8 dots/mm at 203dpi.
 */

import type { LabelInput } from "./label";
import type { LabelSize } from "./label-tspl";

const DPMM = 8;

function sanitize(text: string | undefined): string {
  if (!text) return "";
  return String(text).replace(/["\r\n\t]/g, " ").trim();
}

function textAt(x: number, y: number, font: number, text: string): string {
  const t = sanitize(text);
  if (!t) return "";
  return `A${x},${y},0,${font},1,1,N,"${t}"\n`;
}

export function renderLabelEPL(input: LabelInput, size: LabelSize): Buffer {
  const wDots = Math.round(size.widthMm * DPMM);
  const hDots = Math.round(size.heightMm * DPMM);

  let out = "";
  out += `N\n`;
  out += `q${wDots}\n`;
  out += `Q${hDots},24\n`;

  const marginX = 16;
  let y = 16;

  out += textAt(marginX, y, 4, input.referenceNumber);
  y += 44;

  if (input.bagIndex && input.bagTotal) {
    out += textAt(marginX, y, 2, `Bag ${input.bagIndex} of ${input.bagTotal}`);
    y += 28;
  }

  // B x,y,rot,type,narrow,wide,height,human,"data"
  out += `B${marginX},${y},0,1,2,2,60,B,"${sanitize(input.referenceNumber)}"\n`;
  y += 80;

  if (input.orderType)       { out += textAt(marginX, y, 2, `Type: ${input.orderType.toUpperCase()}`); y += 28; }
  if (input.scheduledFor)    { out += textAt(marginX, y, 2, `For:  ${input.scheduledFor}`);            y += 28; }
  if (input.customerName)    { out += textAt(marginX, y, 2, `Name: ${input.customerName}`);            y += 28; }
  if (input.customerPhone)   { out += textAt(marginX, y, 2, `Ph:   ${input.customerPhone}`);           y += 28; }
  if (input.deliveryAddress) { out += textAt(marginX, y, 1, input.deliveryAddress);                    y += 22; }
  if (input.itemSummary)     { out += textAt(marginX, y, 1, input.itemSummary);                        y += 22; }
  if (input.handlingNote)    { out += textAt(marginX, y, 3, `! ${input.handlingNote}`);                y += 32; }

  out += `P1\n`;
  return Buffer.from(out, "ascii");
}
