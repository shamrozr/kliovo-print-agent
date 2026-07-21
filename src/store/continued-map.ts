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
  idempotencyId: string;
  orderId: string;
  op: string;
  data: Record<string, unknown>;
}

export function changeLogRowsToOps(rows: ChangeLogRow[]): ContinuedOp[] {
  return rows.map((r) => {
    let data: Record<string, unknown> = {};
    try {
      data = JSON.parse(r.payload || "{}");
    } catch {
      data = {};
    }
    return { idempotencyId: r.id, orderId: r.entity_id, op: r.op, data };
  });
}
