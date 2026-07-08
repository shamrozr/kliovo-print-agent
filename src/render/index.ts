/**
 * Local render dispatch for the print agent.
 *
 * The agent receives a serializable `PrintJobData` (NOT pre-rendered bytes),
 * renders it to whatever language the target printer speaks, and streams
 * it to the printer. This is what lets printing keep working with zero
 * cloud dependency: the POS builds the job from its own cache and posts
 * it straight to the agent on the LAN.
 *
 * Receipt / KOT / void-KOT are always ESC/POS — they go to receipt printers.
 * Label jobs are dispatched by the printer's `labelLanguage`: ESC/POS for
 * label-mode receipt printers, TSPL for TSC/Xprinter/Rongta, ZPL for Zebra,
 * or EPL for older Zebra. Get this wrong and the printer swallows bytes.
 */
import { renderReceipt, type ReceiptInput } from "./templates/receipt";
import { renderKot, type KotInput } from "./templates/kot";
import { renderMasterKot, type MasterKotInput } from "./templates/master-kot";
import { renderVoidKot, type VoidKotInput } from "./templates/void-kot";
import { renderLabel, type LabelInput } from "./templates/label";
import { renderLabelTSPL, type LabelSize } from "./templates/label-tspl";
import { renderLabelZPL } from "./templates/label-zpl";
import { renderLabelEPL } from "./templates/label-epl";
import type { PrinterEntry } from "../config";

/**
 * Serializable print job. `kind` discriminates which renderer runs; `input`
 * is the exact structured input that renderer expects. Everything here is
 * JSON-safe EXCEPT a receipt's raster logo, which travels as base64 (see
 * reviveReceiptLogo) and is revived to a Buffer before rendering.
 */
export type PrintJobData =
  | { kind: "receipt";    input: ReceiptInput }
  | { kind: "kot";        input: KotInput }
  | { kind: "master_kot"; input: MasterKotInput }
  | { kind: "void_kot";   input: VoidKotInput }
  | { kind: "label";      input: LabelInput };

export const PRINT_JOB_KINDS = ["receipt", "kot", "master_kot", "void_kot", "label"] as const;

/** Revive a value that may be base64, a JSON-serialized Buffer, or a Buffer. */
function reviveBuffer(v: unknown): Buffer | undefined {
  if (!v) return undefined;
  if (Buffer.isBuffer(v)) return v;
  if (typeof v === "string") return Buffer.from(v, "base64");
  if (typeof v === "object" && Array.isArray((v as any).data)) {
    return Buffer.from((v as any).data);
  }
  return undefined;
}

/** Receipt logos arrive as base64 over the wire; convert to Buffer in place. */
function reviveReceiptLogo(input: ReceiptInput): ReceiptInput {
  const logo: any = input.header?.rasterLogo;
  if (logo && !Buffer.isBuffer(logo.bytes)) {
    const bytes = reviveBuffer(logo.bytes ?? logo.bytesBase64);
    if (bytes) {
      return { ...input, header: { ...input.header, rasterLogo: { ...logo, bytes } } };
    }
    const { rasterLogo, ...header } = input.header as any;
    return { ...input, header };
  }
  return input;
}

export interface RenderContext {
  paperWidth?: 80 | 58;
  /** Only used when a label job dispatches to TSPL/ZPL/EPL. */
  labelLanguage?: "tspl" | "zpl" | "epl";
  labelWidthMm?: number;
  labelHeightMm?: number;
  gapType?: "die_cut" | "black_mark" | "continuous";
}

/** Build a RenderContext from a PrinterEntry — the common case at bridge level. */
export function renderContextFromPrinter(pc: PrinterEntry): RenderContext {
  return {
    paperWidth:    pc.paperWidth,
    labelLanguage: pc.labelLanguage,
    labelWidthMm:  pc.labelWidthMm,
    labelHeightMm: pc.labelHeightMm,
    gapType:       pc.gapType,
  };
}

function labelSize(ctx: RenderContext): LabelSize {
  return {
    widthMm:  ctx.labelWidthMm  ?? 60,
    heightMm: ctx.labelHeightMm ?? 40,
    gapMm:    ctx.gapType === "continuous" ? 0 : 2,
    gapType:  ctx.gapType,
  };
}

/** Render a structured job to raw printer bytes. Pure — no I/O. */
export function renderJob(job: PrintJobData, ctx: RenderContext | (80 | 58) = {}): Buffer {
  // Back-compat: earlier callers passed a plain paperWidth number.
  const c: RenderContext = typeof ctx === "number" ? { paperWidth: ctx } : ctx;
  const paperWidth = c.paperWidth;

  switch (job.kind) {
    case "receipt": {
      const input = reviveReceiptLogo(job.input);
      return renderReceipt(paperWidth ? { ...input, paperWidth } : input);
    }
    case "kot":
      return renderKot(paperWidth ? { ...job.input, paperWidth } : job.input);
    case "master_kot":
      return renderMasterKot(paperWidth ? { ...job.input, paperWidth } : job.input);
    case "void_kot":
      return renderVoidKot(paperWidth ? { ...job.input, paperWidth } : job.input);
    case "label": {
      const lang = c.labelLanguage;
      if (lang === "tspl") return renderLabelTSPL(job.input, labelSize(c));
      if (lang === "zpl")  return renderLabelZPL(job.input, labelSize(c));
      if (lang === "epl")  return renderLabelEPL(job.input, labelSize(c));
      // Undefined / unrecognised → ESC/POS (label-mode receipt printer).
      return renderLabel(paperWidth ? { ...job.input, paperWidth } : job.input);
    }
    default:
      throw new Error(`Unknown print job kind: ${(job as any)?.kind}`);
  }
}
