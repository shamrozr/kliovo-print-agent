/**
 * Shared ZKTeco connection helper.
 * ──────────────────────────────────────────────────────────────────────────
 * zkteco-js's own `createSocket()` tries TCP first and only falls back to UDP
 * when the TCP error's `.code` is exactly `ECONNREFUSED` (see node_modules/
 * zkteco-js/index.js). Real K70 terminals on flaky/overlapping-subnet home
 * networks often fail TCP with `EHOSTUNREACH` or `ETIMEDOUT` instead — codes
 * the library doesn't special-case — so its automatic fallback silently never
 * fires and the whole connection attempt fails even though the device is
 * perfectly reachable over UDP (the K70's actual native transport). Every
 * call site in this app must go through `connectZk()` below instead of
 * calling `zk.createSocket()` directly, so a flaky TCP path always still
 * lands on UDP rather than surfacing a hard failure to the operator.
 */

export interface ZkUser {
  uid: number;
  userId: string;
  name: string;
  role: number;
}

export interface ZkClient {
  connectionType: "tcp" | "udp" | null;
  zudp: { socket: unknown; createSocket(): Promise<unknown>; connect(): Promise<unknown> };
  createSocket(): Promise<unknown>;
  getInfo(): Promise<{ userCounts: number; logCounts: number; logCapacity: number }>;
  getSerialNumber(): Promise<string>;
  getDeviceName(): Promise<string>;
  getUsers(): Promise<{ data: ZkUser[] }>;
  setUser(uid: number, userId: string, name: string, password: string, role: number, cardno: number): Promise<unknown>;
  deleteUser(uid: number): Promise<unknown>;
  getAttendances(): Promise<{ data?: Array<{ deviceUserId?: string; id?: string; timestamp?: string }> }>;
  setTime(t: Date): Promise<unknown>;
  disconnect(): Promise<unknown>;
}

type ZkConstructor = new (ip: string, port: number, timeout?: number, inport?: number) => ZkClient;

export function newZk(host: string, port: number, timeout = 5000, inport = 4000): ZkClient {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const ZKLib = require("zkteco-js") as ZkConstructor;
  return new ZKLib(host || "192.168.1.201", port || 4370, timeout, inport);
}

/**
 * Resolve a STABLE, clean identifier for a terminal.
 * ──────────────────────────────────────────────────────────────────────────
 * zkteco-js's getSerialNumber() assumes a fixed 8-byte response header and a
 * clean `~SerialNumber=...` UTF-8 string. Some K70 firmwares frame the reply
 * differently, so `data.slice(8).toString('utf-8')` reads binary garbage
 * (control bytes → U+FFFD replacement chars once stored). A garbage serial
 * can't round-trip through the `?deviceSerial=` device lookup, which silently
 * breaks staff sync + ingest even though the device registered.
 *
 * Preference order:
 *   1. The real hardware serial, IF it parses to clean chars ([A-Za-z0-9._-]).
 *      Best — human-recognizable and survives an agent reinstall.
 *   2. Otherwise `ownId` — the agent's own per-device config id (`zk_<...>`),
 *      generated once when the device is added and persisted in agent-config.
 *      Already unique + clean; NOT host-derived (every K70 ships on the same
 *      default 192.168.1.201, so a host id would be near-identical for every
 *      tenant — a useless identifier).
 */
export function sanitizeSerial(raw: unknown): string {
  if (raw == null) return "";
  return String(raw).replace(/[^A-Za-z0-9._-]/g, "").trim();
}

export async function resolveDeviceId(zk: ZkClient, ownId: string): Promise<string> {
  let clean = "";
  try {
    clean = sanitizeSerial(await zk.getSerialNumber());
  } catch {
    // fall through to the agent's own device id
  }
  if (clean.length >= 4) return clean;
  const own = sanitizeSerial(ownId);
  return own.length >= 4 ? own : "zk-unknown";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Connect to a K70 (or compatible terminal), trying TCP then UDP on each
 * attempt, retrying the whole pair a few times before giving up. A single
 * attempt is fragile on real restaurant networks (and on this dev box's USB
 * Ethernet dongle) — a transient link blip surfaces as ECONNREFUSED,
 * EHOSTUNREACH, or ETIMEDOUT depending on exactly when the packet was
 * dropped, and none of those are reliably distinguishable from a genuinely
 * unreachable device. A short retry window absorbs the blip; if the device
 * is truly down, all attempts fail and the caller still gets a clear error.
 *
 * Reconnects with a FRESH ZKLib instance each attempt — a socket that failed
 * mid-handshake is left in an undefined state, and zkteco-js's own
 * createSocket() has a special (and fragile) code path for reusing an
 * existing `ztcp.socket`, so retrying is safer done from scratch.
 */
export async function connectZk(
  host: string,
  port: number,
  opts?: { attempts?: number; delayMs?: number }
): Promise<ZkClient> {
  const attempts = opts?.attempts ?? 3;
  const delayMs = opts?.delayMs ?? 800;
  let lastErr: unknown;

  for (let i = 0; i < attempts; i++) {
    const zk = newZk(host, port);
    try {
      await zk.createSocket();
      return zk;
    } catch (tcpErr) {
      // zkteco-js's own fallback only fires for ECONNREFUSED — force UDP
      // ourselves for every other failure mode (EHOSTUNREACH, ETIMEDOUT, …),
      // since UDP is the K70's actual native transport either way.
      try {
        await zk.zudp.createSocket();
        await zk.zudp.connect();
        zk.connectionType = "udp";
        return zk;
      } catch {
        lastErr = tcpErr; // the TCP error is the more diagnosable one to surface
        try {
          await zk.disconnect();
        } catch {
          // ignore
        }
      }
    }
    if (i < attempts - 1) await sleep(delayMs);
  }
  throw lastErr;
}

/**
 * zkteco-js doesn't reject with real Error objects — it throws a custom
 * wrapper shaped like `{ err: { err: Error {...}, ip, command }, ip, command }`
 * (nested 1-2 levels depending on TCP vs UDP fallback). Reading `.message`
 * directly off that always returns undefined, which is why failures used to
 * surface as a useless "unknown error" with no way to diagnose a real cause.
 */
export function zkErrorMessage(e: unknown): string {
  let cur: any = e;
  for (let i = 0; i < 4 && cur; i++) {
    if (typeof cur === "string") return cur;
    if (cur instanceof Error && cur.message) return `${cur.message}${(cur as any).code ? ` (${(cur as any).code})` : ""}`;
    if (typeof cur.message === "string" && cur.message) return cur.message;
    if (typeof cur.code === "string") return cur.code;
    cur = cur.err;
  }
  try {
    return JSON.stringify(e);
  } catch {
    return String(e);
  }
}
