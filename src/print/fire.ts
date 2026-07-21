/**
 * Auto-print-on-fire. Triggered implicitly by the bridge POS handlers after a
 * successful order write. Shares renderJob + the printed_jobs ledger with the
 * cloud poll path (one print path, two triggers). Never throws to the caller.
 */
import { renderJob, renderContextFromPrinter } from "../render";
import { deliverToPrinter } from "../deliver";
import { hasPrinted, markPrinted } from "../store/print-ledger";
import { recordResult } from "../health";
import { logger } from "../logger";
import { resolveKotTargets, resolveReceiptTarget, type ResolvedTarget } from "./router";
import { buildKotInput, buildReceiptInput, kotJobId, receiptJobId } from "./render-map";
import type { ItemRow as pr_ItemRow } from "./render-map";
import * as pr from "../store/print-repo";

function fmtTime(ms: number): { time: string; date: string } {
  const d = new Date(ms);
  return {
    time: d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" }),
    date: d.toLocaleDateString("en-GB"),
  };
}

async function deliverOnce(jobId: string, target: ResolvedTarget, bytes: Buffer, label: string): Promise<void> {
  if (hasPrinted(jobId)) {
    logger.info(`[fire] ${jobId} already printed — skipping (dedup)`);
    return;
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
      logger.warn(`[fire] ${label} used FALLBACK printer ${target.printer.printerId} — routing incomplete`);
    }
  } catch (e) {
    logger.error(`[fire] ${label} delivery failed on ${target.printer.printerId}: ${(e as Error).message}`);
    recordResult({
      printerId: target.printer.printerId,
      printerName: target.printer.name,
      kind: label.startsWith("KOT") ? "kot" : "receipt",
      ok: false,
      error: (e as Error).message,
    });
  }
}

async function fireKotsForItems(orderId: string, items: pr_ItemRow[]): Promise<void> {
  if (items.length === 0) return;
  const order = pr.getOrderRow(orderId);
  if (!order) return;
  const printers = pr.getMirroredPrinters();
  const routes = pr.getMirroredRoutes();
  const ft = order.source || "dine_in";
  const tableName = pr.getTableName(order.table_id ?? undefined);
  const { time, date } = fmtTime(order.created_at || Date.now());

  const byStation = new Map<string | null, pr_ItemRow[]>();
  for (const it of items) {
    const key = it.station_id ?? null;
    const arr = byStation.get(key);
    if (arr) arr.push(it);
    else byStation.set(key, [it]);
  }

  let seq = Date.now();
  for (const [stationId, stationItems] of byStation) {
    const targets = resolveKotTargets(printers, routes, ft, stationId);
    if (targets.length === 0) {
      logger.error(`[fire] order ${orderId} station ${stationId}: NO active printers — cannot print KOT`);
      continue;
    }
    const station = pr.getStation(stationId);
    const input = buildKotInput(order, stationItems, station, tableName, time, date);
    const bytes = renderJob({ kind: "kot", input }, renderContextFromPrinter(targets[0].printer));
    const jobId = kotJobId(orderId, stationId, seq++);
    for (const target of targets) {
      await deliverOnce(`${jobId}:${target.printer.printerId}`, target, bytes, `KOT ${orderId}/${stationId}`);
    }
    pr.markItemsFired(stationItems.map((i) => i.id));
  }
}

export async function fireOnCreate(orderId: string): Promise<void> {
  try {
    await fireKotsForItems(orderId, pr.getUnfiredItems(orderId));
  } catch (e) {
    logger.error(`[fire] fireOnCreate ${orderId}: ${(e as Error).message}`);
  }
}

export async function fireOnAddItem(orderId: string): Promise<void> {
  try {
    await fireKotsForItems(orderId, pr.getUnfiredItems(orderId));
  } catch (e) {
    logger.error(`[fire] fireOnAddItem ${orderId}: ${(e as Error).message}`);
  }
}

export async function fireReceipt(orderId: string, paymentId: string): Promise<void> {
  try {
    const order = pr.getOrderRow(orderId);
    if (!order) return;
    const printers = pr.getMirroredPrinters();
    const routes = pr.getMirroredRoutes();
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
    const input = buildReceiptInput(order, items, payments, branding, time, date, tableName);
    const bytes = renderJob({ kind: "receipt", input }, renderContextFromPrinter(target.printer));
    await deliverOnce(receiptJobId(orderId, paymentId), target, bytes, `receipt ${orderId}`);
  } catch (e) {
    logger.error(`[fire] fireReceipt ${orderId}: ${(e as Error).message}`);
  }
}

/** Explicit reprint — BYPASSES printed_jobs (for jams). Renders + delivers once. */
export async function reprintReceipt(orderId: string): Promise<{ ok: boolean; error?: string }> {
  const order = pr.getOrderRow(orderId);
  if (!order) return { ok: false, error: "order not found" };
  const target = resolveReceiptTarget(pr.getMirroredPrinters(), pr.getMirroredRoutes(), order.source || "dine_in");
  if (!target) return { ok: false, error: "no active printer" };
  const branding = pr.getBranding();
  const { time, date } = fmtTime(Date.now());
  const input = buildReceiptInput(order, pr.getOrderItems(orderId), [], branding, time, date, pr.getTableName(order.table_id ?? undefined));
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
  const items = pr.getOrderItems(orderId).filter((i) => (i.station_id ?? null) === stationId);
  if (items.length === 0) return { ok: false, error: "no items for station" };
  const targets = resolveKotTargets(pr.getMirroredPrinters(), pr.getMirroredRoutes(), order.source || "dine_in", stationId);
  if (targets.length === 0) return { ok: false, error: "no active printer" };
  const station = pr.getStation(stationId);
  const { time, date } = fmtTime(order.created_at || Date.now());
  const input = buildKotInput(order, items, station, pr.getTableName(order.table_id ?? undefined), time, date);
  input.version = 2;
  const bytes = renderJob({ kind: "kot", input }, renderContextFromPrinter(targets[0].printer));
  try {
    await deliverToPrinter(targets[0].printer, bytes);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}
