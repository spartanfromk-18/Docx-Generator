import { env } from "../env.js";

/** Provider-agnostic LLM interface (TRD 2.2 LLM Gateway). */

export interface LLMRequest {
  system: string;
  user: string;
  maxTokens: number;
  json: boolean;
  runId: string;
  stage: string;
}

export interface LLMResponse {
  text: string;
  tokensIn: number;
  tokensOut: number;
  provider: string;
  model: string;
}

export interface LLMProvider {
  readonly name: string;
  available(): boolean;
  complete(req: LLMRequest): Promise<LLMResponse>;
}

const TIMEOUT_MS = 120_000;

async function fetchJson(url: string, init: RequestInit): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`HTTP ${res.status}: ${body.slice(0, 300)}`);
    }
    return (await res.json()) as unknown;
  } finally {
    clearTimeout(timer);
  }
}

/** Anthropic Messages API adapter (zero-retention contract). */
export class AnthropicProvider implements LLMProvider {
  readonly name = "anthropic";
  available(): boolean {
    return env.anthropicApiKey.length > 0;
  }
  async complete(req: LLMRequest): Promise<LLMResponse> {
    const data = (await fetchJson("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": env.anthropicApiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: env.anthropicModel,
        max_tokens: req.maxTokens,
        system: req.system,
        messages: [{ role: "user", content: req.user }],
      }),
    })) as { content?: { type: string; text?: string }[]; usage?: { input_tokens?: number; output_tokens?: number } };
    const text = (data.content ?? []).filter((c) => c.type === "text").map((c) => c.text ?? "").join("");
    return {
      text,
      tokensIn: data.usage?.input_tokens ?? 0,
      tokensOut: data.usage?.output_tokens ?? 0,
      provider: this.name,
      model: env.anthropicModel,
    };
  }
}

/** OpenAI Chat Completions adapter. */
export class OpenAIProvider implements LLMProvider {
  readonly name = "openai";
  available(): boolean {
    return env.openaiApiKey.length > 0;
  }
  async complete(req: LLMRequest): Promise<LLMResponse> {
    const data = (await fetchJson("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${env.openaiApiKey}`,
      },
      body: JSON.stringify({
        model: env.openaiModel,
        max_tokens: req.maxTokens,
        messages: [
          { role: "system", content: req.system },
          { role: "user", content: req.user },
        ],
        ...(req.json ? { response_format: { type: "json_object" } } : {}),
      }),
    })) as { choices?: { message?: { content?: string } }[]; usage?: { prompt_tokens?: number; completion_tokens?: number } };
    return {
      text: data.choices?.[0]?.message?.content ?? "",
      tokensIn: data.usage?.prompt_tokens ?? 0,
      tokensOut: data.usage?.completion_tokens ?? 0,
      provider: this.name,
      model: env.openaiModel,
    };
  }
}

/**
 * Deterministic offline provider. It does not answer free-text prompts; the
 * pipeline detects it and uses the structured mock generators instead, which
 * produce the same JSON contract a real provider is asked for.
 */
export class MockProvider implements LLMProvider {
  readonly name = "mock";
  available(): boolean {
    return true;
  }
  async complete(_req: LLMRequest): Promise<LLMResponse> {
    throw new Error("mock provider requires structured generation (handled by the pipeline)");
  }
}

export function buildProviderChain(order: string[]): LLMProvider[] {
  const all: Record<string, LLMProvider> = {
    anthropic: new AnthropicProvider(),
    openai: new OpenAIProvider(),
    mock: new MockProvider(),
  };
  const chain: LLMProvider[] = [];
  for (const name of order) {
    const p = all[name];
    if (p && p.available() && !chain.includes(p)) chain.push(p);
  }
  if (chain.length === 0) chain.push(all.mock);
  return chain;
}
