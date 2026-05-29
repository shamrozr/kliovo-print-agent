import http from "http";
import { loadConfig } from "./config";
import { deliverToPrinter } from "./deliver";
import { renderJob, type PrintJobData } from "./render";
import { logger } from "./logger";

export const BRIDGE_PORT = 6310;

// ── Idempotency guard ────────────────────────────────────────
// A POS may re-send a job on retry (flaky network, reconnect). We dedup on
// an idempotency key so the same ticket never prints twice within the window.
const DEDUP_TTL_MS = 60_000;
const recentJobs = new Map<string, number>();

function seenRecently(key: string): boolean {
  const now = Date.now();
  for (const [k, ts] of recentJobs) {
    if (now - ts > DEDUP_TTL_MS) recentJobs.delete(k);
  }
  if (recentJobs.has(key)) return true;
  recentJobs.set(key, now);
  return false;
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

export let appVersion = "1.0.0";
export function setAppVersion(v: string) { appVersion = v; }

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin":          "*",
  "Access-Control-Allow-Methods":         "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers":         "Content-Type",
  "Access-Control-Allow-Private-Network": "true",
};

async function ackJob(serverUrl: string, printJobId: string): Promise<void> {
  try {
    await fetch(`${serverUrl}/api/print/${printJobId}`, {
      method:  "PATCH",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ action: "ack" }),
    });
  } catch (e) {
    logger.warn(`[bridge] ack failed for ${printJobId}: ${(e as Error).message}`);
  }
}

export function startBridgeServer(): http.Server {
  const server = http.createServer((req, res) => {
    if (req.method === "OPTIONS") {
      res.writeHead(204, CORS_HEADERS);
      res.end();
      return;
    }

    const send = (status: number, body: object) => {
      res.writeHead(status, { ...CORS_HEADERS, "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    };

    if (req.method === "GET" && req.url === "/ping") {
      const config = loadConfig();
      send(200, {
        ok:       true,
        version:  appVersion,
        printers: config.printers.map((p) => p.printerId),
      });
      return;
    }

    if (req.method === "POST" && req.url === "/print") {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", async () => {
        try {
          const { printJobId, printerId, bytesBase64 } = JSON.parse(body) as {
            printJobId?: string;
            printerId:   string;
            bytesBase64: string;
          };

          const config = loadConfig();
          const pc = config.printers.find((p) => p.printerId === printerId);
          if (!pc) {
            logger.warn(`[bridge] unknown printer: ${printerId}`);
            send(404, { ok: false, error: `Printer ${printerId} not in config` });
            return;
          }

          const bytes = Buffer.from(bytesBase64, "base64");
          await deliverToPrinter(pc, bytes);
          logger.info(`[bridge] printed job ${printJobId ?? "?"} on ${printerId}`);

          if (printJobId) void ackJob(config.serverUrl, printJobId);

          send(200, { ok: true });
        } catch (e) {
          logger.error(`[bridge] print error: ${(e as Error).message}`);
          send(500, { ok: false, error: (e as Error).message });
        }
      });
      return;
    }

    // ── Offline path: render a STRUCTURED job locally, then print ──────────
    // No server round-trip needed. The POS posts a serializable PrintJobData
    // (built from its own cache); the agent renders ESC/POS here and streams
    // it to the printer. This is what keeps printing alive with no internet.
    if (req.method === "POST" && req.url === "/render-print") {
      readBody(req).then(async (raw) => {
        try {
          const { printJobId, printerId, idempotencyKey, job } = JSON.parse(raw) as {
            printJobId?:     string;
            printerId:       string;
            idempotencyKey?: string;
            job:             PrintJobData;
          };

          if (!printerId || !job || !job.kind) {
            send(400, { ok: false, error: "printerId and job{kind,input} are required" });
            return;
          }

          const dedupKey = idempotencyKey ?? printJobId;
          if (dedupKey && seenRecently(dedupKey)) {
            logger.info(`[bridge] dedup — skipped duplicate job ${dedupKey}`);
            send(200, { ok: true, deduped: true });
            return;
          }

          const config = loadConfig();
          const pc = config.printers.find((p) => p.printerId === printerId);
          if (!pc) {
            logger.warn(`[bridge] render-print: unknown printer ${printerId}`);
            send(404, { ok: false, error: `Printer ${printerId} not in config` });
            return;
          }

          // The agent's local config is the source of truth for hardware width.
          const bytes = renderJob(job, pc.paperWidth);
          await deliverToPrinter(pc, bytes);
          logger.info(`[bridge] rendered+printed ${job.kind} job ${printJobId ?? dedupKey ?? "?"} on ${printerId}`);

          if (printJobId) void ackJob(config.serverUrl, printJobId);

          send(200, { ok: true, rendered: true });
        } catch (e) {
          logger.error(`[bridge] render-print error: ${(e as Error).message}`);
          send(500, { ok: false, error: (e as Error).message });
        }
      });
      return;
    }

    send(404, { ok: false, error: "Not found" });
  });

  server.listen(BRIDGE_PORT, "127.0.0.1", () => {
    logger.info(`[bridge] listening on http://127.0.0.1:${BRIDGE_PORT}`);
  });

  return server;
}
