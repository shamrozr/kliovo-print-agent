/**
 * Offline Ticket Router — the agent's single reader of "which station(s) does
 * this line print at, and may it print at all".
 *
 * MIRRORS Kliovo-Dine/src/services/kot-routing.service.ts, but deliberately does
 * NOT re-implement it. The cloud resolves the precedence rules (item "block"
 * beats its category, item "allow" opts out of a category "never") and ships the
 * ANSWER per menu item in `menu_item_routing`. This file only reads that answer,
 * folds in the flat modifier→station map, and freezes the plan onto the line.
 *
 * Why not resolve here: precedence implemented twice is the exact drift the
 * Ticket Router was written to fix in the cloud (two routing stores, the screen
 * showing the one the kitchen was NOT following). One resolver, one answer.
 *
 * Pure apart from three indexed reads — no printing, no I/O.
 */
import { getStore } from "./db";
import {
  parseStations,
  uniqStations,
  type KotRoutedAddon,
  type KotRoutingSnapshot,
} from "./kot-plan";

export * from "./kot-plan";

export interface KotRoutingInput {
  menuItemId?: string | null;
  modifiers?: Array<{ modifierId?: string | null; id?: string | null; name?: string | null }>;
  /** Per-line hint from the client; used only when the router has nothing to say. */
  fallbackStationId?: string | null;
}

export interface KotRoutingResult {
  /** Union of item stations and own-line add-on stations — what the fire path groups by. */
  stationIds: string[];
  /** First item station, kept on order_items.station_id for the KDS + reporting. */
  primaryStationId: string | null;
  routing: KotRoutingSnapshot | null;
}

interface ItemRoutingRow {
  stations: string[];
  suppressed: boolean;
}

/** The mirrored answer for one menu item, or null when the cloud shipped none. */
function readItemRouting(menuItemId: string | null | undefined): ItemRoutingRow | null {
  if (!menuItemId) return null;
  const row = getStore()
    .prepare("SELECT stations, suppressed FROM menu_item_routing WHERE menu_item_id = ?")
    .get(menuItemId) as { stations?: string; suppressed?: number } | undefined;
  if (!row) return null;
  return { stations: parseStations(row.stations), suppressed: row.suppressed === 1 };
}

function readModifierStations(modifierId: string): string[] {
  const row = getStore()
    .prepare("SELECT stations FROM modifier_routing WHERE modifier_id = ?")
    .get(modifierId) as { stations?: string } | undefined;
  return row ? parseStations(row.stations) : [];
}

/**
 * Resolve one line. Never throws — a routing table that isn't warm yet (fresh
 * install, older server) must degrade to the pre-router behaviour (the client's
 * station hint), not to "no ticket".
 */
export function resolveLineRouting(input: KotRoutingInput): KotRoutingResult {
  let item: ItemRoutingRow | null = null;
  try {
    item = readItemRouting(input.menuItemId);
  } catch {
    item = null;
  }

  // Suppression short-circuits everything, add-ons included: if the kitchen is
  // never to see this line on paper, an own-line add-on hanging off it must not
  // smuggle it onto a slip.
  if (item?.suppressed) {
    return { stationIds: [], primaryStationId: null, routing: { item: [], addons: [], suppressed: true } };
  }

  let itemStations = item?.stations ?? [];
  // Nothing configured anywhere → honour the client's hint. Keeps a branch whose
  // tenant has never opened the Ticket Router printing exactly as it did before.
  if (itemStations.length === 0 && input.fallbackStationId) {
    itemStations = [input.fallbackStationId];
  }

  const addons: KotRoutedAddon[] = [];
  for (const m of input.modifiers ?? []) {
    const modifierId = m.modifierId ?? m.id ?? null;
    if (!modifierId) continue;
    let stations: string[] = [];
    try {
      stations = readModifierStations(modifierId);
    } catch {
      stations = [];
    }
    if (stations.length === 0) continue; // rides with its item
    addons.push({ name: (m.name ?? "").trim() || "Add-on", stations });
  }

  return {
    stationIds: uniqStations([...itemStations, ...addons.flatMap((a) => a.stations)]),
    primaryStationId: itemStations[0] ?? null,
    routing: itemStations.length === 0 && addons.length === 0 ? null : { item: itemStations, addons },
  };
}

