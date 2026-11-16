import { estimateTokens, uuidv7 } from "../util.js";
import { nowIso } from "../util.js";
import type { DesignExtractionRow } from "../types.js";
import type { CrawlResult } from "./crawler.js";

/**
 * EXTRACT stage: turns the fast crawl into the strict design-extraction JSON
 * (TRD 2.2). Untrusted page text is never concatenated into instruction
 * channels — extraction is heuristic here, and flagged when the pages contain
 * prompt-injection patterns (TRD S4).
 */

const INJECTION_PATTERNS = [
  /ignore\s+(all\s+)?previous\s+instructions/i,
  /disregard\s+(your|all)\s+(rules|instructions)/i,
  /you\s+are\s+now\s+(a|an)\s+/i,
  /reveal\s+your\s+(system\s+)?prompt/i,
  /<\|im_start\|>|<\|im_end\|>|\[INST\]|<<SYS>>/i,
];

export function scanInjection(text: string): boolean {
  return INJECTION_PATTERNS.some((re) => re.test(text));
}

export function buildExtraction(
  orgId: string,
  sourceId: string,
  crawl: CrawlResult,
  pageTextSample: string,
): { row: DesignExtractionRow; injectionSuspected: boolean; tokensIn: number } {
  const injectionSuspected = scanInjection(pageTextSample);
  const components: DesignExtractionRow["components"] = crawl.navigation.slice(0, 6).map((n) => ({
    name: n.label,
    observed_from: n.href,
    confidence: "observed" as const,
  }));
  if (crawl.palette.length > 0) {
    components.push({ name: "Color system", observed_from: crawl.palette[0].hex, confidence: "observed" });
  }
  if (crawl.fonts.length > 0) {
    components.push({ name: `Typography (${crawl.fonts[0].family})`, observed_from: crawl.fonts[0].family, confidence: "observed" });
  }
  components.push({ name: "Responsive layout", observed_from: "inferred from markup patterns", confidence: "inferred" });

  const row: DesignExtractionRow = {
    id: uuidv7(),
    org_id: orgId,
    source_id: sourceId,
    tokens: { palette: crawl.palette, fonts: crawl.fonts },
    components,
    information_arch: { navigation: crawl.navigation },
    flows: crawl.flows,
    tech_hints: {
      crawler: "lightweight-fetch",
      pages_captured: crawl.stats.captured,
      robots_respected: true,
      notes: "Production path uses Playwright in gVisor via the egress proxy.",
    },
    injection_suspected: injectionSuspected,
    schema_version: 1,
    model: "heuristic-v1",
    created_at: nowIso(),
    updated_at: nowIso(),
  };
  return { row, injectionSuspected, tokensIn: estimateTokens(pageTextSample.slice(0, 4000)) };
}
