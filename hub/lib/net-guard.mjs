// The hub answers only this house: loopback and the private ranges. Everything else gets 403 before any routing.
//   IPv4: 127/8, 10/8, 172.16/12, 192.168/16          IPv6: ::1, fe80::/10 (link-local), fc00::/7 (unique local)
//   and the IPv4-mapped forms (::ffff:192.168.1.10, ::ffff:c0a8:010a) that a dual-stack socket reports.
import net from "node:net";

/** An IPv6 address as its 8 16-bit groups, or null. Accepts "::", a trailing dotted quad and a %zone. */
export function expandV6(addr) {
  let a = String(addr || "").toLowerCase().replace(/%.*$/, "");
  if (!net.isIPv6(a)) return null;
  const tail = /(\d+\.\d+\.\d+\.\d+)$/.exec(a);
  if (tail) {
    const [p, q, r, s] = tail[1].split(".").map(Number);
    a = a.slice(0, -tail[1].length) + ((p << 8) | q).toString(16) + ":" + ((r << 8) | s).toString(16);
  }
  const [head, rest] = a.includes("::") ? a.split("::") : [a, null];
  const h = head ? head.split(":") : [], t = rest ? rest.split(":") : [];
  const fill = rest === null ? [] : Array(8 - h.length - t.length).fill("0");
  const g = [...h, ...fill, ...t].map(x => parseInt(x || "0", 16));
  return g.length === 8 && g.every(n => n >= 0 && n <= 0xffff) ? g : null;
}

function v4Private([a, b]) {
  return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

/** True for loopback and private addresses only. Unknown or malformed input is refused. */
export function isAllowedAddress(addr) {
  if (typeof addr !== "string" || !addr) return false;
  if (net.isIPv4(addr)) return v4Private(addr.split(".").map(Number));
  const g = expandV6(addr);
  if (!g) return false;
  if (g.slice(0, 5).every(n => n === 0) && g[5] === 0xffff)     // IPv4-mapped
    return v4Private([g[6] >> 8, g[6] & 255, g[7] >> 8, g[7] & 255]);
  if (g.slice(0, 7).every(n => n === 0) && g[7] === 1) return true; // ::1
  if ((g[0] & 0xffc0) === 0xfe80) return true;                    // fe80::/10
  if ((g[0] & 0xfe00) === 0xfc00) return true;                    // fc00::/7
  return false;
}

/** True when an Origin header names a host in the house (or there is none): the gate for cross-origin writes. */
/** True only for this machine: 127/8, ::1 and their IPv4-mapped form. For switches only this laptop may flip. */
export function isLoopback(addr) {
  if (typeof addr !== "string" || !addr) return false;
  if (net.isIPv4(addr)) return addr.startsWith("127.");
  const g = expandV6(addr);
  if (!g) return false;
  if (g.slice(0, 7).every(n => n === 0) && g[7] === 1) return true;
  return g.slice(0, 5).every(n => n === 0) && g[5] === 0xffff && g[6] >> 8 === 127;
}

export function isAllowedOrigin(origin) {
  if (!origin) return true;
  let host;
  try { host = new URL(origin).hostname.replace(/^\[|\]$/g, ""); } catch { return false; }
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  return isAllowedAddress(host);
}
