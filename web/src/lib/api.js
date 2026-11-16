/**
 * Fetch wrapper — Bearer injection, automatic Idempotency-Key on mutations,
 * ETag caching with 304 revalidation, one silent refresh on 401, and
 * structured error parsing into ApiClientError.
 */

const SESSION_KEY = "specforge.session";
const etagCache = new Map(); // path → { etag, payload }

export class ApiClientError extends Error {
  constructor(status, code, message, details, requestId) {
    super(message);
    this.name = "ApiClientError";
    this.status = status;
    this.code = code || "ERROR";
    this.details = details || null;
    this.requestId = requestId || null;
  }
  get retryable() {
    return this.status === 429 || this.status >= 500;
  }
}

export function getSession() {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function setSession(session) {
  if (session) localStorage.setItem(SESSION_KEY, JSON.stringify(session));
  else localStorage.removeItem(SESSION_KEY);
}

export function newIdempotencyKey() {
  return (crypto.randomUUID ? crypto.randomUUID() : `k-${Date.now()}-${Math.random().toString(36).slice(2)}`);
}

let refreshing = null;

async function refreshSession() {
  const session = getSession();
  if (!session?.refresh_token) return null;
  if (!refreshing) {
    refreshing = (async () => {
      try {
        const res = await fetch("/v1/auth/refresh", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ refresh_token: session.refresh_token }),
        });
        if (!res.ok) return null;
        const data = await res.json();
        setSession({ ...session, ...data });
        return data;
      } catch {
        return null;
      } finally {
        refreshing = null;
      }
    })();
  }
  return refreshing;
}

async function rawRequest(path, { method = "GET", body, headers = {}, auth = true, signal, etag = false } = {}) {
  const session = getSession();
  const finalHeaders = { ...headers };
  if (body !== undefined && !(body instanceof FormData) && !(body instanceof ArrayBuffer)) {
    finalHeaders["content-type"] = "application/json";
  }
  if (auth && session?.access_token) finalHeaders["authorization"] = `Bearer ${session.access_token}`;
  if (method !== "GET" && method !== "HEAD") finalHeaders["idempotency-key"] = newIdempotencyKey();
  if (etag && etagCache.has(path)) finalHeaders["if-none-match"] = etagCache.get(path).etag;

  const res = await fetch(path, {
    method,
    headers: finalHeaders,
    body: body !== undefined ? (typeof body === "string" || body instanceof FormData || body instanceof ArrayBuffer || body instanceof Blob ? body : JSON.stringify(body)) : undefined,
    signal,
  });
  return res;
}

export async function request(path, opts = {}) {
  let res = await rawRequest(path, opts);

  // One silent refresh + retry on 401.
  if (res.status === 401 && opts.auth !== false && getSession()?.refresh_token) {
    const refreshed = await refreshSession();
    if (refreshed) res = await rawRequest(path, opts);
  }

  // 304 Not Modified → serve from cache.
  if (res.status === 304 && etagCache.has(path)) {
    return etagCache.get(path).payload;
  }

  if (res.status === 204) return null;

  const etagHeader = res.headers.get("etag");
  const contentType = res.headers.get("content-type") ?? "";

  if (!res.ok) {
    let payload = null;
    try {
      payload = await res.json();
    } catch {
      /* non-JSON error */
    }
    const err = payload?.error ?? {};
    throw new ApiClientError(res.status, err.code, err.message || res.statusText, err.details, err.request_id);
  }

  let data;
  if (contentType.includes("application/json")) data = await res.json();
  else data = await res.blob();

  if (etag && etagHeader && (opts.method ?? "GET") === "GET" && (contentType.includes("application/json"))) {
    etagCache.set(path, { etag: etagHeader, payload: data });
  }
  return data;
}

export const api = {
  get: (path, opts = {}) => request(path, { ...opts, method: "GET", etag: opts.etag ?? true }),
  post: (path, body, opts = {}) => request(path, { ...opts, method: "POST", body }),
  patch: (path, body, opts = {}) => request(path, { ...opts, method: "PATCH", body }),
  put: (path, body, opts = {}) => request(path, { ...opts, method: "PUT", body }),
  del: (path, opts = {}) => request(path, { ...opts, method: "DELETE" }),
  /** Raw blob download (export files). */
  download: async (path) => {
    const res = await rawRequest(path, { method: "GET" });
    if (!res.ok) {
      let payload = null;
      try {
        payload = await res.json();
      } catch {
        /* ignore */
      }
      const err = payload?.error ?? {};
      throw new ApiClientError(res.status, err.code, err.message || res.statusText, err.details, err.request_id);
    }
    const disposition = res.headers.get("content-disposition") ?? "";
    const match = /filename="?([^";]+)"?/.exec(disposition);
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = match?.[1] ?? "specforge-export";
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  },
};

/** Public SSE URL with the access token (EventSource cannot send headers). */
export function sseUrl(path) {
  const session = getSession();
  const sep = path.includes("?") ? "&" : "?";
  return session?.access_token ? `${path}${sep}access_token=${encodeURIComponent(session.access_token)}` : path;
}
