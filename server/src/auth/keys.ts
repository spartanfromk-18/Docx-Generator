import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { SignJWT, exportJWK, generateKeyPair, importJWK, jwtVerify } from "jose";
import type { KeyLike, JWK } from "jose";
import { env } from "../env.js";
import { ApiError, unauthorized } from "../errors.js";
import { randomToken } from "../util.js";

/**
 * RS256 JWT signing per TRD 2.6: 15-minute access tokens with claims
 * { sub, org, role, plan, scope, jti }, plus 30-day refresh tokens.
 * The keypair persists under .data/keys so restarts don't invalidate sessions.
 */

let privateKey: KeyLike | Uint8Array | null = null;
let publicKey: KeyLike | Uint8Array | null = null;
let kid = "";

interface AccessClaims {
  sub: string;
  org: string;
  role: string;
  plan: string;
  scope: string;
  jti: string;
  email?: string;
  typ: "access";
}
interface RefreshClaims {
  sub: string;
  org: string;
  jti: string;
  typ: "refresh";
}

async function ensureKeys(): Promise<void> {
  if (privateKey && publicKey) return;
  const dir = env.dataDir;
  const keyFile = `${dir}jwt-keys.json`;
  if (existsSync(keyFile)) {
    try {
      const stored = JSON.parse(readFileSync(keyFile, "utf8")) as { kid: string; priv: JWK; pub: JWK };
      kid = stored.kid;
      privateKey = (await importJWK(stored.priv, "RS256")) as KeyLike;
      publicKey = (await importJWK(stored.pub, "RS256")) as KeyLike;
      return;
    } catch {
      // fall through and regenerate
    }
  }
  mkdirSync(dir, { recursive: true });
  const { publicKey: pub, privateKey: priv } = await generateKeyPair("RS256", { modulusLength: 2048 });
  publicKey = pub as KeyLike;
  privateKey = priv as KeyLike;
  kid = randomToken(8);
  writeFileSync(
    keyFile,
    JSON.stringify({ kid, priv: await exportJWK(priv), pub: await exportJWK(pub) }),
    { mode: 0o600 },
  );
}

export async function getJwks(): Promise<{ keys: JWK[] }> {
  await ensureKeys();
  const jwk = (await exportJWK(publicKey as KeyLike)) as JWK;
  return { keys: [{ ...jwk, kid, alg: "RS256", use: "sig" }] };
}

export async function signAccessToken(claims: Omit<AccessClaims, "typ" | "jti">): Promise<{ token: string; jti: string }> {
  await ensureKeys();
  const jti = randomToken(12);
  const token = await new SignJWT({ ...claims, typ: "access", jti })
    .setProtectedHeader({ alg: "RS256", kid })
    .setIssuedAt()
    .setIssuer("specforge")
    .setAudience("specforge-api")
    .setExpirationTime(`${env.accessTokenTtlSec}s`)
    .sign(privateKey as KeyLike);
  return { token, jti };
}

export async function signRefreshToken(userId: string, orgId: string): Promise<string> {
  await ensureKeys();
  return new SignJWT({ sub: userId, org: orgId, jti: randomToken(12), typ: "refresh" })
    .setProtectedHeader({ alg: "RS256", kid })
    .setIssuedAt()
    .setIssuer("specforge")
    .setAudience("specforge-api")
    .setExpirationTime(`${env.refreshTokenTtlSec}s`)
    .sign(privateKey as KeyLike);
}

export async function verifyAccessToken(token: string): Promise<AccessClaims> {
  await ensureKeys();
  try {
    const { payload } = await jwtVerify(token, publicKey as KeyLike, {
      issuer: "specforge",
      audience: "specforge-api",
    });
    if (payload.typ !== "access") throw new Error("wrong token type");
    return payload as unknown as AccessClaims;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("exp") || msg.includes("timestamp check")) {
      throw new ApiError(401, "TOKEN_EXPIRED", "Access token expired.", null, true);
    }
    throw unauthorized("UNAUTHENTICATED", "Invalid access token.");
  }
}

export async function verifyRefreshToken(token: string): Promise<RefreshClaims> {
  await ensureKeys();
  try {
    const { payload } = await jwtVerify(token, publicKey as KeyLike, {
      issuer: "specforge",
      audience: "specforge-api",
    });
    if (payload.typ !== "refresh") throw new Error("wrong token type");
    return payload as unknown as RefreshClaims;
  } catch {
    throw unauthorized("UNAUTHENTICATED", "Invalid refresh token.");
  }
}

export function decodeJwtExp(token: string): number | null {
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8")) as { exp?: number };
    return typeof payload.exp === "number" ? payload.exp : null;
  } catch {
    return null;
  }
}
