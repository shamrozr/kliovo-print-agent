# Offline Auto-Print & Aster↔Agent Routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When Aster fires an order at the local agent during an internet outage, the agent routes each line to the correct printer and prints the KOT(s) + receipt exactly once — and on reconnect pushes born-offline orders (full state) and continued online tabs (op-deltas) up to Dine.

**Architecture:** The Aster↔agent link already exists (`localhost:6310`, `X-Aster-Token` session, `/local/pos/*` endpoints). We (1) mirror printers/routing/stations/templates/logo down into encrypted SQLite while online, (2) add a pure routing resolver + pure render-input builders, (3) hook a fire orchestrator into the existing POS write endpoints so create/add-item/pay/void-item auto-print, sharing the same `printed_jobs` dedup ledger the cloud poll uses, and (4) extend sync for instant drain + continued-order op-deltas. Un-routable tickets fall back to a default printer and are flagged — never dropped.

**Tech Stack:** TypeScript, Electron, better-sqlite3-multiple-ciphers (SQLCipher), vitest (new — pure-logic tests only), existing `src/render` ESC/POS builder.

**Testing strategy:** The native SQLite module is electron-ABI-built, so vitest cannot open the real DB. We unit-test the **pure** modules (routing resolution, render-input mapping, job-id determinism, continued-order op mapping) under vitest, and verify DB/electron wiring with a **manual integration script** run against a local Dine clone. Keep all vitest-tested modules free of runtime imports of `./config`, `./store/*`, or `electron` — use `import type` only.

---

## File Structure

| File | Responsibility | New/Modify |
|------|----------------|-----------|
| `package.json` | add vitest + `test` script | Modify |
| `vitest.config.ts` | restrict tests to `src/**/*.test.ts`, node env | Create |
| `src/store/schema.ts` | +5 mirror tables, `order_items.fired_at` | Modify |
| `src/store/db.ts` | idempotent `fired_at` migration | Modify |
| `src/store/repo.ts` | register 5 tables in `MIRROR_TABLES` | Modify |
| `src/print/router.ts` | **pure** route resolution (printers+routes → targets) | Create |
| `src/print/render-map.ts` | **pure** KOT/receipt input builders + job-id functions | Create |
| `src/store/print-repo.ts` | DB reads/writes for fire (order, unfired items, mirror lookups, fired_at) | Create |
| `src/print/fire.ts` | fire orchestrator: build → render → deliver → ledger | Create |
| `src/bridge-server.ts` | call fire after POS writes; add `/local/print/reprint` | Modify |
| `src/cloud-sync.ts` | instant offline→online drain; push continued ops | Modify |
| `src/store/continued-repo.ts` | `getContinuedOrderOpsForPush`; log ops vs existing id | Create |
| `scripts/offline-print-itest.mjs` | manual end-to-end integration check | Create |

---

## PHASE P0 — Route + Auto-Print (kitchen never goes silent)

### Task 1: Add vitest tooling

**Files:**
- Modify: `package.json`
- Create: `vitest.config.ts`

- [ ] **Step 1: Install vitest (pnpm, per repo rule)**

Run: `cd /Users/shamrozakram/Desktop/KLIOVO/kliovo-print-agent && pnpm add -D vitest`
Expected: `vitest` added to devDependencies; `pnpm-lock.yaml` updated.

- [ ] **Step 2: Add the `test` script**

In `package.json` `"scripts"`, add:

```json
    "test": "vitest run",
    "test:watch": "vitest"
```

- [ ] **Step 3: Create `vitest.config.ts`**

```ts
import { defineConfig } from "vitest/config";

// Pure-logic tests only. The DB layer uses an electron-ABI native module that
// cannot load under plain node, so those paths are verified by the manual
// integration script (scripts/offline-print-itest.mjs), not vitest.
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
```

- [ ] **Step 4: Verify the runner starts**

Run: `pnpm test`
Expected: exits 0 with "No test files found" (no tests yet).

- [ ] **Step 5: Commit**

```bash
git add package.json pnpm-lock.yaml vitest.config.ts
git commit -m "chore: add vitest for pure-logic unit tests"
```

---

### Task 2: Mirror tables + `fired_at` column

**Files:**
- Modify: `src/store/schema.ts` (append tables to `SCHEMA_SQL`; add `fired_at` to `order_items`)
- Modify: `src/store/db.ts` (idempotent migration)
- Modify: `src/store/repo.ts` (`MIRROR_TABLES`)

- [ ] **Step 1: Add `fired_at` to the `order_items` CREATE**

In `src/store/schema.ts`, inside `CREATE TABLE IF NOT EXISTS order_items (...)`, after `kitchen_status TEXT DEFAULT 'pending',` add:

```sql
  fired_at      INTEGER,
```

- [ ] **Step 2: Append the five mirror tables to `SCHEMA_SQL`**

At the end of the `SCHEMA_SQL` template string (before the closing backtick), add:

```sql
CREATE TABLE IF NOT EXISTS printers (
  id                  TEXT PRIMARY KEY,
  name                TEXT,
  connection          TEXT DEFAULT 'network',   -- 'network' | 'system'
  host                TEXT,
  port                INTEGER,
  system_printer_name TEXT,
  paper_width         INTEGER DEFAULT 80,        -- 80 | 58
  printer_mode        TEXT DEFAULT 'receipt',    -- 'receipt' | 'label'
  label_language      TEXT,
  label_width_mm      REAL,
  label_height_mm     REAL,
  gap_type            TEXT,
  is_default          INTEGER DEFAULT 0,
  is_active           INTEGER DEFAULT 1,
  updated_at          INTEGER
);
CREATE TABLE IF NOT EXISTS print_routing (
  id               TEXT PRIMARY KEY,
  fulfillment_type TEXT,                         -- 'dine_in'|'takeaway'|'delivery'|'*'
  station_id       TEXT,                         -- NULL/'*' = any station
  printer_id       TEXT NOT NULL,
  copies           INTEGER DEFAULT 1,
  role             TEXT DEFAULT 'kot',           -- 'kot' | 'receipt'
  updated_at       INTEGER
);
CREATE TABLE IF NOT EXISTS kitchen_stations (
  id         TEXT PRIMARY KEY,
  name       TEXT,
  label      TEXT,
  sort_order INTEGER DEFAULT 0,
  updated_at INTEGER
);
CREATE TABLE IF NOT EXISTS print_templates (
  kind          TEXT PRIMARY KEY,               -- 'receipt' | 'kot'
  layout_config TEXT DEFAULT '{}',
  updated_at    INTEGER
);
CREATE TABLE IF NOT EXISTS branding (
  id         TEXT PRIMARY KEY DEFAULT 'default',
  logo_bytes BLOB,
  name       TEXT,
  address    TEXT,
  phone      TEXT,
  tax_lines  TEXT DEFAULT '[]',
  updated_at INTEGER
);
```

- [ ] **Step 3: Idempotent migration for existing installs**

In `src/store/db.ts`, add after the `applySchema` function:

```ts
/**
 * Column additions for already-provisioned tills. CREATE TABLE IF NOT EXISTS
 * never alters an existing table, so new columns need a guarded ALTER. SQLite
 * throws "duplicate column name" if it already exists — swallow that only.
 */
function runMigrations(conn: Database.Database): void {
  try {
    conn.prepare("ALTER TABLE order_items ADD COLUMN fired_at INTEGER").run();
  } catch (e) {
    if (!/duplicate column/i.test((e as Error).message)) throw e;
  }
}
```

Then in `initStore`, immediately after `applySchema(conn);` add:

```ts
  runMigrations(conn);
```

- [ ] **Step 4: Register the tables in `MIRROR_TABLES`**

In `src/store/repo.ts`, extend the `MIRROR_TABLES` object with:

```ts
  printers: "id",
  print_routing: "id",
  kitchen_stations: "id",
  print_templates: "kind",
  branding: "id",
```

- [ ] **Step 5: Build to verify no TS/DDL errors**

Run: `pnpm build`
Expected: `tsc` completes with no errors.

- [ ] **Step 6: Commit**

```bash
git add src/store/schema.ts src/store/db.ts src/store/repo.ts
git commit -m "feat(store): mirror printers/routing/stations/templates/branding + order_items.fired_at"
```

---

### Task 3: Pure routing resolver (`src/print/router.ts`)

**Files:**
- Create: `src/print/router.ts`
- Test: `src/print/router.test.ts`

- [ ] **Step 1: Write the failing tests**

`src/print/router.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { resolveKotTargets, resolveReceiptTarget, toPrinterEntry, type MirroredPrinter, type MirroredRoute } from "./router";

const kitchen: MirroredPrinter = { id: "pk", name: "Kitchen", connection: "network", host: "10.0.0.5", port: 9100, is_active: 1 };
const bar: MirroredPrinter = { id: "pb", name: "Bar", connection: "network", host: "10.0.0.6", port: 9100, is_active: 1 };
const cashier: MirroredPrinter = { id: "pc", name: "Cashier", connection: "network", host: "10.0.0.7", port: 9100, printer_mode: "receipt", is_default: 1, is_active: 1 };
const printers = [kitchen, bar, cashier];

describe("resolveKotTargets", () => {
  it("routes a station to its mapped printer with copies", () => {
    const routes: MirroredRoute[] = [{ id: "r1", station_id: "s-kitchen", printer_id: "pk", copies: 2, role: "kot" }];
    const t = resolveKotTargets(printers, routes, "dine_in", "s-kitchen");
    expect(t).toHaveLength(1);
    expect(t[0].printer.printerId).toBe("pk");
    expect(t[0].copies).toBe(2);
    expect(t[0].fallback).toBe(false);
  });

  it("falls back to the default printer (flagged) when the station has no route", () => {
    const t = resolveKotTargets(printers, [], "dine_in", "s-unknown");
    expect(t).toHaveLength(1);
    expect(t[0].printer.printerId).toBe("pc"); // is_default
    expect(t[0].fallback).toBe(true);
  });

  it("falls back to the first active printer when no default exists", () => {
    const noDefault = printers.map((p) => ({ ...p, is_default: 0 }));
    const t = resolveKotTargets(noDefault, [], "dine_in", "s-unknown");
    expect(t[0].printer.printerId).toBe("pk");
    expect(t[0].fallback).toBe(true);
  });

  it("skips inactive printers", () => {
    const routes: MirroredRoute[] = [{ id: "r1", station_id: "s-kitchen", printer_id: "pk", role: "kot" }];
    const inactive = printers.map((p) => (p.id === "pk" ? { ...p, is_active: 0 } : p));
    const t = resolveKotTargets(inactive, routes, "dine_in", "s-kitchen");
    expect(t[0].fallback).toBe(true); // pk inactive → fallback to default pc
  });

  it("returns [] when there are no active printers at all", () => {
    const dead = printers.map((p) => ({ ...p, is_active: 0 }));
    expect(resolveKotTargets(dead, [], "dine_in", "s-kitchen")).toEqual([]);
  });
});

describe("resolveReceiptTarget", () => {
  it("prefers an explicit receipt route", () => {
    const routes: MirroredRoute[] = [{ id: "r1", printer_id: "pb", role: "receipt", fulfillment_type: "*" }];
    const t = resolveReceiptTarget(printers, routes, "dine_in");
    expect(t?.printer.printerId).toBe("pb");
    expect(t?.fallback).toBe(false);
  });

  it("falls back to a printer_mode=receipt printer, flagged", () => {
    const t = resolveReceiptTarget(printers, [], "dine_in");
    expect(t?.printer.printerId).toBe("pc");
    expect(t?.fallback).toBe(true);
  });
});

describe("toPrinterEntry", () => {
  it("maps snake_case mirror row to camelCase PrinterEntry", () => {
    const e = toPrinterEntry(kitchen);
    expect(e).toMatchObject({ printerId: "pk", host: "10.0.0.5", port: 9100, connection: "network", paperWidth: 80 });
  });
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `pnpm test src/print/router.test.ts`
Expected: FAIL — `router.ts` does not exist.

- [ ] **Step 3: Implement `src/print/router.ts`**

```ts
/**
 * Pure print routing. Given the mirrored printers + routing rows, resolve which
 * physical printer(s) a KOT (per station) or a receipt should go to. No I/O, no
 * DB — fully unit-testable. `import type` only, so vitest never loads electron.
 *
 * SAFETY (locked decision): a real ticket must NEVER resolve to nothing when any
 * printer is reachable. Unmapped → default printer → first active printer, with
 * `fallback: true` so the caller can flag it. Only [] when zero active printers.
 */
import type { PrinterEntry } from "../config";

export interface MirroredPrinter {
  id: string;
  name?: string;
  connection?: "network" | "system";
  host?: string;
  port?: number;
  system_printer_name?: string;
  paper_width?: number;
  printer_mode?: string;
  label_language?: string;
  label_width_mm?: number;
  label_height_mm?: number;
  gap_type?: string;
  is_default?: number;
  is_active?: number;
}

export interface MirroredRoute {
  id: string;
  fulfillment_type?: string | null;
  station_id?: string | null;
  printer_id: string;
  copies?: number;
  role?: string; // 'kot' | 'receipt'
}

export interface ResolvedTarget {
  printer: PrinterEntry;
  copies: number;
  fallback: boolean;
}

export function toPrinterEntry(p: MirroredPrinter): PrinterEntry {
  return {
    printerId: p.id,
    agentKey: "", // offline delivery does not use the cloud agent key
    connection: p.connection === "system" ? "system" : "network",
    host: p.host ?? "",
    port: p.port ?? 9100,
    systemPrinterName: p.system_printer_name,
    name: p.name ?? p.id,
    paperWidth: p.paper_width === 58 ? 58 : 80,
    printerMode: p.printer_mode === "label" ? "label" : "receipt",
    labelWidthMm: p.label_width_mm,
    labelHeightMm: p.label_height_mm,
    gapType: p.gap_type as PrinterEntry["gapType"],
    labelLanguage: p.label_language as PrinterEntry["labelLanguage"],
  };
}

const isActive = (p: MirroredPrinter) => p.is_active !== 0;
const wildcard = (v: string | null | undefined) => v == null || v === "" || v === "*";

function ftMatch(route: MirroredRoute, ft: string): boolean {
  return wildcard(route.fulfillment_type) || route.fulfillment_type === ft;
}

function fallbackPrinter(printers: MirroredPrinter[]): MirroredPrinter | null {
  const active = printers.filter(isActive);
  if (active.length === 0) return null;
  return active.find((p) => p.is_default === 1) ?? active[0];
}

export function resolveKotTargets(
  printers: MirroredPrinter[],
  routes: MirroredRoute[],
  fulfillmentType: string,
  stationId: string | null
): ResolvedTarget[] {
  const byId = new Map(printers.map((p) => [p.id, p]));
  const matched = routes.filter(
    (r) =>
      (r.role ?? "kot") !== "receipt" &&
      ftMatch(r, fulfillmentType) &&
      (wildcard(r.station_id) ? stationId == null : r.station_id === stationId)
  );

  const targets: ResolvedTarget[] = [];
  for (const r of matched) {
    const p = byId.get(r.printer_id);
    if (p && isActive(p)) {
      targets.push({ printer: toPrinterEntry(p), copies: Math.max(1, r.copies ?? 1), fallback: false });
    }
  }
  if (targets.length > 0) return targets;

  const fb = fallbackPrinter(printers);
  return fb ? [{ printer: toPrinterEntry(fb), copies: 1, fallback: true }] : [];
}

export function resolveReceiptTarget(
  printers: MirroredPrinter[],
  routes: MirroredRoute[],
  fulfillmentType: string
): ResolvedTarget | null {
  const byId = new Map(printers.map((p) => [p.id, p]));
  const route = routes.find((r) => r.role === "receipt" && ftMatch(r, fulfillmentType));
  if (route) {
    const p = byId.get(route.printer_id);
    if (p && isActive(p)) return { printer: toPrinterEntry(p), copies: Math.max(1, route.copies ?? 1), fallback: false };
  }
  const receiptPrinter = printers.filter(isActive).find((p) => p.printer_mode === "receipt");
  if (receiptPrinter) return { printer: toPrinterEntry(receiptPrinter), copies: 1, fallback: true };
  const fb = fallbackPrinter(printers);
  return fb ? { printer: toPrinterEntry(fb), copies: 1, fallback: true } : null;
}
```

- [ ] **Step 4: Run tests to pass**

Run: `pnpm test src/print/router.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add src/print/router.ts src/print/router.test.ts
git commit -m "feat(print): pure routing resolver with never-drop fallback"
```

---

### Task 4: Pure render-input builders + job ids (`src/print/render-map.ts`)

**Files:**
- Create: `src/print/render-map.ts`
- Test: `src/print/render-map.test.ts`

- [ ] **Step 1: Write the failing tests**

`src/print/render-map.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { buildKotInput, buildReceiptInput, kotJobId, receiptJobId, type OrderRow, type ItemRow } from "./render-map";

const order: OrderRow = {
  id: "OFF-1-2", reference: "OFF-1-2", status: "open", source: "pos",
  table_id: "t1", guest_name: null, covers: 2, fields: JSON.stringify({ orderType: "dine_in" }),
  subtotal: 100, tax_amount: 16, service_charge_amount: 0, discount_amount: 0,
  total_amount: 116, paid_amount: 116, created_at: 1_700_000_000_000,
};
const items: ItemRow[] = [
  { id: "i1", name: "Karahi", quantity: 1, unit_price: 100, total_price: 100, modifiers: "[]", notes: null, course: null, station_id: "s-kitchen" },
];

describe("job ids are deterministic", () => {
  it("kotJobId is stable per order/station/seq", () => {
    expect(kotJobId("OFF-1-2", "s-kitchen", 1)).toBe("OFF:OFF-1-2:kot:s-kitchen:1");
  });
  it("receiptJobId is stable per order/payment", () => {
    expect(receiptJobId("OFF-1-2", "pay-9")).toBe("OFF:OFF-1-2:receipt:pay-9");
  });
});

describe("buildKotInput", () => {
  it("maps items and station, no money", () => {
    const inp = buildKotInput(order, items, { id: "s-kitchen", name: "Kitchen", label: "🔥 Kitchen" }, "Table 1", "10:00");
    expect(inp.referenceNumber).toBe("OFF-1-2");
    expect(inp.stationName).toBe("Kitchen");
    expect(inp.items[0]).toMatchObject({ name: "Karahi", quantity: 1 });
    expect((inp as any).total).toBeUndefined();
  });
});

describe("buildReceiptInput", () => {
  it("converts rupees to paisa", () => {
    const inp = buildReceiptInput(order, items, [{ method: "cash", amount: 116, tip: 0 }], { name: "Kliovo Cafe", address: "DHA", phone: "042", tax_lines: "[]", logo_bytes: null }, "10:00", "2026-07-21");
    expect(inp.totalPaisa).toBe(11600);
    expect(inp.items[0].unitPricePaisa).toBe(10000);
    expect(inp.header.tenantName).toBe("Kliovo Cafe");
  });
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `pnpm test src/print/render-map.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement `src/print/render-map.ts`**

```ts
/**
 * Pure builders: local order/item rows → the render templates' input objects,
 * plus deterministic job ids used by the printed_jobs ledger. No I/O, no DB.
 * Receipt money is PAISA (integer); order-core stores rupees (REAL) → ×100.
 */
import type { KotInput } from "../render/templates/kot";
import type { ReceiptInput } from "../render/templates/receipt";

export interface OrderRow {
  id: string;
  reference?: string;
  status?: string;
  source?: string;
  table_id?: string | null;
  guest_name?: string | null;
  covers?: number | null;
  fields?: string;
  subtotal?: number;
  tax_amount?: number;
  service_charge_amount?: number;
  discount_amount?: number;
  total_amount?: number;
  paid_amount?: number;
  created_at?: number;
}

export interface ItemRow {
  id: string;
  name?: string;
  quantity?: number;
  unit_price?: number;
  total_price?: number;
  modifiers?: string;
  notes?: string | null;
  course?: string | null;
  station_id?: string | null;
}

export interface StationRow {
  id: string;
  name?: string;
  label?: string;
}

export interface BrandingRow {
  name?: string | null;
  address?: string | null;
  phone?: string | null;
  tax_lines?: string;
  logo_bytes?: Buffer | null;
}

export interface PaymentIn {
  method: string;
  amount: number;
  tip?: number;
  reference?: string;
}

const toPaisa = (rupees: number | null | undefined) => Math.round((Number(rupees) || 0) * 100);
const orderType = (o: OrderRow): string => {
  try {
    const f = JSON.parse(o.fields || "{}");
    return String(f.orderType || o.source || "dine_in");
  } catch {
    return o.source || "dine_in";
  }
};
const parseMods = (s?: string): { name: string }[] => {
  try {
    const a = JSON.parse(s || "[]");
    return Array.isArray(a) ? a.map((m: any) => ({ name: String(m?.name ?? m) })) : [];
  } catch {
    return [];
  }
};

export function kotJobId(orderId: string, stationId: string | null, seq: number): string {
  return `OFF:${orderId}:kot:${stationId ?? "none"}:${seq}`;
}

export function receiptJobId(orderId: string, paymentId: string): string {
  return `OFF:${orderId}:receipt:${paymentId}`;
}

export function buildKotInput(
  order: OrderRow,
  items: ItemRow[],
  station: StationRow | null,
  tableName: string | undefined,
  fireTime: string,
  fireDate?: string
): KotInput {
  return {
    referenceNumber: order.reference || order.id,
    stationName: station?.name || station?.label || "KITCHEN",
    tableName,
    guestName: order.guest_name ?? undefined,
    orderType: orderType(order),
    fireTime,
    fireDate,
    items: items.map((it) => ({
      name: it.name || "Item",
      quantity: Number(it.quantity) || 1,
      modifiers: parseMods(it.modifiers),
      notes: it.notes ?? undefined,
      course: it.course ?? undefined,
    })),
  };
}

export function buildReceiptInput(
  order: OrderRow,
  items: ItemRow[],
  payments: PaymentIn[],
  branding: BrandingRow | null,
  time: string,
  date: string,
  tableName?: string
): ReceiptInput {
  const subtotalPaisa = toPaisa(order.subtotal);
  const taxPaisa = toPaisa(order.tax_amount);
  const totalPaisa = toPaisa(order.total_amount);
  const paidPaisa = toPaisa(order.paid_amount);
  let taxLines: string[] = [];
  try {
    taxLines = JSON.parse(branding?.tax_lines || "[]");
  } catch {
    taxLines = [];
  }
  return {
    header: {
      tenantName: branding?.name || "Receipt",
      addressLines: branding?.address ? [branding.address] : undefined,
      phone: branding?.phone ?? undefined,
      taxLines,
      rasterLogo: undefined, // logo raster prep is a template concern; bytes cached in branding.logo_bytes
    },
    referenceNumber: order.reference || order.id,
    date,
    time,
    orderType: orderType(order),
    tableName,
    covers: order.covers ?? undefined,
    items: items.map((it) => ({
      name: it.name || "Item",
      quantity: Number(it.quantity) || 1,
      unitPricePaisa: toPaisa(it.unit_price),
      totalPaisa: toPaisa(it.total_price),
      modifiers: parseMods(it.modifiers).map((m) => ({ name: m.name, pricePaisa: 0 })),
      notes: it.notes ?? undefined,
    })),
    subtotalPaisa,
    taxes: taxPaisa > 0 ? [{ label: "Tax", rate: 0, amountPaisa: taxPaisa }] : undefined,
    serviceChargePaisa: toPaisa(order.service_charge_amount) || undefined,
    totalPaisa,
    paidPaisa,
    balanceDuePaisa: Math.max(0, totalPaisa - paidPaisa),
    payments: payments.map((p) => ({
      method: p.method,
      amountPaisa: toPaisa(p.amount),
      tipPaisa: toPaisa(p.tip),
      reference: p.reference,
    })),
  };
}
```

> Note: `receipt.ts` requires more fields than shown (`discounts`, `tipPaisa`, `customer`, etc.) but all are optional in `ReceiptInput`. If `pnpm build` reports a missing required field, add it here with a sensible default; do not weaken the `ReceiptInput` type.

- [ ] **Step 4: Run tests + typecheck**

Run: `pnpm test src/print/render-map.test.ts && pnpm build`
Expected: tests PASS, `tsc` clean.

- [ ] **Step 5: Commit**

```bash
git add src/print/render-map.ts src/print/render-map.test.ts
git commit -m "feat(print): pure KOT/receipt input builders + deterministic job ids"
```

---

### Task 5: Print-repo DB helpers (`src/store/print-repo.ts`)

**Files:**
- Create: `src/store/print-repo.ts`

Keeps fire's DB access out of the already-large `repo.ts`. No unit test (DB layer) — exercised by the integration script (Task 9).

- [ ] **Step 1: Implement `src/store/print-repo.ts`**

```ts
/**
 * DB reads/writes the fire orchestrator needs. Thin wrappers over the encrypted
 * store; kept separate from repo.ts so the print path is self-contained.
 */
import { getStore } from "./db";
import type { OrderRow, ItemRow, StationRow, BrandingRow } from "../print/render-map";
import type { MirroredPrinter, MirroredRoute } from "../print/router";

export function getOrderRow(orderId: string): OrderRow | null {
  return (getStore().prepare("SELECT * FROM orders WHERE id = ?").get(orderId) as OrderRow) ?? null;
}

/** All items for an order, oldest first. */
export function getOrderItems(orderId: string): ItemRow[] {
  return getStore()
    .prepare("SELECT * FROM order_items WHERE order_id = ? ORDER BY sort_order ASC, created_at ASC")
    .all(orderId) as ItemRow[];
}

/** Items not yet fired to the kitchen (fired_at IS NULL) — for incremental KOTs. */
export function getUnfiredItems(orderId: string): ItemRow[] {
  return getStore()
    .prepare("SELECT * FROM order_items WHERE order_id = ? AND fired_at IS NULL ORDER BY sort_order ASC, created_at ASC")
    .all(orderId) as ItemRow[];
}

export function markItemsFired(itemIds: string[], now: number = Date.now()): void {
  if (itemIds.length === 0) return;
  const ph = itemIds.map(() => "?").join(", ");
  getStore().prepare(`UPDATE order_items SET fired_at = ? WHERE id IN (${ph})`).run(now, ...itemIds);
}

export function getPayment(orderId: string, paymentId: string): { id: string; method: string; amount: number; tip: number } | null {
  return (
    (getStore().prepare("SELECT * FROM order_payments WHERE id = ? AND order_id = ?").get(paymentId, orderId) as any) ?? null
  );
}

export function getMirroredPrinters(): MirroredPrinter[] {
  return getStore().prepare("SELECT * FROM printers").all() as MirroredPrinter[];
}

export function getMirroredRoutes(): MirroredRoute[] {
  return getStore().prepare("SELECT * FROM print_routing").all() as MirroredRoute[];
}

export function getStation(stationId: string | null): StationRow | null {
  if (!stationId) return null;
  return (getStore().prepare("SELECT * FROM kitchen_stations WHERE id = ?").get(stationId) as StationRow) ?? null;
}

export function getBranding(): BrandingRow | null {
  return (getStore().prepare("SELECT * FROM branding LIMIT 1").get() as BrandingRow) ?? null;
}

export function getTableName(tableId: string | null | undefined): string | undefined {
  if (!tableId) return undefined;
  const row = getStore().prepare("SELECT name FROM tables WHERE id = ?").get(tableId) as { name?: string } | undefined;
  return row?.name;
}
```

- [ ] **Step 2: Typecheck**

Run: `pnpm build`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add src/store/print-repo.ts
git commit -m "feat(store): print-repo helpers for the fire path"
```

---

### Task 6: Fire orchestrator (`src/print/fire.ts`)

**Files:**
- Create: `src/print/fire.ts`

Glue: build (pure) → render (`renderJob`) → deliver (`deliverToPrinter`) → ledger (`hasPrinted`/`markPrinted`). Every function is best-effort: a print failure is logged + recorded to health, never thrown into the order-write path.

- [ ] **Step 1: Implement `src/print/fire.ts`**

```ts
/**
 * Auto-print-on-fire. Triggered implicitly by the bridge POS handlers after a
 * successful order write. Shares renderJob + the printed_jobs ledger with the
 * cloud poll path (one print path, two triggers). Never throws to the caller.
 */
import { renderJob, renderContextFromPrinter } from "../render";
import { deliverToPrinter } from "../deliver";
import { hasPrinted, markPrinted } from "../store/print-ledger";
import { recordResult } from "../health";
import { logger } from "../logger";
import { resolveKotTargets, resolveReceiptTarget, type ResolvedTarget } from "./router";
import { buildKotInput, buildReceiptInput, kotJobId, receiptJobId } from "./render-map";
import * as pr from "../store/print-repo";

function fmtTime(ms: number): { time: string; date: string } {
  const d = new Date(ms);
  return {
    time: d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" }),
    date: d.toLocaleDateString("en-GB"),
  };
}

async function deliverOnce(jobId: string, target: ResolvedTarget, bytes: Buffer, label: string): Promise<void> {
  if (hasPrinted(jobId)) {
    logger.info(`[fire] ${jobId} already printed — skipping (dedup)`);
    return;
  }
  try {
    for (let i = 0; i < target.copies; i++) {
      await deliverToPrinter(target.printer, bytes);
    }
    markPrinted(jobId, target.printer.printerId, target.printer.agentKey);
    recordResult(target.printer.printerId, true);
    if (target.fallback) {
      logger.warn(`[fire] ${label} used FALLBACK printer ${target.printer.printerId} — routing incomplete`);
      recordResult(target.printer.printerId, true, "fallback-route");
    }
  } catch (e) {
    logger.error(`[fire] ${label} delivery failed on ${target.printer.printerId}: ${(e as Error).message}`);
    recordResult(target.printer.printerId, false, (e as Error).message);
  }
}

/** Fire KOTs for the given items (grouped by station). Marks them fired. */
async function fireKotsForItems(orderId: string, items: pr_ItemRow[]): Promise<void> {
  if (items.length === 0) return;
  const order = pr.getOrderRow(orderId);
  if (!order) return;
  const printers = pr.getMirroredPrinters();
  const routes = pr.getMirroredRoutes();
  const ft = order.source || "dine_in";
  const tableName = pr.getTableName(order.table_id ?? undefined);
  const { time, date } = fmtTime(order.created_at || Date.now());

  const byStation = new Map<string | null, pr_ItemRow[]>();
  for (const it of items) {
    const key = it.station_id ?? null;
    (byStation.get(key) ?? byStation.set(key, []).get(key)!).push(it);
  }

  let seq = Date.now(); // monotonic-ish; only needs to be unique per (order, station)
  for (const [stationId, stationItems] of byStation) {
    const targets = resolveKotTargets(printers, routes, ft, stationId);
    if (targets.length === 0) {
      logger.error(`[fire] order ${orderId} station ${stationId}: NO active printers — cannot print KOT`);
      continue; // items stay unfired so a later fire / reprint can retry
    }
    const station = pr.getStation(stationId);
    const input = buildKotInput(order, stationItems, station, tableName, time, date);
    const bytes = renderJob({ kind: "kot", input }, renderContextFromPrinter(targets[0].printer));
    const jobId = kotJobId(orderId, stationId, seq++);
    for (const target of targets) {
      await deliverOnce(`${jobId}:${target.printer.printerId}`, target, bytes, `KOT ${orderId}/${stationId}`);
    }
    pr.markItemsFired(stationItems.map((i) => i.id));
  }
}

/** create → fire KOTs for ALL items. */
export async function fireOnCreate(orderId: string): Promise<void> {
  try {
    await fireKotsForItems(orderId, pr.getUnfiredItems(orderId));
  } catch (e) {
    logger.error(`[fire] fireOnCreate ${orderId}: ${(e as Error).message}`);
  }
}

/** add-item → fire KOTs for only the not-yet-fired items. */
export async function fireOnAddItem(orderId: string): Promise<void> {
  try {
    await fireKotsForItems(orderId, pr.getUnfiredItems(orderId));
  } catch (e) {
    logger.error(`[fire] fireOnAddItem ${orderId}: ${(e as Error).message}`);
  }
}

/** pay → print the receipt to the receipt printer. */
export async function fireReceipt(orderId: string, paymentId: string): Promise<void> {
  try {
    const order = pr.getOrderRow(orderId);
    if (!order) return;
    const printers = pr.getMirroredPrinters();
    const routes = pr.getMirroredRoutes();
    const target = resolveReceiptTarget(printers, routes, order.source || "dine_in");
    if (!target) {
      logger.error(`[fire] order ${orderId}: NO active printers — cannot print receipt`);
      return;
    }
    const items = pr.getOrderItems(orderId);
    const pay = pr.getPayment(orderId, paymentId);
    const payments = pay ? [{ method: pay.method, amount: pay.amount, tip: pay.tip }] : [];
    const branding = pr.getBranding();
    const { time, date } = fmtTime(Date.now());
    const tableName = pr.getTableName(order.table_id ?? undefined);
    const input = buildReceiptInput(order, items, payments, branding, time, date, tableName);
    const bytes = renderJob({ kind: "receipt", input }, renderContextFromPrinter(target.printer));
    await deliverOnce(receiptJobId(orderId, paymentId), target, bytes, `receipt ${orderId}`);
  } catch (e) {
    logger.error(`[fire] fireReceipt ${orderId}: ${(e as Error).message}`);
  }
}
```

> `pr_ItemRow` in the code above is `import type { ItemRow as pr_ItemRow } from "../print/render-map";` — add that import at the top. (Named to avoid clashing with any local `ItemRow`.)

- [ ] **Step 2: Add the ItemRow type import**

At the top of `src/print/fire.ts` add:

```ts
import type { ItemRow as pr_ItemRow } from "../print/render-map";
```

- [ ] **Step 3: Verify `recordResult` signature**

Run: `grep -n "export function recordResult" src/health.ts`
If its signature is not `recordResult(printerId: string, ok: boolean, note?: string)`, adapt the three `recordResult(...)` calls above to match the real signature (do not change health.ts).

- [ ] **Step 4: Typecheck**

Run: `pnpm build`
Expected: clean (fix any receipt-required-field errors in render-map per Task 4 note).

- [ ] **Step 5: Commit**

```bash
git add src/print/fire.ts
git commit -m "feat(print): fire orchestrator — routed KOT + receipt, exactly-once, never-drop"
```

---

### Task 7: Wire fire into the bridge POS handlers

**Files:**
- Modify: `src/bridge-server.ts` (POS order routes, ~lines 301-323)

Fire runs **after** the repo write succeeds, and its promise is not awaited by the response (print must never delay or fail the order-capture ACK).

- [ ] **Step 1: Import the fire functions**

At the top of `src/bridge-server.ts` add:

```ts
import { fireOnCreate, fireOnAddItem, fireReceipt } from "./print/fire";
```

- [ ] **Step 2: Fire on create / add-item / pay**

In the `/local/pos/order/*` block, replace these lines:

```ts
                  if (route === "/local/pos/order/create") return okp({ order: createOrder(b) });
                  if (route === "/local/pos/order/pay") return okp({ order: addPayment(b.orderId, b) });
```
```ts
                  if (route === "/local/pos/order/add-item") return okp({ order: addItem(b.orderId, b.item) });
```

with:

```ts
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
                  if (route === "/local/pos/order/add-item") {
                    const order = addItem(b.orderId, b.item) as { id: string };
                    void fireOnAddItem(order.id);
                    return okp({ order });
                  }
```

> If `addPayment` does not return the new payment id, use `receiptJobId(orderId, <deterministic id from the payment>)` — check `addPayment` in `src/store/pos-repo.ts:347` and pass whatever stable id it assigns. The receipt job id MUST be stable across retries so a re-sent pay call does not double-print.

- [ ] **Step 3: Fire a void KOT on void-item (optional within P0 — keep if void-kot render input is trivial)**

Locate `/local/pos/order/void-item` and after `voidItem(...)` add `void fireVoidKot(order.id, b.itemId);` only if you add a `fireVoidKot` to `fire.ts` mirroring `fireReceipt` but rendering `{ kind: "void_kot", ... }`. If time-boxed, defer void KOT to P1 and leave a `// TODO(P1): void KOT` — voids are rare and the item is already removed from the running KOT state.

- [ ] **Step 4: Typecheck + start the agent locally**

Run: `pnpm build`
Expected: clean. (Full runtime check happens in Task 9.)

- [ ] **Step 5: Commit**

```bash
git add src/bridge-server.ts src/print/fire.ts
git commit -m "feat(bridge): auto-print on create/add-item/pay (implicit fire)"
```

---

### Task 8: Reprint endpoint (`/local/print/reprint`)

**Files:**
- Modify: `src/bridge-server.ts`
- Modify: `src/print/fire.ts` (add `reprintReceipt` / `reprintKot` that bypass the ledger)

- [ ] **Step 1: Add ledger-bypassing reprints to `fire.ts`**

```ts
/** Explicit reprint — BYPASSES printed_jobs (for jams). Renders + delivers once. */
export async function reprintReceipt(orderId: string): Promise<{ ok: boolean; error?: string }> {
  const order = pr.getOrderRow(orderId);
  if (!order) return { ok: false, error: "order not found" };
  const target = resolveReceiptTarget(pr.getMirroredPrinters(), pr.getMirroredRoutes(), order.source || "dine_in");
  if (!target) return { ok: false, error: "no active printer" };
  const branding = pr.getBranding();
  const { time, date } = fmtTime(Date.now());
  const input = buildReceiptInput(order, pr.getOrderItems(orderId), [], branding, time, date, pr.getTableName(order.table_id ?? undefined));
  const bytes = renderJob({ kind: "receipt", input }, renderContextFromPrinter(target.printer));
  try {
    await deliverToPrinter(target.printer, bytes);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

/** Reprint a station's KOT for all its items — bypasses the ledger. */
export async function reprintKot(orderId: string, stationId: string | null): Promise<{ ok: boolean; error?: string }> {
  const order = pr.getOrderRow(orderId);
  if (!order) return { ok: false, error: "order not found" };
  const items = pr.getOrderItems(orderId).filter((i) => (i.station_id ?? null) === stationId);
  if (items.length === 0) return { ok: false, error: "no items for station" };
  const targets = resolveKotTargets(pr.getMirroredPrinters(), pr.getMirroredRoutes(), order.source || "dine_in", stationId);
  if (targets.length === 0) return { ok: false, error: "no active printer" };
  const station = pr.getStation(stationId);
  const { time, date } = fmtTime(order.created_at || Date.now());
  const input = buildKotInput(order, items, station, pr.getTableName(order.table_id ?? undefined), time, date);
  input.version = 2; // reprint banner
  const bytes = renderJob({ kind: "kot", input }, renderContextFromPrinter(targets[0].printer));
  try {
    await deliverToPrinter(targets[0].printer, bytes);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}
```

- [ ] **Step 2: Add the token-gated route in `bridge-server.ts`**

Inside the `/local/pos/` token-gated block (after the `order/` handling, before `send(404, ...)`), add a sibling handler. Register the route as `/local/print/reprint` under the same `verifyToken` gate. Insert this branch alongside the pos routes:

```ts
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
```

> Note: this route lives inside `if (req.url.startsWith("/local/pos/"))`? No — `/local/print/reprint` does not match `/local/pos/`. Add it just BEFORE the `if (req.url.startsWith("/local/pos/"))` check but AFTER the `verifyToken` session check, by widening the session gate to also cover `/local/print/`. Concretely, change the guard from `if (req.url.startsWith("/local/pos/"))` to `if (req.url.startsWith("/local/pos/") || req.url.startsWith("/local/print/"))`, then place the reprint branch first inside that block.

- [ ] **Step 3: Typecheck**

Run: `pnpm build`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add src/bridge-server.ts src/print/fire.ts
git commit -m "feat(bridge): /local/print/reprint — ledger-bypassing receipt/KOT reprint"
```

---

### Task 9: Manual integration test (P0)

**Files:**
- Create: `scripts/offline-print-itest.mjs`

Runs the agent against a **local Dine clone** with a provisioned `dok_` key. Not vitest — this exercises the real encrypted DB + delivery.

- [ ] **Step 1: Write the runbook script**

`scripts/offline-print-itest.mjs`:

```js
/**
 * Manual offline auto-print integration check.
 * Prereqs:
 *   1. Local Dine clone running on 127.0.0.1 with the new snapshot batches
 *      (printers/print_routing/kitchen_stations/print_templates/branding).
 *   2. A dok_ key provisioned (see EMERGENCY-OFFLINE-MASTER-PLAN test harness).
 *   3. Agent config serverUrl -> local Dine, offlineDeviceKey -> dok_..., and at
 *      least one reachable printer (a netcat listener on :9100 is fine).
 * Steps to verify BY HAND (this script only prints the checklist + curl calls):
 */
const BASE = "http://127.0.0.1:6310";
console.log(`
OFFLINE AUTO-PRINT INTEGRATION CHECKLIST
========================================
1. Snapshot mirrored:
   - Confirm agent pulled a snapshot, then check the DB has rows:
     printers, print_routing, kitchen_stations, print_templates, branding.
2. Login (get X-Aster-Token):
   curl -s ${BASE}/local/auth -d '{"email":"...","password":"..."}'
3. Fire an order with a combo + two stations:
   curl -s ${BASE}/local/pos/order/create -H 'X-Aster-Token: <t>' -d '<order json>'
   EXPECT: one KOT per station on the mapped printer; combo shows component picks.
4. Assert exactly-once:
   - Re-POST the SAME create payload (same idempotency) -> NO second KOT.
   - Check the DB: one printed_jobs row per (jobId, printerId).
5. Incremental fire:
   curl ${BASE}/local/pos/order/add-item -H 'X-Aster-Token: <t>' -d '{"orderId":"...","item":{...}}'
   EXPECT: KOT for ONLY the new line, not the whole order.
6. Pay -> receipt:
   curl ${BASE}/local/pos/order/pay -H 'X-Aster-Token: <t>' -d '{"orderId":"...","method":"cash","amount":...}'
   EXPECT: receipt on the receipt printer, with the mirrored logo + tenant name.
7. Fallback safety:
   - Fire an order whose station has NO route.
   - EXPECT: it prints to the default printer AND /status shows a fallback warning.
   - EXPECT: the ticket is NEVER dropped.
8. Reprint:
   curl ${BASE}/local/print/reprint -H 'X-Aster-Token: <t>' -d '{"orderId":"...","kind":"receipt"}'
   EXPECT: a second receipt, NO dedup block (printed even though already printed once).
`);
```

- [ ] **Step 2: Run through the checklist against local Dine**

Run: `node scripts/offline-print-itest.mjs` then execute each step by hand.
Expected: every EXPECT line holds. Record results in the commit message.

- [ ] **Step 3: Commit**

```bash
git add scripts/offline-print-itest.mjs
git commit -m "test(print): manual offline auto-print integration checklist"
```

---

## PHASE P0b — Continuation sync + instant drain

### Task 10: Instant offline→online outbox drain

**Files:**
- Modify: `src/cloud-sync.ts`

- [ ] **Step 1: Track online-state transition and drain immediately**

In `src/cloud-sync.ts`, add module state and a transition check. After a successful snapshot fetch (proof the internet is back), if the previous cycle was offline, drain now instead of waiting for the 60s timer:

```ts
let wasOnline = false;

// call this at the end of a SUCCESSFUL syncOnce (snapshot 2xx):
function onReachable(): void {
  if (!wasOnline) {
    wasOnline = true;
    logger.info("[cloud-sync] internet restored — draining outbox immediately");
    void pushOffline().catch((e) => logger.warn(`[cloud-sync] instant drain failed: ${(e as Error).message}`));
  }
}

// on a FAILED fetch (catch / non-2xx), set wasOnline = false so the NEXT success re-triggers a drain.
```

Wire `wasOnline = false` into the existing `catch` and non-ok branches of `syncOnce`, and call `onReachable()` right after `setState("entitled", "true")`. `pushOffline` is the existing push routine (rename/point to whatever the current push function is called — see `getOfflineOrdersForPush` usage lower in the file).

- [ ] **Step 2: Typecheck + commit**

Run: `pnpm build`

```bash
git add src/cloud-sync.ts
git commit -m "feat(cloud-sync): drain outbox instantly on internet restore"
```

---

### Task 11: Continued-order op-deltas (`src/store/continued-repo.ts`)

**Files:**
- Create: `src/store/continued-repo.ts`
- Test: `src/store/continued-map.test.ts` (pure mapping only)

- [ ] **Step 1: Write the failing pure-mapping test**

`src/store/continued-map.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { changeLogRowsToOps, type ChangeLogRow } from "./continued-map";

describe("changeLogRowsToOps", () => {
  it("maps change_log rows to idempotent ops tagged with the existing order id", () => {
    const rows: ChangeLogRow[] = [
      { id: "cl1", entity_type: "order", entity_id: "ORD-9", op: "add_item", payload: JSON.stringify({ menuItemId: "m1", quantity: 1 }), created_at: 1 },
      { id: "cl2", entity_type: "order", entity_id: "ORD-9", op: "record_payment", payload: JSON.stringify({ method: "cash", amount: 500, paymentId: "p1" }), created_at: 2 },
    ];
    const ops = changeLogRowsToOps(rows);
    expect(ops).toEqual([
      { idempotencyId: "cl1", orderId: "ORD-9", op: "add_item", data: { menuItemId: "m1", quantity: 1 } },
      { idempotencyId: "cl2", orderId: "ORD-9", op: "record_payment", data: { method: "cash", amount: 500, paymentId: "p1" } },
    ]);
  });
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `pnpm test src/store/continued-map.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement pure mapper `src/store/continued-map.ts`**

```ts
/** Pure: change_log rows for continued (online-origin) orders → push ops. */
export interface ChangeLogRow {
  id: string;
  entity_type: string;
  entity_id: string;
  op: string;
  payload: string;
  created_at: number;
}

export interface ContinuedOp {
  idempotencyId: string; // the change_log row id — stable, dedups server-side
  orderId: string;
  op: string;
  data: Record<string, unknown>;
}

export function changeLogRowsToOps(rows: ChangeLogRow[]): ContinuedOp[] {
  return rows
    .filter((r) => r.entity_type === "order")
    .map((r) => {
      let data: Record<string, unknown> = {};
      try {
        data = JSON.parse(r.payload || "{}");
      } catch {
        data = {};
      }
      return { idempotencyId: r.id, orderId: r.entity_id, op: r.op, data };
    });
}
```

- [ ] **Step 4: Implement `src/store/continued-repo.ts` (DB read using the pure mapper)**

```ts
import { getStore } from "./db";
import { changeLogRowsToOps, type ChangeLogRow, type ContinuedOp } from "./continued-map";

/**
 * Ops for CONTINUED orders: change_log rows whose order originated ONLINE
 * (origin='online' in the mirror) and are not yet synced. Born-offline orders
 * are handled by getOfflineOrdersForPush (full state) — excluded here.
 */
export function getContinuedOrderOpsForPush(): ContinuedOp[] {
  const rows = getStore()
    .prepare(
      `SELECT cl.* FROM change_log cl
         JOIN orders o ON o.id = cl.entity_id
        WHERE cl.entity_type = 'order'
          AND cl.synced_at IS NULL
          AND o.origin = 'online'
        ORDER BY cl.created_at ASC`
    )
    .all() as ChangeLogRow[];
  return changeLogRowsToOps(rows);
}
```

- [ ] **Step 5: Push the ops in `cloud-sync.ts`**

Add a call in the push routine that POSTs `getContinuedOrderOpsForPush()` to `POST /api/offline/orders/push` (or the server's continued-merge endpoint — confirm the exact route in the Dine repo `src/app/api/offline/` before wiring). On a 2xx, mark the corresponding `change_log` ids synced via the existing `markSynced(ids)`.

> SERVER DEPENDENCY (out of scope here, do not implement server-side): the merge endpoint must accept `{ orderId, op, idempotencyId, data }[]` and be idempotent on `idempotencyId`. If the deployed server does not yet accept ops, leave this push guarded behind a config flag and land only the local extraction — do not emit ops the server will reject.

- [ ] **Step 6: Run tests + typecheck + commit**

Run: `pnpm test && pnpm build`

```bash
git add src/store/continued-map.ts src/store/continued-map.test.ts src/store/continued-repo.ts src/cloud-sync.ts
git commit -m "feat(sync): continued-order op-deltas keyed by change_log id"
```

---

### Task 12: Load open online tabs from the mirror + log ops against existing id

**Files:**
- Modify: `src/store/pos-repo.ts`

- [ ] **Step 1: Ensure mirrored open online orders are loadable by Aster**

`orders`/`order_items` already mirror (they are in `MIRROR_TABLES`). Confirm the snapshot brings OPEN orders down with `origin='online'`. In `listOrders()` (pos-repo), ensure open online orders are returned to Aster so a live tab can be continued. If `listOrders` filters to offline-only, widen it to include `origin='online' AND status NOT IN ('completed','cancelled')`.

- [ ] **Step 2: Log edits to an online order against its EXISTING id**

In `addItem`, `addPayment`, `updateStatus`, `voidItem` (pos-repo), when the target order has `origin='online'`, write a `change_log` row: `entity_type='order'`, `entity_id=<existing ORD- id>`, `op` in (`add_item`|`record_payment`|`update_status`|`void_item`), `payload=<the change>`, `synced_at=NULL`. Born-offline orders keep their existing full-state path (do NOT also log ops for them, or they double-count). Gate on `origin`:

```ts
// inside addItem, after the DB write:
if (order.origin === "online") {
  logChange("order", order.id, "add_item", { menuItemId: item.menuItemId, quantity: item.quantity /* ... */ });
}
```

Use the existing change_log insert helper if one exists in pos-repo/repo; otherwise add a small `logChange(entityType, entityId, op, payload)` that inserts a row with a fresh id + `created_at=Date.now()`.

- [ ] **Step 3: Typecheck + commit**

Run: `pnpm build`

```bash
git add src/store/pos-repo.ts
git commit -m "feat(pos): continue open online tabs offline; log ops against existing id"
```

---

### Task 13: Structured combo payload (drop the `COMBO:` notes hack)

**Files:**
- Modify: `src/store/repo.ts` (`getOfflineOrdersForPush` item mapping)

- [ ] **Step 1: Emit structured combo items**

In `getOfflineOrdersForPush`, where items are mapped, when an item represents a combo (it carries a `combo_id`/combo fields), emit:

```ts
{ comboId, comboName, comboPrice, picks: [{ groupId, menuItemId, variantId, upcharge }], quantity }
```

instead of encoding combo info in `notes` as `COMBO:`. Plain items keep the existing `{ menuItemId, name, quantity, unitPrice, modifiers, notes, stationId }` shape. Read combo picks from the mirrored `combo_groups`/`combo_group_items` if the local item stored only a `combo_id` + selections.

> If the local schema does not yet persist combo picks on offline items, that capture must be added in Aster/pos-repo first. Confirm where combo selections are stored on an offline `order_items` row before mapping; do not invent fields.

- [ ] **Step 2: Typecheck + commit**

Run: `pnpm build`

```bash
git add src/store/repo.ts
git commit -m "feat(sync): structured combo payload in offline order push"
```

---

### Task 14: Continuation integration test

**Files:**
- Modify: `scripts/offline-print-itest.mjs` (append a P0b section)

- [ ] **Step 1: Append the continuation checklist**

Add to the script's output:

```
CONTINUATION + INSTANT DRAIN CHECKLIST
======================================
9.  Open an ORD- tab ONLINE, confirm it comes down in the snapshot (open status).
10. Kill internet. In Aster, add an item + take a cash payment on that ORD- tab.
    EXPECT: KOT for the new item prints; receipt prints on pay (local fire path).
11. Confirm change_log has op rows tagged with the ORD- id (not a new OFF- order).
12. Restore internet.
    EXPECT: within ~1s (not 60s), the agent drains: born-offline orders push full
    state; the ORD- tab pushes op-deltas; change_log rows get synced_at set.
13. On the server, confirm the ORD- order MERGED (new item appended, payment
    recorded once, attached to the shift open at sync time) — no duplicate order.
```

- [ ] **Step 2: Run through it against local Dine, record results, commit**

```bash
git add scripts/offline-print-itest.mjs
git commit -m "test(sync): continuation + instant-drain integration checklist"
```

---

## Self-Review Notes (coverage map)

- Mirror 5 tables + logo bytes → Task 2 (schema) + Task 2 (`MIRROR_TABLES`).
- Routing resolver with never-drop fallback → Task 3.
- Auto-print-on-fire (create/add-item/pay), incremental via `fired_at` → Tasks 4–7.
- Exactly-once via shared `printed_jobs` ledger → Task 6 (`deliverOnce` uses `hasPrinted`/`markPrinted`).
- Reprint bypassing dedup → Task 8.
- Instant outbox drain → Task 10.
- Continued-order op-deltas keyed by `change_log.id` → Tasks 11–12.
- Structured combo payload → Task 13.
- Fallback flagged in `/status` → Task 6 (`recordResult(..., "fallback-route")`).

**Known server-side dependencies (handled by you / Dine session, NOT this plan):**
1. Snapshot must ADD the 5 batches (printers/routing/stations/templates/branding) with logo as base64 bytes.
2. Snapshot must ship OPEN orders (origin online) for continuation.
3. A continued-order MERGE endpoint idempotent on `idempotencyId`.
Tasks 11–13 are guarded so the agent does not emit payloads the deployed server rejects.
