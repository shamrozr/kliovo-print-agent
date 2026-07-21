// Offline order-number formatting — the offline-side port of the web's
// canonical order-numbering.
//
// KEEP IN SYNC: the web owns the source of truth in
//   Kliovo-Dine/src/services/order-number.service.ts
//   (OrderNumberingConfig / generateOrderNumber / previewOrderNumber).
// Only the PURE formatting logic (config + terminal code + seq -> string) is
// duplicated here. The atomic counter differs on purpose: online numbers use a
// per-tenant/branch/dateKey row (orderSequence) that CANNOT be reached while
// offline, so offline numbers use a per-terminal counter (terminals.offline_seq)
// namespaced with a marker + the web-assigned terminal code — guaranteeing they
// never collide with online numbers or with another terminal's offline numbers.

export interface OfflineNumberingConfig {
  marker: string; // series marker, e.g. "OFF"
  includeTerminal: boolean; // include the per-terminal code segment
}

export interface OrderNumberingConfig {
  prefix: string;
  suffix: string;
  separator: string;
  padLength: number;
  startFrom: number;
  mode: "sequential" | "daily_reset" | "random";
  includeDate: boolean;
  dateFormat: "YYMMDD" | "MMDD" | "DDMM";
  includeChannel: boolean;
  channelCodes: Record<string, string>;
  offline: OfflineNumberingConfig;
}

export const DEFAULT_OFFLINE_NUMBERING: OfflineNumberingConfig = {
  marker: "OFF",
  includeTerminal: true,
};

export const DEFAULT_ORDER_NUMBERING: OrderNumberingConfig = {
  prefix: "ORD",
  suffix: "",
  separator: "-",
  padLength: 5,
  startFrom: 1,
  mode: "sequential",
  includeDate: false,
  dateFormat: "YYMMDD",
  includeChannel: false,
  channelCodes: {
    dine_in: "D",
    takeaway: "T",
    delivery: "DL",
    website: "W",
    whatsapp: "WA",
    phone: "PH",
    chatbot: "CB",
    qr_code: "QR",
    kiosk: "KI",
  },
  offline: DEFAULT_OFFLINE_NUMBERING,
};

function normalizeOffline(raw: unknown): OfflineNumberingConfig {
  const obj = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  return {
    marker:
      typeof obj.marker === "string" && obj.marker.trim()
        ? obj.marker.toUpperCase().slice(0, 10)
        : DEFAULT_OFFLINE_NUMBERING.marker,
    includeTerminal:
      typeof obj.includeTerminal === "boolean"
        ? obj.includeTerminal
        : DEFAULT_OFFLINE_NUMBERING.includeTerminal,
  };
}

// Ported from normalizeOrderNumbering in the web service (see file header).
export function normalizeOrderNumbering(raw: unknown): OrderNumberingConfig {
  const obj = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const d = DEFAULT_ORDER_NUMBERING;
  return {
    prefix: typeof obj.prefix === "string" ? obj.prefix.toUpperCase().slice(0, 10) : d.prefix,
    suffix: typeof obj.suffix === "string" ? obj.suffix.toUpperCase().slice(0, 10) : d.suffix,
    separator: typeof obj.separator === "string" ? obj.separator.slice(0, 3) : d.separator,
    padLength:
      typeof obj.padLength === "number" && obj.padLength >= 1 && obj.padLength <= 10
        ? obj.padLength
        : d.padLength,
    startFrom:
      typeof obj.startFrom === "number" && obj.startFrom >= 0 ? Math.floor(obj.startFrom) : d.startFrom,
    mode: (["sequential", "daily_reset", "random"] as const).includes(obj.mode as never)
      ? (obj.mode as OrderNumberingConfig["mode"])
      : d.mode,
    includeDate: typeof obj.includeDate === "boolean" ? obj.includeDate : d.includeDate,
    dateFormat: (["YYMMDD", "MMDD", "DDMM"] as const).includes(obj.dateFormat as never)
      ? (obj.dateFormat as OrderNumberingConfig["dateFormat"])
      : d.dateFormat,
    includeChannel: typeof obj.includeChannel === "boolean" ? obj.includeChannel : d.includeChannel,
    channelCodes:
      obj.channelCodes && typeof obj.channelCodes === "object"
        ? { ...d.channelCodes, ...(obj.channelCodes as Record<string, string>) }
        : d.channelCodes,
    offline: normalizeOffline(obj.offline),
  };
}

/**
 * Format an offline reference: `{marker}{sep}{code}{sep}{seq}`.
 *
 * Reuses the web config's `separator` + `padLength` so offline refs are
 * formatted the same way as online ones, and prefixes the `marker` + terminal
 * `code` so they can never collide across terminals (each terminal has a unique
 * web-assigned code and its own counter).
 */
export function formatOfflineRef(
  config: OrderNumberingConfig,
  terminalCode: string,
  seq: number
): string {
  const sep = config.separator || "-";
  const parts: string[] = [config.offline.marker || "OFF"];
  if (config.offline.includeTerminal && terminalCode) {
    parts.push(terminalCode.toUpperCase());
  }
  parts.push(String(seq).padStart(config.padLength, "0"));
  return parts.join(sep);
}
