/** Typed environment configuration with working dev defaults (zero-config boot). */

function str(name: string, fallback: string): string {
  const v = process.env[name];
  return v === undefined || v === "" ? fallback : v;
}
function int(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) ? v : fallback;
}
function bool(name: string, fallback: boolean): boolean {
  const v = process.env[name];
  if (v === undefined || v === "") return fallback;
  return ["1", "true", "yes", "on"].includes(v.toLowerCase());
}

export const env = {
  nodeEnv: str("NODE_ENV", "development"),
  port: int("PORT", 8787),
  host: str("HOST", "0.0.0.0"),
  corsOrigin: str("CORS_ORIGIN", "http://localhost:5173")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),

  // --- database ---
  useMemoryDb: bool("USE_MEMORY_DB", true),
  databaseUrl: str(
    "DATABASE_URL",
    "postgresql://specforge:specforge_pwd@localhost:5432/specforge",
  ),
  dbRolePasswordApi: str("DB_ROLE_PASSWORD_API", "app_api_dev"),
  dbRolePasswordSystem: str("DB_ROLE_PASSWORD_SYSTEM", "app_system_dev"),

  // --- auth ---
  jwtSecret: str("JWT_SECRET", "dev-only-change-me"),
  accessTokenTtlSec: int("ACCESS_TOKEN_TTL_SEC", 15 * 60),
  refreshTokenTtlSec: int("REFRESH_TOKEN_TTL_SEC", 30 * 24 * 60 * 60),

  // --- LLM ---
  llmProviderOrder: str("LLM_PROVIDER_ORDER", "mock,anthropic,openai")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),
  anthropicApiKey: str("ANTHROPIC_API_KEY", ""),
  anthropicModel: str("ANTHROPIC_MODEL", "claude-sonnet-4-20250514"),
  openaiApiKey: str("OPENAI_API_KEY", ""),
  openaiModel: str("OPENAI_MODEL", "gpt-4o"),

  // --- pipeline demo controls ---
  mockSpeed: int("SPECFORGE_MOCK_SPEED", 1),
  faults: str("SPECFORGE_FAULTS", ""), // e.g. "provider_outage"

  // --- billing ---
  stripeWebhookSecret: str("STRIPE_WEBHOOK_SECRET", ""),

  // --- exports ---
  dataDir: str("SPECFORGE_DATA_DIR", new URL("../.data/", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")),
} as const;

export type Env = typeof env;
