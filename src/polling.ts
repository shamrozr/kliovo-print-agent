import { loadConfig, PrinterEntry } from "./config";
import { sendRawToPrinter } from "./tcp-sender";
import { logger } from "./logger";

const POLL_INTERVAL_MS    = 2_000;
const BACKOFF_INTERVAL_MS = 10_000;

async function pollPrinter(serverUrl: string, printer: PrinterEntry): Promise<void> {
  const url = `${serverUrl}/api/print/pending?printerId=${encodeURIComponent(printer.printerId)}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${printer.agentKey}` },
    signal:  AbortSignal.timeout(8_000),
  });

  if (res.status === 204) return; // Idle — no queued jobs
  if (!res.ok) {
    logger.warn(`[poll] ${printer.printerId} HTTP ${res.status}`);
    return;
  }

  const { printJobId, bytesBase64 } = (await res.json()) as {
    printJobId:  string;
    bytesBase64: string;
  };

  const bytes = Buffer.from(bytesBase64, "base64");
  await sendRawToPrinter(printer.host, printer.port || 9100, bytes);
  logger.info(`[poll] printed job ${printJobId} on ${printer.printerId}`);

  await fetch(`${serverUrl}/api/print/${printJobId}`, {
    method:  "PATCH",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify({ action: "ack" }),
  }).catch(() => {});
}

export function startPolling(): NodeJS.Timeout {
  let consecutiveErrors = 0;

  const tick = async () => {
    const config = loadConfig();
    if (config.printers.length === 0) return;

    try {
      await Promise.all(
        config.printers.map((p) =>
          pollPrinter(config.serverUrl, p).catch((e) => {
            consecutiveErrors++;
            logger.warn(`[poll] error for ${p.printerId}: ${(e as Error).message}`);
          })
        )
      );
      consecutiveErrors = 0;
    } catch (e) {
      logger.error(`[poll] tick error: ${(e as Error).message}`);
    }
  };

  let currentInterval = POLL_INTERVAL_MS;
  let timer = setTimeout(function run() {
    tick().finally(() => {
      currentInterval = consecutiveErrors > 5 ? BACKOFF_INTERVAL_MS : POLL_INTERVAL_MS;
      timer = setTimeout(run, currentInterval);
    });
  }, currentInterval);
  return timer;
}
