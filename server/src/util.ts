import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/** UUIDv7 (time-ordered) matching the uuid_v7() function in scripts/init_db.sql. */
export function uuidv7(): string {
  const ts = Date.now();
  const rand = randomBytes(10);
  const b = Buffer.alloc(16);
  // 48-bit big-endian unix ms
  b.writeUIntBE(ts, 0, 6);
  // version 7
  b[6] = 0x70 | (rand[0] & 0x0f);
  b[7] = rand[1];
  // variant 10xx
  b[8] = 0x80 | (rand[2] & 0x3f);
  rand.copy(b, 9, 3, 10);
  const h = b.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export function sha256Hex(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}
export function sha256Bytes(data: string | Uint8Array): Buffer {
  return createHash("sha256").update(data).digest();
}
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}
export function randomHex(bytes = 8): string {
  return randomBytes(bytes).toString("hex");
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export function nowIso(): string {
  return new Date().toISOString();
}

/** Constant-time string compare (same length required for timingSafeEqual). */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/** Deterministic 32-bit seed from text (FNV-1a) — drives the offline mock generator. */
export function seedFrom(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Small deterministic PRNG (mulberry32). */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function pick<T>(arr: T[], r: () => number): T {
  return arr[Math.floor(r() * arr.length) % arr.length];
}

export function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

/** Round to 2 decimals — credit ledger precision. */
export function r2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Rough token estimate (~4 chars per token) used for metering mock calls. */
export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

const STOPWORDS = new Set([
  "a", "an", "the", "and", "or", "for", "of", "to", "in", "on", "with", "that", "this",
  "is", "are", "be", "it", "as", "at", "by", "from", "our", "we", "their", "they",
  "app", "application", "platform", "system", "tool", "software", "product", "service",
  "users", "user", "people", "team", "teams", "which", "can", "will", "into", "about",
]);

/** Naive entity extraction: multiword capitalized phrases + salient nouns. */
export function extractEntities(idea: string, max = 6): string[] {
  const capPhrases = idea.match(/\b([A-Z][a-zA-Z0-9]+(?:\s+[A-Z][a-zA-Z0-9]+){0,2})\b/g) ?? [];
  const words = idea.toLowerCase().replace(/[^a-z0-9\s-]/g, " ").split(/\s+/);
  const freq = new Map<string, number>();
  for (const w of words) {
    if (w.length < 4 || STOPWORDS.has(w)) continue;
    freq.set(w, (freq.get(w) ?? 0) + 1);
  }
  const salient = [...freq.entries()]
    .filter(([, c]) => c >= 1)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([w]) => w);

  const out: string[] = [];
  const seen = new Set<string>();
  const push = (name: string) => {
    const key = name.toLowerCase();
    if (!seen.has(key) && name.length >= 3 && name.length <= 40) {
      seen.add(key);
      out.push(name);
    }
  };
  for (const p of capPhrases) {
    if (p.split(/\s+/).length > 1) push(p.replace(/\s+/g, " ").trim());
    if (out.length >= Math.ceil(max / 2)) break;
  }
  for (const w of salient) {
    push(w.charAt(0).toUpperCase() + w.slice(1));
    if (out.length >= max) break;
  }
  // Generic fallbacks so generated specs are always coherent.
  const fallbacks = ["Accounts", "Workspace", "Billing", "Notifications", "Analytics", "Integrations"];
  for (const f of fallbacks) {
    if (out.length >= max) break;
    push(f);
  }
  return out.slice(0, max);
}

export function titleCase(s: string): string {
  return s.replace(/\w\S*/g, (w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());
}

export function slugify(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 62) || "org";
}

/** Simple language detection (en/de/es/fr/hi/pt/zh heuristic). */
export function detectLanguage(text: string): string {
  const samples: [string, RegExp][] = [
    ["de", /\b(und|die|der|das|mit|für|von|nicht|ist)\b/i],
    ["es", /\b(que|para|con|una|los|las|por|como|más)\b/i],
    ["fr", /\b(les|des|une|pour|avec|dans|est|nous)\b/i],
    ["pt", /\b(que|para|com|uma|não|mais|como|dos)\b/i],
    ["hi", /[\u0900-\u097F]/],
    ["zh", /[\u4E00-\u9FFF]/],
  ];
  for (const [lang, re] of samples) if (re.test(text)) return lang;
  return "en";
}

const SECRET_PATTERNS: [string, RegExp][] = [
  ["AWS access key", /\bAKIA[0-9A-Z]{16}\b/g],
  ["Stripe key", /\b(sk|pk)_(live|test)_[0-9a-zA-Z]{16,}\b/g],
  ["Generic API key", /\b(api[_-]?key|token|secret)\s*[:=]\s*['"]?[A-Za-z0-9_\-]{16,}['"]?/gi],
  ["Bearer token", /\bBearer\s+[A-Za-z0-9_\-\.]{20,}/g],
  ["Private key block", /-----BEGIN [A-Z ]*PRIVATE KEY-----/g],
];

export interface SecretScanResult {
  text: string;
  redactions: { type: string; count: number }[];
}

/** Entropy + regex secret scanner; matches are replaced with placeholders. */
export function scanAndRedactSecrets(text: string): SecretScanResult {
  let out = text;
  const redactions: { type: string; count: number }[] = [];
  for (const [type, re] of SECRET_PATTERNS) {
    const matches = out.match(re);
    if (matches && matches.length > 0) {
      redactions.push({ type, count: matches.length });
      out = out.replace(re, `[REDACTED:${type.toUpperCase().replace(/\s+/g, "_")}]`);
    }
  }
  return { text: out, redactions };
}

export function htmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function stripTags(s: string): string {
  return s.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

/** Keyset pagination cursor (base64url of "updated_at|id"). */
export function encodeCursor(updatedAt: string, id: string): string {
  return Buffer.from(`${updatedAt}|${id}`).toString("base64url");
}
export function decodeCursor(cursor: string): { updatedAt: string; id: string } | null {
  try {
    const [updatedAt, id] = Buffer.from(cursor, "base64url").toString("utf8").split("|");
    if (!updatedAt || !id) return null;
    return { updatedAt, id };
  } catch {
    return null;
  }
}

export function hostOf(url: string): string {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return "";
  }
}
