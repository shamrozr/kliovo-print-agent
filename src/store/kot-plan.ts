/**
 * Pure readers for the frozen per-line KOT plan. NO imports beyond types — the
 * print path (render-map, router) must stay loadable without electron, which is
 * what keeps its unit tests honest. The DB-backed resolver lives next door in
 * kot-routing.ts.
 *
 * MIRRORS Kliovo-Dine/src/lib/print/kot-scope.ts. Keep the two readable side by
 * side: the questions they answer (which stations get a ticket, what goes on one)
 * must be answered identically online and offline.
 */

/** An add-on that cuts its own kitchen line, and where. */
export interface KotRoutedAddon {
  name: string;
  stations: string[];
}

/** Frozen per-line render plan. Stored on order_items.kot_routing. */
export interface KotRoutingSnapshot {
  /** Stations the line itself prints at. */
  item: string[];
  /** Own-line add-ons. Add-ons NOT listed here ride under the item. */
  addons: KotRoutedAddon[];
  /**
   * "Never print a kitchen ticket for this line." Distinct from an empty
   * `item`, which means unrouted and lands on the catch-all slip. Suppression
   * removes the line from EVERY ticket, catch-all included.
   *
   * Paper only — the line still shows on screens and on the receipt.
   */
  suppressed?: boolean;
}

export function uniqStations(values: Array<string | null | undefined>): string[] {
  return Array.from(new Set(values.filter((v): v is string => !!v)));
}

export function parseStations(raw: unknown): string[] {
  try {
    const a = JSON.parse((raw as string) || "[]");
    return Array.isArray(a) ? uniqStations(a.map((s) => (typeof s === "string" ? s : null))) : [];
  } catch {
    return [];
  }
}

/** Row shape the print path sees (snake_case, straight off order_items). */
export interface RoutedItemRow {
  station_id?: string | null;
  station_ids?: string | null; // JSON string[]
  kot_routing?: string | null; // JSON KotRoutingSnapshot
}

/**
 * Read a line's frozen plan. Lines written before the router existed carry no
 * snapshot — fall back to the single station they were stamped with, so an order
 * that was live across the update still tickets correctly.
 */
export function readKotRouting(item: RoutedItemRow): KotRoutingSnapshot {
  try {
    const raw = item.kot_routing ? (JSON.parse(item.kot_routing) as KotRoutingSnapshot) : null;
    if (raw && Array.isArray(raw.item)) {
      return {
        item: uniqStations(raw.item),
        addons: Array.isArray(raw.addons) ? raw.addons : [],
        suppressed: raw.suppressed === true,
      };
    }
  } catch {
    /* fall through to the legacy single-station read */
  }
  const ids = parseStations(item.station_ids);
  const stations = ids.length ? ids : item.station_id ? [item.station_id] : [];
  return { item: stations, addons: [] };
}

/** Every station a line touches — item stations and own-line add-on stations alike. */
export function stationsOnLine(item: RoutedItemRow): string[] {
  const ids = parseStations(item.station_ids);
  if (ids.length) return ids;
  const plan = readKotRouting(item);
  return uniqStations([...plan.item, ...plan.addons.flatMap((a) => a.stations)]);
}

/**
 * Barred from paper. Read from the line's OWN frozen snapshot, never re-resolved:
 * suppressing an item next week must not retroactively blank a ticket that already
 * printed, and un-suppressing it must not make an old ticket reappear.
 */
export function isKotSuppressed(item: RoutedItemRow): boolean {
  return readKotRouting(item).suppressed === true;
}

/**
 * Add-ons that cut their OWN line on this station's ticket. An add-on can be
 * routed to a station its base item never reaches — extra cheese at the pizza
 * bench while the burger it sits on belongs at the fryer — which is the whole
 * reason the plan is stored per line instead of derived from the item.
 *
 * Mirrors ownAddonsOnScope() in Kliovo-Dine/src/lib/print/kot-scope.ts.
 */
export function ownAddonsOnStation(item: RoutedItemRow, stationId: string | null): string[] {
  if (stationId === null) return [];
  const plan = readKotRouting(item);
  // An own-line add-on must not smuggle a suppressed item onto a slip.
  if (plan.suppressed) return [];
  return plan.addons.filter((a) => a.stations.includes(stationId)).map((a) => a.name);
}

/** Names of every add-on on this line that prints as its own line SOMEWHERE. */
export function ownAddonNames(item: RoutedItemRow): Set<string> {
  return new Set(readKotRouting(item).addons.map((a) => a.name));
}

/**
 * Does the ITEM line itself belong on this station's ticket? An unrouted line
 * (no stations at all) belongs on the catch-all slip — station null — which is
 * the offline equivalent of the cloud's `kitchen_ticket:none`.
 */
export function printsItemAtStation(item: RoutedItemRow, stationId: string | null): boolean {
  const plan = readKotRouting(item);
  if (plan.suppressed) return false;
  return plan.item.length === 0 ? stationId === null : plan.item.includes(stationId ?? "");
}

/**
 * Sub-line modifiers for a line on a ticket, own-line add-ons removed — so the
 * same add-on is never both a sub-line under its item and a line of its own.
 */
export function ridingModifiers(
  item: RoutedItemRow,
  modifiers: Array<{ name?: string | null }>
): Array<{ name: string }> {
  const own = ownAddonNames(item);
  return modifiers
    .map((m) => ({ name: (m?.name ?? "").toString().trim() }))
    .filter((m) => m.name.length > 0 && !own.has(m.name));
}
