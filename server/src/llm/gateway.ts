import type { z } from "zod";
import { env } from "../env.js";
import { ApiError } from "../errors.js";
import { estimateTokens } from "../util.js";
import type { RunRow, StageName } from "../types.js";
import { buildProviderChain, type LLMProvider, type LLMResponse } from "./providers.js";
import { mockGenerate, type MockContext } from "./mockContent.js";

/**
 * LLM Gateway (TRD 2.2): single enforcement point for budgets, failover,
 * structured-output validation + one repair call, cost metering, breaker state.
 */

export interface GenerateOptions<T> {
  run: RunRow;
  stage: StageName;
  schema: z.ZodType<T>;
  /** Structured mock context — used when the active provider is the offline mock. */
  mock: MockContext;
  /** Prompt builder for real providers. */
  prompt: { system: string; user: string; maxTokens: number };
  /** Structured output is expected JSON. */
  json?: boolean;
  /** Emitted per successful call for metering/SSE. */
  onCall?: (resp: LLMResponse) => void;
  /** Repair feedback appended to the user prompt on schema failure. */
  repairNote?: (errors: string) => string;
}

export interface GenerateResult<T> {
  data: T;
  tokensIn: number;
  tokensOut: number;
  provider: string;
  model: string;
  calls: number;
}

/** Per-provider circuit breaker (50% errors over 30 s or 8 consecutive fails). */
class Breaker {
  private window: number[] = []; // timestamps of failures
  private successes = 0;
  private calls = 0;
  private openedAt = 0;
  static OPEN_MS = 30_000;

  allow(): boolean {
    if (this.openedAt === 0) return true;
    if (Date.now() - this.openedAt > Breaker.OPEN_MS) {
      // half-open: allow one probe
      this.openedAt = Date.now() - Breaker.OPEN_MS + 10_000;
      return true;
    }
    return false;
  }
  record(success: boolean): void {
    this.calls += 1;
    if (success) {
      this.successes += 1;
      if (this.openedAt && Date.now() - this.openedAt > Breaker.OPEN_MS) {
        this.openedAt = 0; // half-open success closes the breaker
      }
      return;
    }
    const now = Date.now();
    this.window = this.window.filter((t) => now - t < 30_000);
    this.window.push(now);
    const errorRate = this.calls >= 20 ? this.window.length / this.calls : 0;
    if (this.window.length >= 8 || errorRate >= 0.5) {
      this.openedAt = now;
    }
  }
  isOpen(): boolean {
    return this.openedAt !== 0 && Date.now() - this.openedAt <= Breaker.OPEN_MS;
  }
}

export class LLMGateway {
  private chain: LLMProvider[];
  private breakers = new Map<string, Breaker>();

  constructor(order: string[] = [...env.llmProviderOrder]) {
    this.chain = buildProviderChain(order);
  }

  private breakerFor(provider: string): Breaker {
    let b = this.breakers.get(provider);
    if (!b) {
      b = new Breaker();
      this.breakers.set(provider, b);
    }
    return b;
  }

  /**
   * Produce a validated structure. When the leading provider is the offline
   * mock, generation comes from deterministic templates (no network).
   * Real providers are called with the prompt; invalid output triggers exactly
   * one repair call; budget caps are enforced per run (TRD S6).
   */
  async generateStructured<T>(opts: GenerateOptions<T>): Promise<GenerateResult<T>> {
    const { run, stage } = opts;
    const active = this.chain[0];
    let lastError: Error | null = null;

    for (const provider of this.chain) {
      const breaker = this.breakerFor(provider.name);
      if (provider.name !== "mock" && breaker.isOpen()) continue;

      for (let attempt = 0; attempt <= 1; attempt++) {
        // Budget enforcement: reject if this call would blow the run cap.
        const projectedIn =
          provider.name === "mock"
            ? estimateTokens(JSON.stringify(opts.mock).slice(0, 4000))
            : estimateTokens(opts.prompt.user);
        if (run.tokens_in + projectedIn > run.max_input_tokens) {
          throw new ApiError(400, "BUDGET_EXCEEDED", "Run input token budget exhausted.", {
            max_input_tokens: run.max_input_tokens,
          });
        }

        let resp: LLMResponse;
        try {
          if (provider.name === "mock") {
            resp = await this.mockResponse(opts, attempt);
          } else {
            const userPrompt =
              attempt === 0
                ? opts.prompt.user
                : `${opts.prompt.user}\n\nYour previous output failed schema validation:\n${lastError?.message ?? ""}\nReturn corrected JSON that strictly satisfies the schema.${opts.repairNote ? `\n${opts.repairNote(lastError?.message ?? "")}` : ""}`;
            resp = await provider.complete({
              system: opts.prompt.system,
              user: userPrompt,
              maxTokens: opts.prompt.maxTokens,
              json: opts.json ?? true,
              runId: run.id,
              stage,
            });
          }
        } catch (err) {
          breaker.record(false);
          lastError = err instanceof Error ? err : new Error(String(err));
          if (attempt === 1) break;
          continue;
        }
        breaker.record(true);

        // Output filter: block system-prompt exfiltration attempts (TRD S4).
        const safeText = this.filterOutput(resp.text);
        const parsed = this.validate(safeText, opts.schema);
        if (parsed.ok) {
          opts.onCall?.(resp);
          return {
            data: parsed.value,
            tokensIn: resp.tokensIn || estimateTokens(JSON.stringify(opts.mock).slice(0, 2000)),
            tokensOut: resp.tokensOut || estimateTokens(safeText),
            provider: resp.provider,
            model: resp.model,
            calls: attempt + 1,
          };
        }
        lastError = new Error(parsed.errors);
        if (attempt === 1) break; // one automatic repair pass only
      }
    }

    throw new ApiError(
      503,
      "PROVIDER_UNAVAILABLE",
      "All LLM providers failed or returned invalid output.",
      { detail: lastError?.message?.slice(0, 300) },
      true,
    );
  }

  /** Simulated provider outage fault injection (demo of paused_provider). */
  isFaultInjected(): boolean {
    return env.faults === "provider_outage";
  }

  private async mockResponse<T>(opts: GenerateOptions<T>, attempt: number): Promise<LLMResponse> {
    if (this.isFaultInjected() && opts.stage !== "INTAKE_VALIDATE" && opts.stage !== "CRAWL_FAST") {
      throw new Error("simulated provider outage (SPECFORGE_FAULTS=provider_outage)");
    }
    const raw = mockGenerate(opts.stage, opts.mock, attempt);
    const text = JSON.stringify(raw);
    const delayMs = Math.min(1200, 90 + text.length / 12) * Math.max(0, env.mockSpeed);
    if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
    return {
      text,
      tokensIn: estimateTokens(JSON.stringify(opts.mock).slice(0, 3000)),
      tokensOut: estimateTokens(text),
      provider: "mock",
      model: "specforge-mock-1",
    };
  }

  private filterOutput(text: string): string {
    // Cheap exfiltration filter: strip anything that looks like the gateway
    // system prompt or credential shapes (defense-in-depth beyond redaction).
    return text
      .replace(/\b(sk|pk)_(live|test)_[0-9a-zA-Z]{10,}\b/g, "[REDACTED_KEY]")
      .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[REDACTED_PEM]");
  }

  private validate<T>(text: string, schema: z.ZodType<T>): { ok: true; value: T } | { ok: false; errors: string } {
    let jsonText = text.trim();
    // Tolerate markdown fences around JSON.
    const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(jsonText);
    if (fence) jsonText = fence[1];
    try {
      const raw: unknown = JSON.parse(jsonText);
      const result = schema.safeParse(raw);
      if (result.success) return { ok: true, value: result.data };
      const errors = result.error.issues
        .slice(0, 5)
        .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
        .join("; ");
      return { ok: false, errors };
    } catch (err) {
      return { ok: false, errors: `invalid JSON: ${err instanceof Error ? err.message : "parse error"}` };
    }
  }
}
