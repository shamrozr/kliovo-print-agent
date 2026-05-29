/**
 * Master KOT — consolidated kitchen ticket for the expo/assembler.
 *
 * Per DECISIONS D11.3: assemblers / expo need a single view of every
 * item across all stations so they can plate and call the table when
 * each station's items arrive. Items are grouped by station.
 */

import { ESCPOSBuilder, CP_WPC1256 } from "../builder";
import type { PaperWidth } from "./receipt";
import type { KotItem } from "./kot";

export interface MasterKotStationGroup {
  stationName: string;
  stationEmoji?: string;
  items: KotItem[];
}

export interface MasterKotInput {
  paperWidth?: PaperWidth;
  referenceNumber: string;
  tableName?: string;
  guestName?: string;
  serverName?: string;
  orderType?: string;
  fireTime: string;
  fireDate?: string;
  covers?: number;
  /** Pre-formatted course callout, e.g. "Course 1 / 3" */
  courseLabel?: string;
  groups: MasterKotStationGroup[];
  version?: number;
}

export function renderMasterKot(input: MasterKotInput): Buffer {
  const pw: PaperWidth = input.paperWidth === 58 ? 58 : 80;
  const b = new ESCPOSBuilder().init().codePage(CP_WPC1256);

  // ── Header ────────────────────────────────────────────────
  b.align("center").size("xlarge").bold(true).line("MASTER KOT").bold(false).size("normal");
  b.rule(pw, "=");

  // ── Meta ──────────────────────────────────────────────────
  b.align("left").size("large").bold(true).line(input.referenceNumber).bold(false).size("normal");
  if (input.tableName) b.row("Table", input.tableName, pw);
  if (input.guestName) b.row("Guest", input.guestName, pw);
  if (input.serverName) b.row("Server", input.serverName, pw);
  if (input.covers) b.row("Covers", String(input.covers), pw);
  if (input.orderType) b.row("Type", input.orderType.toUpperCase(), pw);
  if (input.courseLabel) b.row("Course", input.courseLabel, pw);
  b.row("Fired", `${input.fireDate ? input.fireDate + " " : ""}${input.fireTime}`, pw);

  b.rule(pw);

  // ── Per-station blocks ────────────────────────────────────
  for (const group of input.groups) {
    b.bold(true).line(`-- ${group.stationEmoji ? group.stationEmoji + " " : ""}${group.stationName.toUpperCase()} --`).bold(false);

    for (const item of group.items) {
      b.size("large").bold(true).line(`${item.quantity} x ${item.name}`).bold(false).size("normal");
      if (item.nameAlt) b.line(`  ${item.nameAlt}`);
      for (const mod of item.modifiers ?? []) b.line(`  + ${mod.name}`);
      if (item.notes) b.bold(true).line(`  ! ${item.notes}`).bold(false);
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
