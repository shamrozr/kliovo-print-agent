/**
 * Receipt template — customer-facing thermal receipt.
 *
 * Per DECISIONS D8.2: receipt MUST carry the FBR invoice number when
 * available, otherwise print a "FBR pending" placeholder. The FBR worker
 * will trigger a reprint once the FBR ack lands.
 *
 * Per DECISIONS D11: rendered server-side, additive to existing
 * `receipt-renderer.ts` (which still produces HTML + structured ESC/POS
 * for the legacy code path).
 */

import { formatPaisa } from "../format-paisa";
import { ESCPOSBuilder, CP_WPC1256 } from "../builder";
import type { LayoutConfig, FontSize, Alignment } from "../designer-types";

export type PaperWidth = 80 | 58;

export interface ReceiptHeader {
  /** Restaurant / tenant display name */
  tenantName: string;
  /** Branch label, e.g. "DHA Phase 5" */
  branchName?: string;
  /** Free-form address lines (1-3 lines recommended) */
  addressLines?: string[];
  /** Contact phone, NTN, etc. — printed below address */
  phone?: string;
  /** FBR/NTN/STRN combined or split — printed centred under contact */
  taxLines?: string[];
  /** Pre-rendered raster logo (1bpp) and dimensions */
  rasterLogo?: { bytes: Buffer; widthBytes: number; heightDots: number };
}

export interface ReceiptFooter {
  /** Free-form thank-you / promo lines */
  lines?: string[];
  /** If present, render a QR linking to public receipt / review */
  qrLink?: string;
  /** If present, render the FBR invoice verification QR */
  fbrVerifyUrl?: string;
}

export interface ReceiptItem {
  name: string;
  /** Optional Urdu / second-language line, rendered under primary name */
  nameAlt?: string;
  quantity: number;
  unitPricePaisa: number;
  totalPaisa: number;
  modifiers?: { name: string; pricePaisa: number }[];
  notes?: string;
}

export interface ReceiptPayment {
  method: string;
  amountPaisa: number;
  tipPaisa?: number;
  reference?: string;
}

export interface ReceiptInput {
  paperWidth?: PaperWidth;
  header: ReceiptHeader;
  footer?: ReceiptFooter;

  /** Order reference, e.g. ORD-00123 */
  referenceNumber: string;
  /** Pre-formatted date string (tenant timezone aware) */
  date: string;
  /** Pre-formatted time string (tenant timezone aware) */
  time: string;
  /** dine_in | takeaway | delivery | etc. */
  orderType: string;
  tableName?: string;
  serverName?: string;
  covers?: number;
  customer?: { name?: string; phone?: string };
  deliveryAddress?: string;
  specialRequests?: string;

  items: ReceiptItem[];
  subtotalPaisa: number;
  discounts?: { label: string; amountPaisa: number; percentage?: number }[];
  taxes?: { label: string; rate: number; amountPaisa: number }[];
  serviceChargePaisa?: number;
  tipPaisa?: number;
  totalPaisa: number;
  paidPaisa: number;
  balanceDuePaisa: number;
  payments: ReceiptPayment[];

  /** FBR invoice number from gateway (per D8.2). Empty → "FBR pending". */
  fbrInvoiceNumber?: string | null;
  /** Stamp version of the receipt (for reprints). */
  version?: number;
  layoutConfig?: LayoutConfig;
}

const formatMoney = (paisa: number) => `Rs ${formatPaisa(paisa)}`;

function applySize(b: ESCPOSBuilder, size: FontSize | undefined, fallback: FontSize = "normal"): ESCPOSBuilder {
  return b.size(size ?? fallback);
}
function applyAlign(b: ESCPOSBuilder, align: Alignment | undefined, fallback: Alignment = "left"): ESCPOSBuilder {
  return b.align(align ?? fallback);
}

export function renderReceipt(input: ReceiptInput): Buffer {
  const pw: PaperWidth = input.paperWidth === 58 ? 58 : 80;
  const width = pw === 80 ? 48 : 32;

  const lc = input.layoutConfig ?? {};
  const headerStyle  = (lc.header   ?? {}) as any;
  const footerStyle  = (lc.footer   ?? {}) as any;
  const totalsStyle  = (lc.totals   ?? {}) as any;

  const b = new ESCPOSBuilder().init().codePage(CP_WPC1256);

  // ── Header ────────────────────────────────────────────────
  if (input.header.rasterLogo) {
    const { bytes, widthBytes, heightDots } = input.header.rasterLogo;
    b.align("center").rasterImage(bytes, widthBytes, heightDots).newline();
  }

  applyAlign(b, headerStyle.align, "center");
  applySize(b, headerStyle.nameSize, "large").bold(headerStyle.bold ?? true)
    .line(input.header.tenantName).bold(false).size("normal");

  if (input.header.branchName) b.line(input.header.branchName);
  for (const addr of input.header.addressLines ?? []) b.line(addr);
  if (input.header.phone) b.line(input.header.phone);
  for (const tx of input.header.taxLines ?? []) b.line(tx);

  b.rule(pw, "=").align("left");

  // ── Order meta ────────────────────────────────────────────
  b.bold(true).line(input.referenceNumber).bold(false);
  b.row(input.date, input.time, pw);
  b.row("Type", input.orderType.toUpperCase(), pw);
  if (input.tableName) b.row("Table", input.tableName, pw);
  if (input.serverName) b.row("Server", input.serverName, pw);
  if (input.covers) b.row("Covers", String(input.covers), pw);
  if (input.customer?.name) b.row("Customer", input.customer.name, pw);
  if (input.customer?.phone) b.row("Phone", input.customer.phone, pw);
  if (input.deliveryAddress) {
    b.line("Address:");
    for (const ln of wrap(input.deliveryAddress, width)) b.line(`  ${ln}`);
  }
  if (input.specialRequests) {
    b.line("Notes:");
    for (const ln of wrap(input.specialRequests, width)) b.line(`  ${ln}`);
  }

  b.rule(pw);

  // ── Items ────────────────────────────────────────────────
  for (const item of input.items) {
    const left = `${item.quantity} x ${item.name}`;
    const right = formatMoney(item.totalPaisa);
    b.row(truncate(left, width - right.length - 1), right, pw);
    if (item.nameAlt) {
      // Urdu/RTL line — printed indented so it visually attaches to its
      // English sibling. CP1256 handles glyphs; printer firmware handles
      // RTL display.
      b.line(`  ${item.nameAlt}`);
    }
    for (const mod of item.modifiers ?? []) {
      const mLeft = `  + ${mod.name}`;
      const mRight = mod.pricePaisa ? formatMoney(mod.pricePaisa) : "";
      if (mRight) b.row(mLeft, mRight, pw); else b.line(mLeft);
    }
    if (item.notes) for (const ln of wrap(item.notes, width - 4)) b.line(`    ${ln}`);
  }

  b.rule(pw);

  // ── Totals ───────────────────────────────────────────────
  b.row("Subtotal", formatMoney(input.subtotalPaisa), pw);
  for (const d of input.discounts ?? []) {
    const label = d.percentage ? `${d.label} (${d.percentage}%)` : d.label;
    b.row(label, `- ${formatMoney(d.amountPaisa)}`, pw);
  }
  for (const t of input.taxes ?? []) {
    b.row(`${t.label} (${t.rate}%)`, formatMoney(t.amountPaisa), pw);
  }
  if (input.serviceChargePaisa) b.row("Service", formatMoney(input.serviceChargePaisa), pw);
  if (input.tipPaisa) b.row("Tip", formatMoney(input.tipPaisa), pw);

  b.rule(pw, "=");
  b.size("large").bold(true).row("TOTAL", formatMoney(input.totalPaisa), pw).bold(false).size("normal");
  b.rule(pw, "=");

  // ── Payments ─────────────────────────────────────────────
  for (const p of input.payments) {
    const label = p.reference ? `${p.method.toUpperCase()} (${p.reference})` : p.method.toUpperCase();
    b.row(label, formatMoney(p.amountPaisa), pw);
  }
  if (input.balanceDuePaisa > 0) {
    b.bold(true).row("BALANCE DUE", formatMoney(input.balanceDuePaisa), pw).bold(false);
  } else {
    b.row("PAID", formatMoney(input.paidPaisa), pw);
  }

  // ── FBR ──────────────────────────────────────────────────
  if (input.fbrInvoiceNumber) {
    b.newline().align("center").bold(true).line(`FBR # ${input.fbrInvoiceNumber}`).bold(false);
    if (input.footer?.fbrVerifyUrl) {
      b.qr(input.footer.fbrVerifyUrl, { size: 5, ec: "M" });
      b.line("Scan to verify with FBR");
    }
  }

  // ── Footer ───────────────────────────────────────────────
  if (input.footer?.qrLink) {
    b.newline().qr(input.footer.qrLink, { size: 5, ec: "M" });
  }
  const footerLines = footerStyle.lines ?? input.footer?.lines ?? [];
  if (footerLines.length > 0) {
    b.newline();
    for (const ln of footerLines) {
      b.align(footerStyle.align ?? "center").line(ln);
    }
  }
  // Fixed branding — not removable by tenant
  b.newline().align("center").size("small").line("Powered by Kliovo Dine").size("normal");

  return b.feed(5).cut(true).build();
}

// ── Local helpers ────────────────────────────────────────────

function wrap(s: string, width: number): string[] {
  const out: string[] = [];
  const words = s.split(/\s+/);
  let line = "";
  for (const w of words) {
    if ((line + " " + w).trim().length > width) {
      if (line) out.push(line);
      line = w;
    } else {
      line = (line ? line + " " : "") + w;
    }
  }
  if (line) out.push(line);
  return out.length ? out : [s.slice(0, width)];
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}
