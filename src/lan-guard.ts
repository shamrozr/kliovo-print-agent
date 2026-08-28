// ── LAN access (call-centre desks / second tills) ────────────
// The branch's own network only. A call-centre desk sits on the same LAN as the
// till, talks to THIS agent, and its orders land in the same encrypted store and
// the same change_log — which is why bringing several desks back online needs no
// merge: there is one writer and one ordered outbox.
//
// Everything below is the price of opening the listener at all:
//  - private (RFC1918 / link-local / ULA) source addresses only;
//  - an allow-list of POS routes, so pairing, the mirror, mark-synced and the
//    unauthenticated biometric/ADMS routes stay loopback-only;
//  - a valid session token from /local/auth on every request that touches data.
// The DB key never leaves this machine; a desk only ever holds a 12h token.
const LAN_ALLOWED_EXACT = new Set(["/ping", "/local/auth"]);
const LAN_ALLOWED_PREFIXES = ["/local/pos/", "/local/print/reprint"];

function normalizeAddr(addr: string | undefined): string {
  if (!addr) return "";
  // Node reports IPv4 over a dual-stack socket as ::ffff:a.b.c.d
  return addr.startsWith("::ffff:") ? addr.slice(7) : addr;
}

export function isLoopbackAddr(addr: string | undefined): boolean {
  const a = normalizeAddr(addr);
  return a === "127.0.0.1" || a === "::1" || a.startsWith("127.");
}

/** RFC1918 / CGNAT-free private space, link-local, and IPv6 ULA. */
export function isPrivateLanAddr(addr: string | undefined): boolean {
  const a = normalizeAddr(addr);
  if (!a) return false;
  if (isLoopbackAddr(a)) return true;
  if (/^10\./.test(a)) return true;
  if (/^192\.168\./.test(a)) return true;
  if (/^172\.(1[6-9]|2[0-9]|3[01])\./.test(a)) return true;
  if (/^169\.254\./.test(a)) return true;         // link-local
  if (/^fe80:/i.test(a)) return true;              // IPv6 link-local
  if (/^f[cd][0-9a-f]{2}:/i.test(a)) return true;  // IPv6 ULA
  return false;
}

export function isLanRouteAllowed(url: string | undefined): boolean {
  if (!url) return false;
  const path = url.split("?")[0];
  return LAN_ALLOWED_EXACT.has(path) || LAN_ALLOWED_PREFIXES.some((p) => path.startsWith(p));
}
