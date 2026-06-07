/**
 * Single point of delivery for rendered ESC/POS bytes. Routes a job to the
 * right transport based on the printer's `connection` type so callers
 * (bridge endpoints, test print, polling) never branch on it themselves.
 */
import type { PrinterEntry } from "./config";
import { sendRawToPrinter } from "./tcp-sender";
import { sendRawToSystemPrinter } from "./system-printer";
import { sendRawToUsbDevice } from "./usb-raw-printer";

export async function deliverToPrinter(pc: PrinterEntry, bytes: Buffer): Promise<void> {
  if (pc.connection === "usb_raw") {
    await sendRawToUsbDevice(pc.usbDevicePath ?? "", bytes);
    return;
  }
  if (pc.connection === "system") {
    await sendRawToSystemPrinter(pc.systemPrinterName ?? "", bytes);
    return;
  }
  // Default / "network": TCP socket to the printer (port 9100 unless set).
  await sendRawToPrinter(pc.host, pc.port || 9100, bytes);
}
