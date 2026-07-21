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
