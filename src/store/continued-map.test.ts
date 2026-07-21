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
