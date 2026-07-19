import net from "net";
import { logger } from "./logger";

// Connect timeout only — once connected we rely on the OS/printer to accept
// the write promptly, and we do NOT want a slow flush to look retryable.
const TCP_CONNECT_TIMEOUT_MS = 2_000;

const MAX_ATTEMPTS = 3;
const RETRY_BACKOFF_MS = [300, 1_000];

/**
 * Thrown only when we can prove no bytes reached the printer — i.e. the
 * failure happened before `connect` succeeded (refused/unreachable/timed
 * out while dialing). Callers may safely retry a RetryableSendError.
 *
 * Any other error means the socket had connected, so the printer may have
 * received partial or full bytes already; retrying that could duplicate
 * the print job, so those errors must propagate as-is (non-retryable).
 */
export class RetryableSendError extends Error {}

/**
 * One-shot raw TCP send. Does not retry — see deliverRawWithRetry for the
 * retry wrapper that respects the pre/post-connect safety boundary.
 */
export function sendRawToPrinter(host: string, port: number, bytes: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = new net.Socket();
    let settled = false;
    // Flips to true only once `connect` succeeds. Everything after that
    // point may have put bytes on the wire, so failures from then on are
    // NOT safe to retry — see the invariant note on RetryableSendError.
    let connected = false;

    const settle = (err?: Error) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (err) reject(err);
      else resolve();
    };

    socket.setTimeout(TCP_CONNECT_TIMEOUT_MS);
    socket.on("timeout", () => {
      if (!connected) {
        settle(
          new RetryableSendError(
            `TCP connect timeout after ${TCP_CONNECT_TIMEOUT_MS}ms to ${host}:${port}`
          )
        );
      } else {
        // Timed out mid-write/after-connect: bytes may already be on the
        // wire, so this must not be retried automatically.
        settle(new Error(`TCP timeout after connect to ${host}:${port}`));
      }
    });
    socket.on("error", (err) => {
      if (!connected) {
        // e.g. ECONNREFUSED / EHOSTUNREACH / ENETUNREACH / ETIMEDOUT before
        // the connection was ever established — nothing was sent, safe to retry.
        settle(new RetryableSendError(err.message));
      } else {
        settle(err);
      }
    });

    socket.connect(port, host, () => {
      connected = true;
      socket.write(bytes, (err) => {
        if (err) return settle(err);
        logger.info(`[tcp] sent ${bytes.length} bytes to ${host}:${port}`);
        settle();
      });
    });
  });
}

/**
 * Retrying wrapper around sendRawToPrinter. Only retries when the failure
 * is provably pre-connect (RetryableSendError) — see the invariant comment
 * above RetryableSendError. Any other error (post-connect) is rethrown
 * immediately without retrying, because the printer may already have
 * received bytes and retrying risks a duplicate print.
 */
export async function deliverRawWithRetry(host: string, port: number, bytes: Buffer): Promise<void> {
  let lastErr: Error | undefined;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      await sendRawToPrinter(host, port, bytes);
      return;
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      if (!(error instanceof RetryableSendError)) {
        // Non-retryable: bytes may have been written already, do not retry.
        throw error;
      }
      lastErr = error;
      if (attempt < MAX_ATTEMPTS) {
        logger.warn(`[tcp] retry ${attempt}/${MAX_ATTEMPTS} to ${host}:${port} after ${error.message}`);
        await new Promise((r) => setTimeout(r, RETRY_BACKOFF_MS[attempt - 1]));
      }
    }
  }
  throw lastErr;
}
