/**
 * Manual offline auto-print integration check.
 * Prereqs:
 *   1. Local Dine clone running on 127.0.0.1 with the new snapshot batches
 *      (printers/print_routing/kitchen_stations/print_templates/branding).
 *   2. A dok_ key provisioned (see EMERGENCY-OFFLINE-MASTER-PLAN test harness).
 *   3. Agent config serverUrl -> local Dine, offlineDeviceKey -> dok_..., and at
 *      least one reachable printer (a netcat listener on :9100 is fine).
 * This script only PRINTS the checklist + curl calls; run each step BY HAND.
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
   - EXPECT: it prints to the default printer AND the agent log shows a
     "used FALLBACK printer ... routing incomplete" warning.
   - EXPECT: the ticket is NEVER dropped.
8. Reprint:
   curl ${BASE}/local/print/reprint -H 'X-Aster-Token: <t>' -d '{"orderId":"...","kind":"receipt"}'
   EXPECT: a second receipt, NO dedup block (printed even though already printed once).

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
`);
