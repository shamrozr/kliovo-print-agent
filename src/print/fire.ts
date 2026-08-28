/**
 * Auto-print-on-fire. Triggered implicitly by the bridge POS handlers after a
 * successful order write. Shares renderJob + the printed_jobs ledger with the
 * cloud poll path (one print path, two triggers). Never throws to the caller.
 */
import { renderJob, renderContextFromPrinter } from "../render";
import { deliverToPrinter } from "../deliver";
import { hasPrinted, markPrinted } from "../store/print-ledger";
import { recordResult, recordFallbackRoute } from "../health";
import { logger } from "../logger";
import { resolveKotTargets, resolveReceiptTarget, type ResolvedTarget } from "./router";
import { buildKotInput, buildReceiptInput, kotJobId, receiptJobId } from "./render-map";
import type { ItemRow as pr_ItemRow } from "./render-map";
import { loadReceiptLogo } from "./logo";
import * as pr from "../store/print-repo";
import { isKotSuppressed, stationsOnLine } from "../store/kot-plan";

/** Shared receipt options: mirrored designer template + locally-loaded logo. */
function receiptExtras(paperWidth: 80 | 58) {
  return { layoutConfig: pr.getPrintTemplate("receipt") ?? undefined, rasterLogo: loadReceiptLogo(paperWidth) ?? undefined };
}

function fmtTime(ms: number): { time: string; date: string } {
  const d = new Date(ms);
  return {
    time: d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" }),
    date: d.toLocaleDateString("en-GB"),
  };
}

/** Returns true if the ticket reached paper (or was already printed), false if
 *  delivery failed. Callers use this to decide whether to mark items fired — a
 *  failed fire must stay retryable so a transiently-dead printer never silently
 *  drops a real ticket. */
async function deliverOnce(jobId: string, target: ResolvedTarget, bytes: Buffer, label: string): Promise<boolean> {
  if (hasPrinted(jobId)) {
    logger.info(`[fire] ${jobId} already printed — skipping (dedup)`);
    return true;
  }
  try {
    for (let i = 0; i < target.copies; i++) {
      await deliverToPrinter(target.printer, bytes);
    }
    markPrinted(jobId, target.printer.printerId, target.printer.agentKey);
    recordResult({
      printerId: target.printer.printerId,
      printerName: target.printer.name,
      kind: label.startsWith("KOT") ? "kot" : "receipt",
      ok: true,
    });
    if (target.fallback) {
      recordFallbackRoute({ label, printerId: target.printer.printerId });
    }
    return true;
  } catch (e) {
    logger.error(`[fire] ${label} delivery failed on ${target.printer.printerId}: ${(e as Error).message}`);
    recordResult({
      printerId: target.printer.printerId,
      printerName: target.printer.name,
      kind: label.startsWith("KOT") ? "kot" : "receipt",
      ok: false,
      error: (e as Error).message,
    });
    return false;
  }
}

async function fireKotsForItems(orderId: string, items: pr_ItemRow[]): Promise<void> {
  if (items.length === 0) return;
  const order = pr.getOrderRow(orderId);
  if (!order) return;
  const printers = pr.getResolvablePrinters();
  const routes = pr.getEffectiveRoutes();
  const ft = order.source || "dine_in";
  const tableName = pr.getTableName(order.table_id ?? undefined);
  const { time, date } = fmtTime(order.created_at || Date.now());

  // A line fans out to EVERY station on its frozen plan — its own stations plus
  // the stations of any add-on that cuts its own line. Grouping by the single
  // station_id (what this did before the Ticket Router) printed a two-station
  // item once, at whichever station happened to be first.
  //
  // Suppressed lines are dropped here AND filtered again inside buildKotInput:
  // the two answer different questions (how many tickets to cut vs. what goes on
  // one), and a line that slipped past only one would print on a ticket cut for
  // something else.
  const byStation = new Map<string | null, pr_ItemRow[]>();
  const stationsPerItem = new Map<string, string[]>();
  const push = (key: string | null, it: pr_ItemRow) => {
    const arr = byStation.get(key);
    if (arr) arr.push(it);
    else byStation.set(key, [it]);
  };
  const suppressed: pr_ItemRow[] = [];
  for (const it of items) {
    if (isKotSuppressed(it)) {
      suppressed.push(it);
      continue;
    }
    const stations = stationsOnLine(it);
    stationsPerItem.set(it.id, stations);
    // No station anywhere → the catch-all slip, which the operator's local
    // wildcard route sends to the kitchen rather than the cashier.
    if (stations.length === 0) push(null, it);
    else for (const st of stations) push(st, it);
  }

  // Nothing to print is a valid outcome (a whole round of suppressed lines), and
  // those lines must still be marked fired or every later add-item retries them.
  if (suppressed.length > 0) {
    logger.info(`[fire] order ${orderId}: ${suppressed.length} line(s) suppressed — no kitchen ticket by configuration`);
    pr.markItemsFired(suppressed.map((i) => i.id));
  }
  if (byStation.size === 0) return;

  // Per-line delivery outcome. A line at two stations is only fired once BOTH
  // tickets hit paper — a partial fire must stay retryable so a transiently dead
  // station printer never silently drops half the order.
  const failedItems = new Set<string>();

  let seq = Date.now();
  for (const [stationId, stationItems] of byStation) {
    const targets = resolveKotTargets(printers, routes, ft, stationId);
    // Routing trace — makes "why did this KOT go to the cashier?" answerable from
    // the log alone: shows the station, how many routes were available, the chosen
    // printer, and whether it was a real match or the default fallback.
    logger.info(
      `[fire] KOT route: order=${orderId} station=${stationId ?? "∅(unrouted)"} items=${stationItems.length} ` +
        `routes=${routes.length} → ${targets.map((t) => `${t.printer.name}${t.fallback ? "(FALLBACK)" : ""}`).join(", ") || "NONE"}`
    );
    if (targets.length === 0) {
      logger.error(`[fire] order ${orderId} station ${stationId}: NO active printers — cannot print KOT`);
      stationItems.forEach((i) => failedItems.add(i.id));
      continue;
    }
    const station = stationId ? pr.getStation(stationId) : null;
    const input = buildKotInput(order, stationItems, station, tableName, time, date, stationId);
    // A station can end up with nothing to show when every line reaching it does
    // so only through an add-on that another station owns. Cutting blank paper
    // reads as a lost ticket, so skip it.
    if (input.items.length === 0) {
      logger.info(`[fire] order ${orderId} station ${stationId ?? "∅"}: no printable lines — skipping ticket`);
      continue;
    }
    const bytes = renderJob({ kind: "kot", input }, renderContextFromPrinter(targets[0].printer));
    const jobId = kotJobId(orderId, stationId, seq++);
    let anyDelivered = false;
    for (const target of targets) {
      const ok = await deliverOnce(`${jobId}:${target.printer.printerId}`, target, bytes, `KOT ${orderId}/${stationId}`);
      anyDelivered = anyDelivered || ok;
    }
    if (!anyDelivered) {
      logger.error(`[fire] order ${orderId} station ${stationId}: KOT delivery failed on all targets — items left unfired for retry`);
      stationItems.forEach((i) => failedItems.add(i.id));
    }
  }

  const fired = items.filter((i) => stationsPerItem.has(i.id) && !failedItems.has(i.id)).map((i) => i.id);
  if (fired.length > 0) pr.markItemsFired(fired);
}

export async function fireOnCreate(orderId: string): Promise<void> {
  try {
    await fireKotsForItems(orderId, pr.getUnfiredItems(orderId));
  } catch (e) {
    logger.error(`[fire] fireOnCreate ${orderId}: ${(e as Error).message}`);
  }
}

export async function fireOnAddItem(orderId: string, addedItemId?: string): Promise<void> {
  try {
    const unfired = pr.getUnfiredItems(orderId);
    // Fire ONLY the line just added — never re-fire earlier items (which would
    // reprint the whole running order's KOT). Fall back to all-unfired only when
    // the caller didn't tell us which item was added.
    const items = addedItemId ? unfired.filter((i) => i.id === addedItemId) : unfired;
    await fireKotsForItems(orderId, items);
  } catch (e) {
    logger.error(`[fire] fireOnAddItem ${orderId}: ${(e as Error).message}`);
  }
}

export async function fireReceipt(orderId: string, paymentId: string): Promise<void> {
  try {
    const order = pr.getOrderRow(orderId);
    if (!order) return;
    const printers = pr.getResolvablePrinters();
    const routes = pr.getEffectiveRoutes();
    const target = resolveReceiptTarget(printers, routes, order.source || "dine_in");
    if (!target) {
      logger.error(`[fire] order ${orderId}: NO active printers — cannot print receipt`);
      return;
    }
    const items = pr.getOrderItems(orderId);
    const pay = pr.getPayment(orderId, paymentId);
    const payments = pay ? [{ method: pay.method, amount: pay.amount, tip: pay.tip }] : [];
    const branding = pr.getBranding();
    const { time, date } = fmtTime(Date.now());
    const tableName = pr.getTableName(order.table_id ?? undefined);
    const input = buildReceiptInput(order, items, payments, branding, time, date, tableName, receiptExtras(target.printer.paperWidth));
    const bytes = renderJob({ kind: "receipt", input }, renderContextFromPrinter(target.printer));
    await deliverOnce(receiptJobId(orderId, paymentId), target, bytes, `receipt ${orderId}`);
  } catch (e) {
    logger.error(`[fire] fireReceipt ${orderId}: ${(e as Error).message}`);
  }
}

/** Print the customer receipt (unpaid bill) when the order is punched — the
 *  customer copy staff hand over at order time, before payment. Separate ledger
 *  id from the paid receipt so both can print. */
export async function fireReceiptOnCreate(orderId: string): Promise<void> {
  try {
    const order = pr.getOrderRow(orderId);
    if (!order) return;
    const target = resolveReceiptTarget(pr.getResolvablePrinters(), pr.getEffectiveRoutes(), order.source || "dine_in");
    if (!target) {
      logger.error(`[fire] order ${orderId}: NO active printers — cannot print order receipt`);
      return;
    }
    const items = pr.getOrderItems(orderId);
    const branding = pr.getBranding();
    const { time, date } = fmtTime(Date.now());
    const tableName = pr.getTableName(order.table_id ?? undefined);
    const input = buildReceiptInput(order, items, [], branding, time, date, tableName, receiptExtras(target.printer.paperWidth));
    const bytes = renderJob({ kind: "receipt", input }, renderContextFromPrinter(target.printer));
    await deliverOnce(`OFF:${orderId}:receipt:create`, target, bytes, `receipt ${orderId}`);
  } catch (e) {
    logger.error(`[fire] fireReceiptOnCreate ${orderId}: ${(e as Error).message}`);
  }
}

/** Explicit reprint — BYPASSES printed_jobs (for jams). Renders + delivers once. */
export async function reprintReceipt(orderId: string): Promise<{ ok: boolean; error?: string }> {
  const order = pr.getOrderRow(orderId);
  if (!order) return { ok: false, error: "order not found" };
  const target = resolveReceiptTarget(pr.getResolvablePrinters(), pr.getEffectiveRoutes(), order.source || "dine_in");
  if (!target) return { ok: false, error: "no active printer" };
  const branding = pr.getBranding();
  const { time, date } = fmtTime(Date.now());
  const input = buildReceiptInput(order, pr.getOrderItems(orderId), [], branding, time, date, pr.getTableName(order.table_id ?? undefined), receiptExtras(target.printer.paperWidth));
  const bytes = renderJob({ kind: "receipt", input }, renderContextFromPrinter(target.printer));
  try {
    await deliverToPrinter(target.printer, bytes);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

/** Reprint a station's KOT for all its items — bypasses the ledger. */
export async function reprintKot(orderId: string, stationId: string | null): Promise<{ ok: boolean; error?: string }> {
  const order = pr.getOrderRow(orderId);
  if (!order) return { ok: false, error: "order not found" };
  // Filter by the frozen plan, not the single station_id mirror — otherwise a
  // reprint for a station the line reaches only via an add-on comes back empty.
  const items = pr
    .getOrderItems(orderId)
    .filter((i) => !isKotSuppressed(i))
    .filter((i) => (stationId === null ? stationsOnLine(i).length === 0 : stationsOnLine(i).includes(stationId)));
  if (items.length === 0) return { ok: false, error: "no items for station" };
  const targets = resolveKotTargets(pr.getResolvablePrinters(), pr.getEffectiveRoutes(), order.source || "dine_in", stationId);
  if (targets.length === 0) return { ok: false, error: "no active printer" };
  const station = stationId ? pr.getStation(stationId) : null;
  const { time, date } = fmtTime(order.created_at || Date.now());
  const input = buildKotInput(order, items, station, pr.getTableName(order.table_id ?? undefined), time, date, stationId);
  if (input.items.length === 0) return { ok: false, error: "no printable lines for station" };
  input.version = 2;
  const bytes = renderJob({ kind: "kot", input }, renderContextFromPrinter(targets[0].printer));
  try {
    await deliverToPrinter(targets[0].printer, bytes);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}
