import http from "http";
import { loadConfig } from "./config";
import { deliverToPrinter } from "./deliver";
import { recordResult, getHealthSnapshot } from "./health";
import { hasPrinted, markPrinted } from "./store/print-ledger";
import { renderJob, renderContextFromPrinter, type PrintJobData } from "./render";
import { logger } from "./logger";
import {
  getPairingSecret,
  setPairingSecret,
  getStatus,
  getUnsynced,
  applyMirror,
  markSynced,
  setState,
} from "./store/repo";
import { handleAdmsRequest } from "./biometric/adms-receiver";
import { getQueueDepth } from "./biometric/attendance-store";
import { getLastSyncAt } from "./biometric/attendance-sync";
import { getDeviceStatuses } from "./biometric/zk-adapter";
import {
  authenticate,
  verifyToken,
  getMenu,
  getTables,
  getCombos,
  getPaymentConfig,
  listOrders,
  createOrder,
  addPayment,
  updateStatus,
  addItem,
  voidItem,
  refundPayment,
} from "./store/pos-repo";
import { fireOnCreate, fireOnAddItem, fireReceipt } from "./print/fire";

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
  "Access-Control-Allow-Headers":         "Content-Type, X-Agent-Secret, X-Aster-Token",
  "Access-Control-Allow-Private-Network": "true",
};

async function ackJob(serverUrl: string, printJobId: string, agentKey: string): Promise<void> {
  try {
    await fetch(`${serverUrl}/api/print/${printJobId}`, {
      method:  "PATCH",
      // Without a Bearer token the Dine ack route falls through to session auth
      // and 401s — the server then never learns the job was printed.
      headers: {
        "Content-Type":    "application/json",
        "Authorization":   `Bearer ${agentKey}`,
        "X-Agent-Version": appVersion,
      },
      body:    JSON.stringify({ action: "ack" }),
      signal:  AbortSignal.timeout(8000),
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

    // Health snapshot — lets the POS show "printed ✓ / failed ✗" and surface
    // recent activity without tailing the agent log.
    if (req.method === "GET" && req.url === "/status") {
      send(200, { ok: true, version: appVersion, ...getHealthSnapshot() });
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
            recordResult({ printerId: printerId ?? "?", printerName: printerId ?? "?", kind: "raw", ok: false, error: `Printer ${printerId} not in config` });
            send(404, { ok: false, error: `Printer ${printerId} not in config` });
            return;
          }

          // Ledger dedup — a redelivered push (server retried before it saw our
          // ack) must not print twice. Re-ack so the server closes the job out.
          if (printJobId && hasPrinted(printJobId)) {
            logger.info(`[bridge] ledger dedup — skipped duplicate job ${printJobId}`);
            void ackJob(config.serverUrl, printJobId, pc.agentKey);
            send(200, { ok: true, deduped: true });
            return;
          }

          logger.info(`[bridge] received raw job ${printJobId ?? "?"} for ${printerId}`);
          try {
            const bytes = Buffer.from(bytesBase64, "base64");
            await deliverToPrinter(pc, bytes);
            recordResult({ printerId, printerName: pc.name, kind: "raw", ok: true });
            // Record to the ledger BEFORE the ack — that ordering bounds the
            // crash window during which a redelivery could double-print.
            if (printJobId) markPrinted(printJobId, printerId, pc.agentKey);
            if (printJobId) void ackJob(config.serverUrl, printJobId, pc.agentKey);
            send(200, { ok: true });
          } catch (e) {
            recordResult({ printerId, printerName: pc.name, kind: "raw", ok: false, error: (e as Error).message });
            throw e;
          }
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
            recordResult({ printerId, printerName: printerId, kind: job.kind, ok: false, error: `Printer ${printerId} not in config` });
            send(404, { ok: false, error: `Printer ${printerId} not in config` });
            return;
          }

          // Ledger dedup — mirrors /print. The in-memory seenRecently() above
          // only guards a short window; the ledger survives restarts.
          if (printJobId && hasPrinted(printJobId)) {
            logger.info(`[bridge] ledger dedup — skipped duplicate job ${printJobId}`);
            void ackJob(config.serverUrl, printJobId, pc.agentKey);
            send(200, { ok: true, deduped: true });
            return;
          }

          logger.info(`[bridge] received ${job.kind} job ${printJobId ?? dedupKey ?? "?"} for ${printerId}`);
          try {
            // The agent's local config is the source of truth for hardware
            // dimensions AND for the printer's command language (a label
            // printer that speaks TSPL/ZPL/EPL swallows ESC/POS silently).
            const bytes = renderJob(job, renderContextFromPrinter(pc));
            await deliverToPrinter(pc, bytes);
            recordResult({ printerId, printerName: pc.name, kind: job.kind, ok: true });
            // Record to the ledger BEFORE the ack — bounds the crash window
            // during which a redelivery could double-print.
            if (printJobId) markPrinted(printJobId, printerId, pc.agentKey);
            if (printJobId) void ackJob(config.serverUrl, printJobId, pc.agentKey);
            send(200, { ok: true, rendered: true });
          } catch (e) {
            recordResult({ printerId, printerName: pc.name, kind: job.kind, ok: false, error: (e as Error).message });
            throw e;
          }
        } catch (e) {
          logger.error(`[bridge] render-print error: ${(e as Error).message}`);
          send(500, { ok: false, error: (e as Error).message });
        }
      });
      return;
    }

    // ── Offline store endpoints (localhost, secret-gated) ─────────────────
    // The web mirrors warm data here and drives reconciliation. The agent NEVER
    // calls the cloud — all of this is local. A pairing secret (provisioned to
    // the web) gates writes/reads so a random page can't touch the store.
    if (req.url && req.url.startsWith("/local/")) {
      // Pairing is the bootstrap — no secret required (the web provisions one;
      // succeeds only when unpaired or re-sending the same secret).
      if (req.method === "POST" && req.url === "/local/pair") {
        readBody(req)
          .then((raw) => {
            try {
              const { secret } = JSON.parse(raw || "{}") as { secret?: string };
              const result = setPairingSecret(String(secret ?? ""));
              send(result.paired ? 200 : 409, { ok: result.paired, ...result });
            } catch (e) {
              send(500, { ok: false, error: (e as Error).message });
            }
          })
          .catch((e) => send(500, { ok: false, error: (e as Error).message }));
        return;
      }

      // ── Offline POS login (no secret — verified against mirrored users) ──
      if (req.method === "POST" && req.url === "/local/auth") {
        readBody(req)
          .then((raw) => {
            try {
              const { email, password } = JSON.parse(raw || "{}") as {
                email?: string;
                password?: string;
              };
              send(200, authenticate(String(email ?? ""), String(password ?? "")));
            } catch (e) {
              send(500, { ok: false, error: (e as Error).message });
            }
          })
          .catch((e) => send(500, { ok: false, error: (e as Error).message }));
        return;
      }

      // ── Offline POS endpoints (token-gated — used by the Aster app) ──
      if (req.url.startsWith("/local/pos/") || req.url.startsWith("/local/print/")) {
        const session = verifyToken(req.headers["x-aster-token"] as string | undefined);
        if (!session) {
          send(401, { ok: false, error: "unauthorized" });
          return;
        }
        const okp = (data: object) => send(200, { ok: true, ...data });
        const failp = (e: unknown) => {
          logger.error(`[bridge] pos error: ${(e as Error).message}`);
          send(500, { ok: false, error: (e as Error).message });
        };
        try {
          if (req.method === "POST" && req.url === "/local/print/reprint") {
            readBody(req)
              .then(async (raw) => {
                try {
                  const b = JSON.parse(raw || "{}") as { orderId: string; kind: "receipt" | "kot"; stationId?: string | null };
                  const { reprintReceipt, reprintKot } = await import("./print/fire");
                  const r = b.kind === "kot" ? await reprintKot(b.orderId, b.stationId ?? null) : await reprintReceipt(b.orderId);
                  send(r.ok ? 200 : 400, r);
                } catch (e) {
                  failp(e);
                }
              })
              .catch(failp);
            return;
          }
          if (req.method === "GET" && req.url === "/local/pos/menu") return okp({ menu: getMenu() });
          if (req.method === "GET" && req.url === "/local/pos/tables") return okp({ tables: getTables() });
          if (req.method === "GET" && req.url === "/local/pos/combos") return okp({ combos: getCombos() });
          if (req.method === "GET" && req.url === "/local/pos/config") return okp({ config: getPaymentConfig() });
          if (req.method === "GET" && req.url === "/local/pos/orders") return okp({ orders: listOrders() });
          if (req.method === "POST" && req.url.startsWith("/local/pos/order/")) {
            const route = req.url;
            readBody(req)
              .then((raw) => {
                try {
                  const b = JSON.parse(raw || "{}");
                  if (route === "/local/pos/order/create") {
                    const order = createOrder(b) as { id: string };
                    void fireOnCreate(order.id);
                    return okp({ order });
                  }
                  if (route === "/local/pos/order/pay") {
                    const order = addPayment(b.orderId, b) as { id: string; lastPaymentId?: string };
                    void fireReceipt(order.id, order.lastPaymentId ?? String(b.paymentId ?? "pay"));
                    return okp({ order });
                  }
                  if (route === "/local/pos/order/status") return okp({ order: updateStatus(b.orderId, b.status) });
                  if (route === "/local/pos/order/add-item") {
                    const order = addItem(b.orderId, b.item) as { id: string };
                    void fireOnAddItem(order.id);
                    return okp({ order });
                  }
                  // TODO(P1): fire void KOT
                  if (route === "/local/pos/order/void-item") return okp({ order: voidItem(b.orderId, b.itemId) });
                  if (route === "/local/pos/order/refund") {
                    const r = refundPayment(b.orderId, b.paymentId, b.reason, b.managerPin);
                    return send(r.ok ? 200 : 403, { ...r });
                  }
                  send(404, { ok: false, error: "unknown pos route" });
                } catch (e) {
                  failp(e);
                }
              })
              .catch(failp);
            return;
          }
          send(404, { ok: false, error: "unknown pos route" });
        } catch (e) {
          failp(e);
        }
        return;
      }

      let secret: string | null;
      try {
        secret = getPairingSecret();
      } catch {
        send(503, { ok: false, error: "store not ready" });
        return;
      }
      if (!secret) {
        send(409, { ok: false, error: "not_paired" });
        return;
      }
      if (req.headers["x-agent-secret"] !== secret) {
        send(401, { ok: false, error: "unauthorized" });
        return;
      }

      const fail = (e: unknown) => {
        logger.error(`[bridge] local error: ${(e as Error).message}`);
        send(500, { ok: false, error: (e as Error).message });
      };

      if (req.method === "GET" && req.url === "/local/status") {
        try {
          send(200, { ok: true, status: getStatus() });
        } catch (e) {
          fail(e);
        }
        return;
      }

      if (req.method === "GET" && req.url === "/local/unsynced") {
        try {
          send(200, { ok: true, ...getUnsynced() });
        } catch (e) {
          fail(e);
        }
        return;
      }

      if (req.method === "POST" && req.url === "/local/mirror") {
        readBody(req)
          .then((raw) => {
            try {
              const { batches, entitled } = JSON.parse(raw || "{}") as {
                batches?: { table: string; rows: Record<string, unknown>[] }[];
                entitled?: boolean;
              };
              if (typeof entitled === "boolean") setState("entitled", String(entitled));
              const upserted = applyMirror(Array.isArray(batches) ? batches : []);
              send(200, { ok: true, upserted });
            } catch (e) {
              fail(e);
            }
          })
          .catch(fail);
        return;
      }

      if (req.method === "POST" && req.url === "/local/mark-synced") {
        readBody(req)
          .then((raw) => {
            try {
              const { ids } = JSON.parse(raw || "{}") as { ids?: string[] };
              send(200, { ok: true, ...markSynced(Array.isArray(ids) ? ids : []) });
            } catch (e) {
              fail(e);
            }
          })
          .catch(fail);
        return;
      }
    }

    // ── Biometric device routes (localhost only, no auth) ────────────────
    if (req.method === "GET" && req.url === "/biometric/devices") {
      const config = loadConfig();
      send(200, { ok: true, devices: config.biometricDevices ?? [] });
      return;
    }

    if (req.method === "GET" && req.url === "/biometric/status") {
      try {
        send(200, {
          ok: true,
          queueDepth: getQueueDepth(),
          lastSync: getLastSyncAt(),
          devices: getDeviceStatuses(),
        });
      } catch (e) {
        send(500, { ok: false, error: (e as Error).message });
      }
      return;
    }

    // ── ADMS HTTP push routes (ZKTeco devices POST attendance here) ──────
    if (req.url && (req.url.startsWith("/iclock/"))) {
      handleAdmsRequest(req, res, send);
      return;
    }

    send(404, { ok: false, error: "Not found" });
  });

  // listen() reports EADDRINUSE via an async 'error' event, not a throw — without
  // this handler it becomes an uncaught exception and a fatal dialog.
  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      logger.error(`[bridge] port ${BRIDGE_PORT} already in use — another agent instance is running; bridge not started`);
    } else {
      logger.error(`[bridge] server error: ${err.message}`);
    }
  });

  server.listen(BRIDGE_PORT, "127.0.0.1", () => {
    logger.info(`[bridge] listening on http://127.0.0.1:${BRIDGE_PORT}`);
  });

  return server;
}
