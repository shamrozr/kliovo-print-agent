/**
 * Kitchen Order Ticket (KOT) — per-station ticket for cooks.
 *
 * Per DECISIONS D11.3: items routed to specific printers based on
 * `KitchenStation` assignment. A single order with items at three
 * stations produces three KOT prints, one per station.
 *
 * Large, high-contrast layout, no money lines. Urgency banner shown
 * when SLA exceeded so the line cook spots a rush ticket instantly.
 */

import { ESCPOSBuilder, CP_WPC1256 } from "../builder";
import type { PaperWidth } from "./receipt";

export interface KotItem {
  name: string;
  nameAlt?: string;
  quantity: number;
  modifiers?: { name: string }[];
  notes?: string;
  /** Course label e.g. "Starter", "Main" */
  course?: string;
}

export interface KotInput {
  paperWidth?: PaperWidth;
  /** Order reference, e.g. ORD-00123 */
  referenceNumber: string;
  /** Station label, printed bold across top */
  stationName: string;
  stationEmoji?: string;
  /** Table or guest name for routing */
  tableName?: string;
  guestName?: string;
  serverName?: string;
  /** dine_in | takeaway | delivery */
  orderType?: string;
  /** Fire time (when the kitchen received it) — pre-formatted string */
  fireTime: string;
  /** Pre-formatted date */
  fireDate?: string;
  /** True if the station SLA has been exceeded */
  isUrgent?: boolean;
  /** Pre-formatted human label, e.g. "12 min overdue" */
  urgencyLabel?: string;
  /** True if the ticket is a recall (item came back) */
  isRecall?: boolean;

  items: KotItem[];

  /** Reprint version: 1 = original, >1 = reprint with banner */
  version?: number;
}

export function renderKot(input: KotInput): Buffer {
  const pw: PaperWidth = input.paperWidth === 58 ? 58 : 80;
  const b = new ESCPOSBuilder().init().codePage(CP_WPC1256);

  // ── Urgency / recall banners ──────────────────────────────
  if (input.isRecall) {
    b.align("center").invert(true).size("large").bold(true).line(" * * RECALL * * ").bold(false).size("normal").invert(false);
  }
  if (input.isUrgent) {
    b.align("center").invert(true).bold(true).line(` URGENT ${input.urgencyLabel ?? ""} `).bold(false).invert(false);
  }

  // ── Station header ────────────────────────────────────────
  b.align("center").size("xlarge").bold(true);
  b.line(`${input.stationEmoji ? input.stationEmoji + " " : ""}${input.stationName.toUpperCase()}`);
  b.bold(false).size("normal").rule(pw, "=");

  // ── Order meta ────────────────────────────────────────────
  b.align("left");
  b.size("large").bold(true).line(input.referenceNumber).bold(false).size("normal");

  if (input.tableName) b.row("Table", input.tableName, pw);
  if (input.guestName) b.row("Guest", input.guestName, pw);
  if (input.serverName) b.row("Server", input.serverName, pw);
  if (input.orderType) b.row("Type", input.orderType.toUpperCase(), pw);
  b.row("Fired", `${input.fireDate ? input.fireDate + " " : ""}${input.fireTime}`, pw);

  b.rule(pw);

  // ── Items ────────────────────────────────────────────────
  for (const item of input.items) {
    b.size("large").bold(true);
    b.line(`${item.quantity} x ${item.name}`);
    b.bold(false).size("normal");
    if (item.nameAlt) b.line(`  ${item.nameAlt}`);
    if (item.course) b.line(`  [${item.course}]`);
    for (const mod of item.modifiers ?? []) b.line(`  + ${mod.name}`);
    if (item.notes) {
      b.bold(true).line(`  ! ${item.notes}`).bold(false);
    }
    b.newline();
  }

  b.rule(pw, "=");

  if (input.version && input.version > 1) {
    b.align("center").bold(true).line(`** REPRINT v${input.version} **`).bold(false);
  }

  b.align("center").size("small").line("─────────────────────").line("Powered by Kliovo Dine").size("normal");

  return b.feed(2).cut(false).build();
}
