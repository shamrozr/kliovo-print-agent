/**
 * Cash drawer — the agent's half.
 *
 * A drawer is a box on the PRINTER's DK port, not a device on the network.
 * Opening it is `ESC p m t1 t2` sent to a printer, so everything here is 5
 * bytes and where they go.
 *
 * ## The split with the server
 *
 * The cloud decides **whether** the drawer should open (cash changed hands);
 * this agent decides **how** (which pin, how long a pulse). That split follows
 * the hardware: only the machine standing next to the drawer knows how it is
 * wired, which is the same reason `PrinterEntry` already holds the
 * operator-verified host/port rather than trusting the web-mirrored copy (see
 * the note in print/router.ts).
 *
 * On the wire: the agent sends `X-Agent-Drawer: 1`, and a job that should open
 * the drawer comes back with `openDrawer: true` in the envelope. The agent
 * then prepends the kick from the settings below. An agent that does NOT send
 * that header gets the kick already prepended by the server, using a default
 * pin — so an older build still opens a drawer, it just cannot be tuned.
 * Exactly one side emits, always.
 *
 * ## First, never last
 *
 * The kick is PREPENDED. Emitting it after the cut (which is what Dine's
 * receipt designer did until 2026-09-02) means a paper-out, a jam or a
 * truncated job prints most of the receipt and never opens the drawer, and a
 * two-copy receipt makes the cashier wait through both. Prepended, the drawer
 * opens while the paper is still feeding.
 */

const ESC = 0x1b;

/** Connector pin the drawer is wired to. `m` in `ESC p m t1 t2`. */
export type DrawerPin = 2 | 5;

/** `t1`/`t2` are in 2ms units, so 255 caps a pulse at 510ms. */
const PULSE_UNIT_MS = 2;
const MAX_PULSE_UNITS = 0xff;

export const DEFAULT_DRAWER_PIN: DrawerPin = 2;
export const DEFAULT_PULSE_ON_MS = 100;
export const DEFAULT_PULSE_OFF_MS = 240;

/** Offered in the settings window. A short list, not a free number field —
 *  an operator is answering "it clicks but does not open", not tuning a coil. */
export const PULSE_PRESETS_MS = [100, 200, 300] as const;

export interface DrawerConfig {
  hasCashDrawer?: boolean;
  drawerPin?: DrawerPin;
  drawerPulseOnMs?: number;
  drawerPulseOffMs?: number;
}

function toPulseUnits(ms: number): number {
  if (!Number.isFinite(ms) || ms <= 0) return 0;
  return Math.max(1, Math.min(MAX_PULSE_UNITS, Math.round(ms / PULSE_UNIT_MS)));
}

/**
 * Build the 5-byte kick.
 *
 * Takes the CONNECTOR pin (2 or 5), not the wire value `m` (0 or 1), so the
 * number the operator picks, the number stored in config and the number passed
 * here are all the same — no place for an off-by-one to hide.
 */
export function buildDrawerKick(
  pin: DrawerPin = DEFAULT_DRAWER_PIN,
  pulseOnMs: number = DEFAULT_PULSE_ON_MS,
  pulseOffMs: number = DEFAULT_PULSE_OFF_MS
): Buffer {
  const m = pin === 5 ? 0x01 : 0x00;
  return Buffer.from([ESC, 0x70, m, toPulseUnits(pulseOnMs), toPulseUnits(pulseOffMs)]);
}

/** The kick for a configured printer. */
export function kickFor(cfg: DrawerConfig): Buffer {
  return buildDrawerKick(
    cfg.drawerPin === 5 ? 5 : DEFAULT_DRAWER_PIN,
    cfg.drawerPulseOnMs ?? DEFAULT_PULSE_ON_MS,
    cfg.drawerPulseOffMs ?? DEFAULT_PULSE_OFF_MS
  );
}

/**
 * Prepend the kick to a job's bytes.
 *
 * Returns the bytes UNCHANGED when this printer has no drawer configured. That
 * is the guard that stops a mis-set flag from firing a solenoid pin on a
 * kitchen or label printer.
 */
export function withDrawerKick(bytes: Buffer, cfg: DrawerConfig): Buffer {
  if (!cfg.hasCashDrawer) return bytes;
  return Buffer.concat([kickFor(cfg), bytes]);
}

/**
 * Header the agent sends so the server knows it emits its own kick, and what
 * that kick is set to.
 *
 * The CONFIG header is deliberately conditional on `changed`. `/api/print/pending`
 * is the highest-volume route on the platform, and a value sent on every poll
 * would be a database write on every poll, for every printer, forever — which
 * is the shape of the Aug 5-7 2026 outage. Sending it only when the fingerprint
 * changes makes the reported copy free in steady state.
 */
export function drawerHeaders(cfg: DrawerConfig, changed: boolean): Record<string, string> {
  const h: Record<string, string> = { "X-Agent-Drawer": "1" };
  if (changed) {
    h["X-Agent-Drawer-Config"] =
      `has=${cfg.hasCashDrawer ? 1 : 0};pin=${cfg.drawerPin ?? DEFAULT_DRAWER_PIN};` +
      `on=${cfg.drawerPulseOnMs ?? DEFAULT_PULSE_ON_MS};off=${cfg.drawerPulseOffMs ?? DEFAULT_PULSE_OFF_MS}`;
  }
  return h;
}

/** Stable fingerprint, so the header above is sent only when something moved. */
export function drawerFingerprint(cfg: DrawerConfig): string {
  return [
    cfg.hasCashDrawer ? "1" : "0",
    cfg.drawerPin ?? DEFAULT_DRAWER_PIN,
    cfg.drawerPulseOnMs ?? DEFAULT_PULSE_ON_MS,
    cfg.drawerPulseOffMs ?? DEFAULT_PULSE_OFF_MS,
  ].join(":");
}

/**
 * Does this tender open the drawer?
 *
 * This rule exists in TWO places, deliberately and boundedly: here, and in
 * Dine's `src/lib/print/drawer.ts`. The agent runs the POS itself during an
 * outage and settles payments with no server involved, so it cannot ask. It is
 * kept to literally "does the tender include cash" precisely so the two cannot
 * meaningfully drift. **Change one, change the other.**
 */
const CASH_TENDERS = new Set(["cash", "cod"]);

export function tenderOpensDrawer(methods: readonly (string | null | undefined)[]): boolean {
  return methods.some((m) => !!m && CASH_TENDERS.has(String(m).trim().toLowerCase()));
}
