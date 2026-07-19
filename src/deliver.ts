/**
 * Single point of delivery for rendered ESC/POS bytes. Routes a job to the
 * right transport based on the printer's `connection` type so callers
 * (bridge endpoints, test print, polling) never branch on it themselves.
 */
import type { PrinterEntry } from "./config";
import { deliverRawWithRetry } from "./tcp-sender";
import { sendRawToSystemPrinter } from "./system-printer";

export async function deliverToPrinter(pc: PrinterEntry, bytes: Buffer): Promise<void> {
  if (pc.connection === "system") {
    await sendRawToSystemPrinter(pc.systemPrinterName ?? "", bytes);
    return;
  }
  // Default / "network": TCP socket to the printer (port 9100 unless set).
  // deliverRawWithRetry only retries pre-connect failures (see tcp-sender.ts)
  // so we never risk double-printing a partially/fully delivered job.
  await deliverRawWithRetry(pc.host, pc.port || 9100, bytes);
}
