/**
 * Local render dispatch for the print agent.
 *
 * The agent receives a serializable `PrintJobData` (NOT pre-rendered bytes),
 * renders it to ESC/POS locally, and streams it to the printer. This is what
 * lets printing keep working with zero cloud dependency: the POS builds the
 * job from its own cache and posts it straight to the agent on the LAN.
 *
 * The render functions are vendored from Kliovo-Dine (src/lib/print/escpos)
 * so the exact same bytes are produced online and offline.
 */
import { renderReceipt, type ReceiptInput } from "./templates/receipt";
import { renderKot, type KotInput } from "./templates/kot";
import { renderMasterKot, type MasterKotInput } from "./templates/master-kot";
import { renderVoidKot, type VoidKotInput } from "./templates/void-kot";
import { renderLabel, type LabelInput } from "./templates/label";

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
  // JSON.stringify(Buffer) → { type: "Buffer", data: number[] }
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
    // Couldn't revive — drop the logo rather than crash the whole ticket.
    const { rasterLogo, ...header } = input.header as any;
    return { ...input, header };
  }
  return input;
}

/** Render a structured job to raw ESC/POS bytes. Pure — no I/O. */
export function renderJob(job: PrintJobData, paperWidthOverride?: 80 | 58): Buffer {
  switch (job.kind) {
    case "receipt": {
      const input = reviveReceiptLogo(job.input);
      return renderReceipt(paperWidthOverride ? { ...input, paperWidth: paperWidthOverride } : input);
    }
    case "kot":
      return renderKot(paperWidthOverride ? { ...job.input, paperWidth: paperWidthOverride } : job.input);
    case "master_kot":
      return renderMasterKot(paperWidthOverride ? { ...job.input, paperWidth: paperWidthOverride } : job.input);
    case "void_kot":
      return renderVoidKot(paperWidthOverride ? { ...job.input, paperWidth: paperWidthOverride } : job.input);
    case "label":
      return renderLabel(paperWidthOverride ? { ...job.input, paperWidth: paperWidthOverride } : job.input);
    default:
      throw new Error(`Unknown print job kind: ${(job as any)?.kind}`);
  }
}
