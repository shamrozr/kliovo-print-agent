# Kliovo Agent — Emergency Offline Execution Plan (local brain)

> Master plan + shared contract live in
> `../Kliovo-Dine/docs/offline/EMERGENCY-OFFLINE-MASTER-PLAN.md`. Read it first.
> This repo = the always-on local brain: encrypted SQLite + order-core + printing
> + the `/local/*` bridge Aster calls. Repo: `kliovo-print-agent` (v2.7.0).

## Role (locked)
- Owns the encrypted local store (SQLCipher), order-core, and **all printing**.
- Mirrors the cloud snapshot down; captures offline orders; **prints locally**.
- On reconnect, drains its outbox up to the cloud. Behind NAT → Agent-initiated.
- No stock, no combo explosion, no shift logic (all server-side on reconcile).

## Current state (verified)
- `src/store/schema.ts` — near-complete cashier schema: users (password+pin
  hashes), orders/items/payments, shifts/drawer, combos, `change_log` outbox,
  `printed_jobs` dedup ledger. **No printers / routing / stations / templates /
  logo tables.**
- `src/cloud-sync.ts` — 60s cycle: `applyMirror(snapshot)` down +
  `getOfflineOrdersForPush()` up (orders only; **no shifts** — correct per decision).
- `src/bridge-server.ts` — `/local/pos/order/{create,pay,status,add-item,void-item,
  refund}` all wired; `/render-print`, `/print`, `/ping`. **No auto-print on order
  create** — this is the critical gap.
- `src/store/pos-repo.ts` / `order-core.ts` — offline order write logic exists.
- `src/render/` — renders ESC/POS; receipt accepts a logo buffer but there is **no
  mechanism to cache the tenant logo or the real template** (uses defaults).

## P0 tasks

### 1. Mirror the new snapshot batches
Files: `src/store/schema.ts`, `src/cloud-sync.ts` (applyMirror), `src/store/repo.ts`.
- Add local tables: `printers`, `print_routing`, `kitchen_stations`,
  `receipt_template` / `kot_template` (layoutConfig JSON), `branding` (logo bytes).
- Ingest the new snapshot batches in `applyMirror`.

### 2. Auto-print-on-fire (THE core mechanism)
Files: `src/bridge-server.ts`, `src/render/`, `src/store/print-ledger.ts`.
- Add a **fire hook**: when Aster fires an order (on `/local/pos/order/create`
  with a `fire:true`, or a dedicated `/local/pos/order/fire`), the Agent:
  1. Resolves each line's `stationId` → printer via the mirrored `print_routing`.
  2. Renders the **KOT(s)** per station (combo lines show their component picks,
     read from the mirrored combo tables) + the **receipt** using the mirrored
     template + logo.
  3. Sends to the LAN/USB/serial printer(s).
  4. Records each job in `printed_jobs` (exactly-once; redelivery-safe).
- **Incremental firing:** adding items to a running order fires a KOT for **only
  the new items**, not the whole order.
- This shares the *same* render + `printed_jobs` path the cloud-poll print uses
  (one print path, two triggers) so it's exercised daily and can't rot.

### 3. Reprint (local-only, no sync)
File: `src/bridge-server.ts`. Add `/local/print/reprint` for receipt or a given
KOT — **bypasses** the dedup ledger (explicit reprint for jams).

### 4. Instant outbox drain on reconnect
File: `src/cloud-sync.ts`.
- Detect internet-restore (transition offline→online) and **immediately** drain
  the outbox instead of waiting for the 60s timer.
- Push the **structured combo payload** (comboId + picks, per the contract) — stop
  emitting the `COMBO:` notes hack. Push order mutations + table state. Do **not**
  push shifts.

### 5. Running-order continuation (born-offline vs continued — NEW, P0b)
Two push shapes, decided by the order's `origin`:
- **Born-offline** (`OFF-` order created in Aster) → push **full state**
  (`getOfflineOrdersForPush`, existing path). Server creates it new.
- **Continued** (an `ORD-xxxx` order that came DOWN in the snapshot as open, then
  edited offline) → push the **op-delta from `change_log`** tagged with the
  existing order id, NOT a new `OFF-` order. Each op (`add_item`, `record_payment`,
  `update_status`, `void_item`) carries a **stable idempotency id**.
- Files: `src/cloud-sync.ts` (new `getContinuedOrderOpsForPush()` reading
  `change_log` where `entity_type=order` and the order's `origin='online'`),
  `src/store/repo.ts` / `pos-repo.ts` (loading an open online order from the
  mirror so Aster can continue it; logging edits against its existing id).
- Locally the KOT/receipt still print on fire (add-item fires an incremental KOT;
  payment prints a receipt) — same auto-print path.

## P1 tasks
- Push table occupy/free state with orders.
- Ensure `change_log` prune drops synced rows but **never** unsynced (already noted
  in schema — verify the prune job honors it).

## P2 tasks
- **Auto-restart resilience:** the Agent is the single dependency for Aster —
  ensure the tray service auto-restarts on crash; SQLite persists so state
  recovers.
- Restrict offline payment methods surfaced to Aster to **cash** (+ card only if
  the reader has offline mode).

## Testing
- Point the Agent at a local Dine (`serverUrl` = local), provision a `dok_` key.
- Pull snapshot → assert new tables populated (printers/routing/stations/template/
  logo). Fire an order with a combo → assert KOT routed to the right printer with
  combo components + receipt with logo, and a single `printed_jobs` row. Reprint →
  a second print, no dedup. Kill internet → create orders → restore → assert
  instant push.
