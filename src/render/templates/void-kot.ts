/**
 * Void KOT — printed when an item is voided after fire.
 *
 * Loud, inverted "VOID" header so the kitchen never confuses it with a
 * normal ticket. Shows the original reference and which item to pull,
 * along with reason + who authorised the void.
 */

import { ESCPOSBuilder, CP_WPC1256 } from "../builder";
import type { PaperWidth } from "./receipt";

export interface VoidKotItem {
  name: string;
  quantity: number;
  modifiers?: { name: string }[];
}

export interface VoidKotInput {
  paperWidth?: PaperWidth;
  referenceNumber: string;
  stationName?: string;
  tableName?: string;
  serverName?: string;
  authorisedBy?: string;
  reason?: string;
  /** Pre-formatted void time */
  voidTime: string;
  voidDate?: string;
  items: VoidKotItem[];
}

export function renderVoidKot(input: VoidKotInput): Buffer {
  const pw: PaperWidth = input.paperWidth === 58 ? 58 : 80;
  const b = new ESCPOSBuilder().init().codePage(CP_WPC1256);

  // Loud header — inverted + xlarge
  b.align("center").invert(true).size("xlarge").bold(true);
  b.line("  V O I D  ");
  b.bold(false).size("normal").invert(false);
  b.rule(pw, "=");

  b.align("left").bold(true).line(input.referenceNumber).bold(false);
  if (input.stationName) b.row("Station", input.stationName, pw);
  if (input.tableName) b.row("Table", input.tableName, pw);
  if (input.serverName) b.row("Server", input.serverName, pw);
  if (input.authorisedBy) b.row("Authorised", input.authorisedBy, pw);
  b.row("Voided", `${input.voidDate ? input.voidDate + " " : ""}${input.voidTime}`, pw);

  b.rule(pw);
  b.bold(true).line("PULL THESE ITEMS:").bold(false);
  for (const item of input.items) {
    b.size("large").bold(true).line(`${item.quantity} x ${item.name}`).bold(false).size("normal");
    for (const mod of item.modifiers ?? []) b.line(`  + ${mod.name}`);
  }

  if (input.reason) {
    b.rule(pw);
    b.bold(true).line("Reason:").bold(false);
    b.line(input.reason);
  }

  b.rule(pw, "=");
  b.align("center").size("small").line("─────────────────────").line("Powered by Kliovo Dine").size("normal");

  return b.feed(2).cut(false).build();
}
