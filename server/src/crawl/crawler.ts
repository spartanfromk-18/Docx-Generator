import { createHash } from "node:crypto";
import { guardedFetch } from "./urlGuard.js";
import { nowIso, stripTags, uuidv7 } from "../util.js";
import type { CrawlPageRowLite } from "../db/repo.js";
import type { SkipReason } from "../types.js";

/**
 * Lightweight fast crawler for Reference Mode previews (PRD FR-6).
 * Same-origin BFS to depth 2 with per-page limits (20 s wall clock, 5 MB),
 * robots.txt respected, per-host rate 1 req/s. Screenshots are out of scope for
 * the lightweight crawler (Playwright fleet is the production path); everything
 * else needed by the preview — titles, palette, fonts, nav, a11y summary — is
 * extracted from HTML and its stylesheets.
 */

export interface CrawlResult {
  pages: CrawlPageRowLite[];
  palette: { hex: string; role: string; usage_share: number }[];
  fonts: { family: string; weights: number[]; usage_share: number }[];
  navigation: { label: string; href: string; depth: number }[];
  flows: { name: string; steps: string[] }[];
  a11y: { critical: number; serious: number; moderate: number };
  stats: { captured: number; skipped: number; duration_ms: number };
  authWall: boolean;
}

interface RawPage {
  url: string;
  depth: number;
  status: number | null;
  html: string | null;
  skipReason: SkipReason | null;
  title: string | null;
}

const MAX_HTML_BYTES = 5 * 1024 * 1024;
const UA_DISALLOW: [RegExp, string[]][] = [];

export async function fetchRobots(origin: string): Promise<string[]> {
  try {
    const res = await guardedFetch(`${origin}/robots.txt`, { timeoutMs: 5000 });
    if (!res.ok) return [];
    const text = await res.text();
    const disallow: string[] = [];
    let applies = false;
    for (const line of text.split(/\r?\n/)) {
      const clean = line.split("#")[0].trim();
      const [rawKey, ...rest] = clean.split(":");
      const key = rawKey.trim().toLowerCase();
      const value = rest.join(":").trim();
      if (key === "user-agent") {
        applies = value === "*" || value.toLowerCase().includes("specforgebot");
      } else if (applies && key === "disallow" && value) {
        disallow.push(value);
      }
    }
    return disallow;
  } catch {
    return []; // unreachable robots.txt ⇒ treat as allowed
  }
}

function robotsAllows(path: string, disallow: string[]): boolean {
  return !disallow.some((rule) => rule !== "" && path.startsWith(rule));
}

function extractTitle(html: string): string | null {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  return m ? stripTags(m[1]).slice(0, 200) : null;
}

function extractLinks(html: string, baseUrl: string): { href: string; label: string }[] {
  const out: { href: string; label: string }[] = [];
  const re = /<a\b[^>]*href\s*=\s*["']([^"'#\s]+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    try {
      const abs = new URL(m[1], baseUrl);
      if (abs.protocol !== "http:" && abs.protocol !== "https:") continue;
      out.push({ href: abs.toString(), label: stripTags(m[2]).slice(0, 80) });
    } catch {
      /* ignore malformed hrefs */
    }
  }
  return out;
}

const HEX_RE = /#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{3})\b/g;
const FONT_RE = /font-family\s*:\s*([^;}"']+)/gi;

function extractColors(html: string, css: string): { hex: string; role: string; usage_share: number }[] {
  const counts = new Map<string, number>();
  const count = (text: string) => {
    for (const m of text.match(HEX_RE) ?? []) {
      const hex = m.length === 4 ? `#${m[1]}${m[1]}${m[2]}${m[2]}${m[3]}${m[3]}`.toLowerCase() : m.toLowerCase();
      counts.set(hex, (counts.get(hex) ?? 0) + 1);
    }
  };
  count(html);
  count(css);
  const total = [...counts.values()].reduce((a, b) => a + b, 0) || 1;
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([hex, c], i) => ({
      hex,
      role: i === 0 ? "primary" : i === 1 ? "secondary" : i === 2 ? "accent" : `palette-${i - 2}`,
      usage_share: Math.round((c / total) * 100) / 100,
    }));
}

function extractFonts(css: string): { family: string; weights: number[]; usage_share: number }[] {
  const counts = new Map<string, number>();
  let m: RegExpExecArray | null;
  FONT_RE.lastIndex = 0;
  while ((m = FONT_RE.exec(css)) !== null) {
    const families = m[1].split(",").map((f) => f.replace(/["']/g, "").trim()).filter(Boolean);
    for (const fam of families.slice(0, 2)) {
      counts.set(fam, (counts.get(fam) ?? 0) + 1);
    }
  }
  const total = [...counts.values()].reduce((a, b) => a + b, 0) || 1;
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([family, c]) => ({
      family,
      weights: [400, 600],
      usage_share: Math.round((c / total) * 100) / 100,
    }));
}

function extractNav(html: string, baseUrl: string): { label: string; href: string; depth: number }[] {
  const navs: { label: string; href: string; depth: number }[] = [];
  const navRe = /<nav\b[^>]*>([\s\S]*?)<\/nav>/gi;
  let navMatch: RegExpExecArray | null;
  let navIndex = 0;
  while ((navMatch = navRe.exec(html)) !== null && navIndex < 2) {
    for (const link of extractLinks(navMatch[1], baseUrl).slice(0, 15)) {
      const label = link.label || new URL(link.href).pathname.split("/").filter(Boolean).pop() || link.href;
      const depth = new URL(link.href).pathname.split("/").filter(Boolean).length;
      if (label) navs.push({ label, href: link.href, depth });
    }
    navIndex += 1;
  }
  // dedupe by href
  const seen = new Set<string>();
  return navs.filter((n) => (seen.has(n.href) ? false : (seen.add(n.href), true))).slice(0, 20);
}

function a11ySummary(html: string): { critical: number; serious: number; moderate: number } {
  const imgs = (html.match(/<img\b/gi) ?? []).length;
  const imgsWithAlt = (html.match(/<img\b[^>]*\balt\s*=\s*["'][^"']+["']/gi) ?? []).length;
  const inputsNoLabel = (html.match(/<input\b(?![^>]*\b(aria-label|id)\b)[^>]*>/gi) ?? []).length;
  const critical = Math.min(20, Math.max(0, imgs - imgsWithAlt) > 2 ? 1 : 0);
  const serious = Math.min(50, Math.max(0, imgs - imgsWithAlt) + (inputsNoLabel > 0 ? 1 : 0));
  const moderate = Math.min(100, Math.floor((html.match(/<div\b/gi) ?? []).length / 50) + (/<html[^>]*\blang=/i.test(html) ? 0 : 1));
  return { critical, serious, moderate };
}

function templateClusterOf(url: string): string {
  const path = new URL(url).pathname.toLowerCase().replace(/\/$/, "");
  if (path === "" || path === "/") return "home";
  const seg = path.split("/")[1] ?? "page";
  return /^[a-z0-9-]{1,24}$/.test(seg) ? seg : "page";
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function crawlSource(
  startUrl: string,
  maxPages: number,
  opts: { perPageDelayMs?: number } = {},
): Promise<CrawlResult> {
  const started = Date.now();
  const delay = opts.perPageDelayMs ?? 1000; // 1 req/s per host (PRD compliance)
  const origin = new URL(startUrl).origin;
  const robots = await fetchRobots(origin);

  const pages: RawPage[] = [];
  const seen = new Set<string>([startUrl]);
  const queue: { url: string; depth: number }[] = [{ url: startUrl, depth: 0 }];
  let authWallHits = 0;

  while (queue.length > 0 && pages.length < Math.min(maxPages, 50)) {
    const { url, depth } = queue.shift() as { url: string; depth: number };
    const path = new URL(url).pathname;
    if (!robotsAllows(path, robots)) {
      pages.push({ url, depth, status: null, html: null, skipReason: "ROBOTS_DISALLOWED", title: null });
      continue;
    }
    try {
      const res = await guardedFetch(url, { timeoutMs: 20_000 });
      const lenHeader = Number(res.headers.get("content-length") ?? "0");
      if (lenHeader > MAX_HTML_BYTES) {
        pages.push({ url, depth, status: res.status, html: null, skipReason: "TIMEOUT", title: null });
        await sleep(delay);
        continue;
      }
      const html = await res.text();
      const title = extractTitle(html);
      const lower = html.toLowerCase();
      const looksAuthWall =
        /name=["']password["']/.test(lower) &&
        (title?.toLowerCase().includes("sign in") || title?.toLowerCase().includes("log in") || /action=["'][^"']*login/.test(lower));
      if (looksAuthWall && depth > 0) {
        authWallHits += 1;
        pages.push({ url, depth, status: res.status, html: null, skipReason: "AUTH_REQUIRED", title });
      } else {
        pages.push({ url, depth, status: res.status, html: html.slice(0, MAX_HTML_BYTES), skipReason: null, title });
        if (depth < 2) {
          for (const link of extractLinks(html, url)) {
            const u = new URL(link.href);
            if (u.origin !== origin) continue; // same-origin only (OFF_ORIGIN never followed)
            if (seen.has(link.href)) continue;
            if (/\.(pdf|zip|png|jpe?g|gif|svg|mp4|webm|ico|css|js|woff2?)$/i.test(u.pathname)) continue;
            seen.add(link.href);
            queue.push({ url: link.href, depth: depth + 1 });
          }
        }
      }
    } catch (err) {
      const code = err instanceof Error && err.message.includes("timeout") ? "TIMEOUT" : "BLOCKED_HOST";
      pages.push({ url, depth, status: null, html: null, skipReason: code as SkipReason, title: null });
    }
    await sleep(delay);
  }

  // CSS for palette/fonts: fetch up to 2 same-origin stylesheets from the homepage.
  let css = "";
  const homeRaw = pages.find((p) => p.depth === 0 && p.html);
  if (homeRaw?.html) {
    const hrefs = [...homeRaw.html.matchAll(/<link[^>]*rel=["']stylesheet["'][^>]*href=["']([^"']+)["']/gi)]
      .slice(0, 2)
      .map((m) => m[1]);
    for (const href of hrefs) {
      try {
        const cssUrl = new URL(href, homeRaw.url).toString();
        if (new URL(cssUrl).origin !== origin) continue;
        const res = await guardedFetch(cssUrl, { timeoutMs: 8000 });
        if (res.ok) css += (await res.text()).slice(0, 200_000);
      } catch {
        /* stylesheet optional */
      }
    }
  }

  const captured = pages.filter((p) => p.html !== null);
  const skipped = pages.filter((p) => p.html === null);
  const home = captured[0];
  const palette = home?.html ? extractColors(home.html, css) : [];
  const fonts = css ? extractFonts(css) : [];
  const navigation = home?.html ? extractNav(home.html, home.url) : [];
  const a11y = home?.html ? a11ySummary(home.html) : { critical: 0, serious: 0, moderate: 0 };

  const crawlPages: CrawlPageRowLite[] = pages.map((p) => ({
    id: uuidv7(),
    org_id: "", // filled by caller
    source_id: "", // filled by caller
    url: p.url,
    url_sha256: createHash("sha256").update(p.url).digest("hex"),
    depth: p.depth,
    state: p.html ? "captured" : "skipped",
    skip_reason: p.skipReason,
    http_status: p.status,
    title: p.title,
    template_cluster: p.html ? templateClusterOf(p.url) : null,
    thumbnail_s3_key: null,
    content_sha256: p.html ? createHash("sha256").update(p.html).digest("hex") : null,
    a11y_summary: {},
    created_at: nowIso(),
  }));

  // Heuristic flows from nav labels
  const flows = navigation.slice(0, 4).map((n) => ({
    name: n.label,
    steps: ["Land on " + (home?.title ?? "home"), `Navigate to ${n.label}`, "Complete primary action", "Return to start"],
  }));

  return {
    pages: crawlPages,
    palette,
    fonts,
    navigation,
    flows,
    a11y,
    stats: {
      captured: captured.length,
      skipped: skipped.length,
      duration_ms: Date.now() - started,
    },
    authWall: authWallHits > 0 && captured.length <= 1,
  };
}
