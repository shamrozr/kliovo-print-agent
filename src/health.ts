/**
 * Print health & observability.
 *
 * Every delivery attempt (bridge push, render-print, queue poll, test) reports
 * its outcome here. This is the agent's single source of truth for "is
 * printing working?" — and the reason failures are no longer silent:
 *
 *   - drives the tray light (green / yellow / red) + tooltip + recent activity
 *   - raises a native OS notification when a printer starts failing, and
 *     another when it recovers (throttled so it can't spam during an outage)
 *   - exposes a snapshot for the bridge /status endpoint so the POS can show
 *     "printed ✓ / failed ✗" right after it sends a job
 */
import { Notification } from "electron";
import { setTrayStatus, setTrayTooltip, setTrayActivity, type TrayStatus } from "./tray";
import { logger } from "./logger";

export interface JobEvent {
  ts:          number;
  printerId:   string;
  printerName: string;
  kind:        string;          // receipt | kot | ... | raw | queued | test
  ok:          boolean;
  error?:      string;
}

const MAX_EVENTS         = 25;
const RECENT_WINDOW_MS   = 5 * 60_000;   // "yellow" lingers this long after a failure
const NOTIFY_THROTTLE_MS = 60_000;       // at most one failure popup per printer per minute

const events: JobEvent[] = [];
const lastResultByPrinter = new Map<string, boolean>();   // true = last attempt ok
const lastFailNotifyAt    = new Map<string, number>();

function timeStr(ts: number): string {
  return new Date(ts).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function notify(title: string, body: string): void {
  try {
    if (Notification.isSupported()) new Notification({ title, body }).show();
  } catch (e) {
    logger.warn(`[health] notification failed: ${(e as Error).message}`);
  }
}

/** Record the outcome of one delivery attempt. The hub of the whole feature. */
export function recordResult(input: Omit<JobEvent, "ts">): void {
  const evt: JobEvent = { ...input, ts: Date.now() };
  events.unshift(evt);
  if (events.length > MAX_EVENTS) events.length = MAX_EVENTS;

  const prevOk = lastResultByPrinter.get(evt.printerId);
  lastResultByPrinter.set(evt.printerId, evt.ok);

  const label = evt.printerName || evt.printerId;
  if (!evt.ok) {
    logger.error(`[health] FAILED ${evt.kind} on ${label}: ${evt.error ?? "unknown error"}`);
    const last = lastFailNotifyAt.get(evt.printerId) ?? 0;
    if (Date.now() - last > NOTIFY_THROTTLE_MS) {
      lastFailNotifyAt.set(evt.printerId, Date.now());
      notify("Kliovo — Print failed", `${label}: ${evt.error ?? "could not print"}`);
    }
  } else {
    logger.info(`[health] printed ${evt.kind} on ${label}`);
    if (prevOk === false) {
      notify("Kliovo — Printing recovered", `${label} is printing again.`);
    }
  }

  refreshTray();
}

function computeStatus(): TrayStatus {
  const states = Array.from(lastResultByPrinter.values());
  if (states.some((ok) => ok === false)) return "red";   // a printer is currently failing
  const recentFailure = events.some((e) => !e.ok && Date.now() - e.ts < RECENT_WINDOW_MS);
  if (recentFailure) return "yellow";                     // recovered, but unstable lately
  return "green";
}

function refreshTray(): void {
  const status = computeStatus();
  setTrayStatus(status);

  const latest = events[0];
  if (latest) {
    const mark = latest.ok ? "OK" : "FAILED";
    const tip = latest.ok
      ? `Kliovo Print Agent — last: ${latest.kind} ${mark} at ${timeStr(latest.ts)}`
      : `Kliovo Print Agent — last: ${latest.kind} ${mark} (${latest.error ?? "error"})`;
    setTrayTooltip(tip);
  }

  setTrayActivity(
    events.slice(0, 5).map(
      (e) => `${timeStr(e.ts)}  ${e.ok ? "✓" : "✗"} ${e.kind} → ${e.printerName || e.printerId}`
    )
  );
}

/** Snapshot for the bridge /status endpoint. */
export function getHealthSnapshot() {
  return {
    status: computeStatus(),
    printers: Array.from(lastResultByPrinter.entries()).map(([printerId, ok]) => ({ printerId, ok })),
    recent: events.slice(0, 10),
  };
}
