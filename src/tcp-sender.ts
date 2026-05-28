import net from "net";
import { logger } from "./logger";

const TCP_TIMEOUT_MS = 5_000;

export function sendRawToPrinter(host: string, port: number, bytes: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = new net.Socket();
    let settled = false;

    const settle = (err?: Error) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (err) reject(err);
      else resolve();
    };

    socket.setTimeout(TCP_TIMEOUT_MS);
    socket.on("timeout", () =>
      settle(new Error(`TCP timeout after ${TCP_TIMEOUT_MS}ms to ${host}:${port}`))
    );
    socket.on("error", (err) => settle(err));

    socket.connect(port, host, () => {
      socket.write(bytes, (err) => {
        if (err) return settle(err);
        logger.info(`[tcp] sent ${bytes.length} bytes to ${host}:${port}`);
        settle();
      });
    });
  });
}
