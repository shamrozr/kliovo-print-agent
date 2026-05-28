import http from "http";
import { loadConfig } from "./config";
import { sendRawToPrinter } from "./tcp-sender";
import { logger } from "./logger";

export const BRIDGE_PORT = 6310;

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
          await sendRawToPrinter(pc.host, pc.port || 9100, bytes);
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

    send(404, { ok: false, error: "Not found" });
  });

  server.listen(BRIDGE_PORT, "127.0.0.1", () => {
    logger.info(`[bridge] listening on http://127.0.0.1:${BRIDGE_PORT}`);
  });

  return server;
}
