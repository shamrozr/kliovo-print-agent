/**
 * Item / package label — used for delivery bag tagging and per-item
 * labels on multi-item orders.
 *
 * Sized for a 58mm label printer / small thermal slip. Includes a
 * barcode of the order reference so dispatch riders can scan-confirm
 * pickup without keying in IDs.
 */

import { ESCPOSBuilder, CP_WPC1256 } from "../builder";
import type { PaperWidth } from "./receipt";

export interface LabelInput {
  paperWidth?: PaperWidth;
  referenceNumber: string;
  /** Index for "Bag 1 of 3" style numbering */
  bagIndex?: number;
  bagTotal?: number;
  customerName?: string;
  customerPhone?: string;
  deliveryAddress?: string;
  orderType?: string;
  /** Pre-formatted scheduled / dispatch time */
  scheduledFor?: string;
  /** Short item summary, e.g. "2 burgers, 1 fries" */
  itemSummary?: string;
  /** Special handling notes (e.g. "Allergy: nuts") */
  handlingNote?: string;
}

export function renderLabel(input: LabelInput): Buffer {
  const pw: PaperWidth = input.paperWidth === 58 ? 58 : 80;
  const b = new ESCPOSBuilder().init().codePage(CP_WPC1256);

  // ── Header line ──────────────────────────────────────────
  b.align("center").size("large").bold(true).line(input.referenceNumber).bold(false).size("normal");

  if (input.bagIndex && input.bagTotal) {
    b.align("center").bold(true).line(`Bag ${input.bagIndex} of ${input.bagTotal}`).bold(false);
  }

  // ── Scan code ────────────────────────────────────────────
  b.align("center").barcode(input.referenceNumber, { type: "CODE128", height: 60, hriPosition: 0 });
  b.rule(pw);

  // ── Routing block ────────────────────────────────────────
  b.align("left");
  if (input.orderType) b.row("Type", input.orderType.toUpperCase(), pw);
  if (input.scheduledFor) b.row("For", input.scheduledFor, pw);
  if (input.customerName) b.row("Name", input.customerName, pw);
  if (input.customerPhone) b.row("Phone", input.customerPhone, pw);
  if (input.deliveryAddress) {
    b.line("Address:");
    b.line(input.deliveryAddress);
  }
  if (input.itemSummary) {
    b.rule(pw);
    b.line(input.itemSummary);
  }
  if (input.handlingNote) {
    b.bold(true).line(`! ${input.handlingNote}`).bold(false);
  }

  return b.feed(1).cut(false).build();
}
