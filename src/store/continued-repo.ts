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

/** The change_log ids behind the ops, for markSynced after a successful push. */
export function getContinuedOpIds(): string[] {
  const rows = getStore()
    .prepare(
      `SELECT cl.id FROM change_log cl
         JOIN orders o ON o.id = cl.entity_id
        WHERE cl.entity_type = 'order'
          AND cl.synced_at IS NULL
          AND o.origin = 'online'
        ORDER BY cl.created_at ASC`
    )
    .all() as Array<{ id: string }>;
  return rows.map((r) => r.id);
}
