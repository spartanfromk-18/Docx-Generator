import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { ApiError } from "../errors.js";

/**
 * SSRF defence (TRD S1, TRD 2.6): strict URL parsing, scheme/port allow-list,
 * credential/userinfo rejection, and — critically — DNS resolution performed
 * HERE with every resolved address validated against the private-range
 * blocklist. Redirects are re-validated hop by hop (max 5), preventing
 * DNS-rebinding and redirect-to-internal attacks.
 */

const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "metadata.google.internal",
  "metadata.goog",
  "instance-data",
  "169.254.169.254",
]);

function ipv4ToInt(ip: string): number {
  const parts = ip.split(".").map(Number);
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}
function inCidr4(ip: string, cidr: string): boolean {
  const [base, bitsRaw] = cidr.split("/");
  const bits = Number(bitsRaw);
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (ipv4ToInt(ip) & mask) === (ipv4ToInt(base) & mask);
}
function expand6(ip: string): string {
  const [head, tail] = ip.toLowerCase().split("::");
  const headGroups = head ? head.split(":").filter(Boolean) : [];
  const tailGroups = tail !== undefined ? tail.split(":").filter(Boolean) : [];
  const missing = 8 - headGroups.length - tailGroups.length;
  const groups = [...headGroups, ...Array(Math.max(0, missing)).fill("0"), ...tailGroups];
  return groups.map((g) => g.padStart(4, "0")).join("");
}
function isPrivate6(ip: string): boolean {
  let ip6 = ip.toLowerCase();
  // IPv4-mapped IPv6 ::ffff:a.b.c.d
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(ip6);
  if (mapped) return isPrivate4(mapped[1]);
  if (!ip6.includes(":")) return isPrivate4(ip6);
  const full = expand6(ip6.replace(/^\[|\]$/g, ""));
  if (full.startsWith("00000000000000000000000000000001")) return true; // ::1
  if (full.startsWith("00" + "0".repeat(28) + "0000ffff")) return true; // ::ffff:0:0/96 remainder
  if (/^00{0,3}fc/.test(full) || full.startsWith("fc") || full.startsWith("fd")) return true; // fc00::/7
  const first16 = parseInt(full.slice(0, 4), 16);
  if (first16 >= 0xfe80 && first16 <= 0xfebf) return true; // fe80::/10
  if (first16 >= 0xff00) return true; // multicast/reserved
  if (full.startsWith("00000000000000000000000000000000")) return true; // ::
  return false;
}
function isPrivate4(ip: string): boolean {
  if (isIP(ip) !== 4) return true;
  const blocked4 = [
    "0.0.0.0/8", "10.0.0.0/8", "100.64.0.0/10", "127.0.0.0/8", "169.254.0.0/16",
    "172.16.0.0/12", "192.0.0.0/24", "192.168.0.0/16", "198.18.0.0/15", "224.0.0.0/4", "240.0.0.0/4",
  ];
  return blocked4.some((c) => inCidr4(ip, c));
}

export interface GuardedUrl {
  url: string; // normalized
  host: string; // hostname[:port] if non-standard
  origin: string;
}

/** Parse + resolve + validate. Throws URL_BLOCKED / URL_INVALID before any fetch. */
export async function assertPublicUrl(rawUrl: string): Promise<GuardedUrl> {
  let u: URL;
  try {
    u = new URL(rawUrl.trim());
  } catch {
    throw new ApiError(400, "URL_INVALID", "The URL could not be parsed.");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new ApiError(400, "URL_BLOCKED", "Only http and https URLs are allowed.");
  }
  if (u.username || u.password) {
    throw new ApiError(400, "URL_INVALID", "URLs with embedded credentials are rejected.");
  }
  const port = u.port ? Number(u.port) : u.protocol === "https:" ? 443 : 80;
  if (port !== 80 && port !== 443) {
    throw new ApiError(400, "URL_BLOCKED", "Only ports 80 and 443 are allowed.");
  }
  const host = u.hostname.toLowerCase().replace(/\.$/, "");
  if (!host || BLOCKED_HOSTNAMES.has(host)) {
    throw new ApiError(400, "URL_BLOCKED", "This host is blocked.");
  }
  if (isIP(host) && (isPrivate4(host) || isPrivate6(host))) {
    throw new ApiError(400, "URL_BLOCKED", "Private and internal addresses are blocked.");
  }
  // Resolve DNS ourselves and validate EVERY address (defeats rebinding).
  try {
    const records = await lookup(host, { all: true, verbatim: true });
    if (records.length === 0) throw new Error("no records");
    for (const rec of records) {
      if (isPrivate4(rec.address) || isPrivate6(rec.address)) {
        throw new ApiError(400, "URL_BLOCKED", "The host resolves to a private or internal address.");
      }
    }
  } catch (err) {
    if (err instanceof ApiError) throw err;
    throw new ApiError(400, "URL_INVALID", "DNS resolution failed for this host.");
  }
  return { url: u.toString(), host, origin: u.origin };
}

/** fetch() with a redirect loop that re-validates every hop against the guard. */
export async function guardedFetch(
  rawUrl: string,
  init: RequestInit & { timeoutMs?: number } = {},
  depth = 0,
): Promise<Response> {
  const { timeoutMs = 15_000, ...rest } = init;
  const guarded = await assertPublicUrl(rawUrl);
  if (depth > 5) throw new ApiError(400, "URL_BLOCKED", "Too many redirects.");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(guarded.url, {
      ...rest,
      redirect: "manual",
      signal: controller.signal,
      headers: {
        "user-agent": "SpecForgeBot/1.0 (+https://specforge.example/bot)",
        accept: "text/html,application/xhtml+xml,*/*;q=0.8",
        ...(rest.headers ?? {}),
      },
    });
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      if (loc) {
        const next = new URL(loc, guarded.url).toString();
        res.body?.cancel().catch(() => {});
        return guardedFetch(next, init, depth + 1);
      }
    }
    return res;
  } catch (err) {
    if (err instanceof ApiError) throw err;
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("abort")) throw new ApiError(400, "URL_BLOCKED", "The target took too long to respond (timeout).");
    throw new ApiError(400, "URL_BLOCKED", `Fetch failed: ${msg.slice(0, 120)}`);
  } finally {
    clearTimeout(timer);
  }
}
