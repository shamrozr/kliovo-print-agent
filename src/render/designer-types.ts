/**
 * VENDORED from Kliovo-Dine: src/lib/print/designer/types.ts
 * Keep in sync with the canonical source. Types + defaults only.
 */
export type FontSize = "small" | "normal" | "large" | "xlarge";
export type Alignment = "left" | "center" | "right";
export type SectionKey = "header" | "orderMeta" | "items" | "totals" | "payments" | "footer";

export interface SectionStyle {
  visible?: boolean;
  fontSize?: FontSize;
  align?: Alignment;
  bold?: boolean;
}

export interface TaxConfig {
  cashTaxRate: number;
  cardTaxRate: number;
  taxLabel: string;
  showTaxLine: boolean;
  digitalMethods: string[];
}

export interface LayoutConfig {
  paperWidth?: 58 | 80;
  header?: SectionStyle & { nameSize?: FontSize; lines?: string[] };
  orderMeta?: SectionStyle;
  items?: SectionStyle;
  totals?: SectionStyle & { totalSize?: FontSize };
  payments?: SectionStyle;
  footer?: SectionStyle & { lines?: string[] };
  taxConfig?: TaxConfig;
}

export const DEFAULT_TAX_CONFIG: TaxConfig = {
  cashTaxRate: 5,
  cardTaxRate: 17,
  taxLabel: "GST",
  showTaxLine: true,
  digitalMethods: ["card", "jazzcash", "easypaisa", "bank_transfer"],
};

export const DEFAULT_LAYOUT_CONFIG: LayoutConfig = {
  header:    { visible: true, nameSize: "large",  align: "center", bold: true  },
  orderMeta: { visible: true, fontSize: "normal", align: "left"                },
  items:     { visible: true, fontSize: "normal", align: "left"                },
  totals:    { visible: true, totalSize: "large", bold: true                   },
  payments:  { visible: true, fontSize: "normal", align: "left"                },
  footer:    { visible: true, fontSize: "normal", align: "center", lines: ["Thank you for dining with us!"] },
  taxConfig: { ...DEFAULT_TAX_CONFIG },
};
