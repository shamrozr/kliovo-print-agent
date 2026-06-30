import http from "http";
import { logger } from "../logger";
import { queuePunch } from "./attendance-store";

/**
 * Handle ADMS (Automatic Data Master Server) HTTP push from ZKTeco devices.
 *
 * The device is configured with a "push URL" pointing at
 *   http://<agent-ip>:6310/iclock/cdata
 * and periodically POSTs attendance logs + polls for commands.
 */
export function handleAdmsRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  send: (status: number, body: object) => void
): void {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const sn = url.searchParams.get("SN") ?? "unknown";
  const table = url.searchParams.get("table");

  // POST /iclock/cdata?SN=<serial>&table=ATTLOG — attendance log push
  if (req.method === "POST" && url.pathname === "/iclock/cdata" && table === "ATTLOG") {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      try {
        const lines = body.split("\n").filter((l) => l.trim().length > 0);
        let count = 0;

        for (const line of lines) {
          // Format: PIN\tDatetime\tStatus\tVerify\tWorkcode\tReserved
          const parts = line.split("\t");
          if (parts.length < 2) continue;

          const deviceUserId = parts[0].trim();
          const timestamp = parts[1].trim();
          const status = parts[2]?.trim();

          // Status 0 = check-in, 1 = check-out (device-dependent)
          let direction: "in" | "out" | undefined;
          if (status === "0") direction = "in";
          else if (status === "1") direction = "out";

          queuePunch({
            deviceUserId,
            timestamp,
            direction,
            deviceId: `adms-${sn}`,
          });
          count++;
        }

        logger.info(`[adms] received ${count} punch(es) from device ${sn}`);
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end("OK");
      } catch (e) {
        logger.error(`[adms] parse error from ${sn}:`, (e as Error).message);
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end("OK"); // always ack to the device
      }
    });
    req.on("error", () => {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("OK");
    });
    return;
  }

  // GET /iclock/cdata?SN=<serial> — device registration / heartbeat
  if (req.method === "GET" && url.pathname === "/iclock/cdata") {
    logger.info(`[adms] heartbeat from device ${sn}`);
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("OK");
    return;
  }

  // GET /iclock/getrequest?SN=<serial> — device polling for commands
  if (req.method === "GET" && url.pathname === "/iclock/getrequest") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("OK");
    return;
  }

  // Fallback — unknown ADMS path
  send(404, { ok: false, error: "unknown iclock route" });
}
