// lib/guard.js
// Shared request guard for expensive endpoints (/api/plan calls OpenAI and
// fetches 5+ competitor pages on every request; /api/brief writes storage).
//
// Three layers, cheapest first:
//   1. Origin check  — browser requests from other websites are refused.
//      Same-origin (the tool's own pages) is always allowed; add extra
//      origins via ALLOWED_ORIGINS (comma-separated) if another internal
//      tool must call the API.
//   2. Team access key — header `x-brief-key` must match one of the
//      comma-separated keys in BRIEF_ACCESS_KEY. One key per teammate lets
//      you revoke a single person without rotating everyone.
//   3. Rate limit — per-IP sliding window (default 20 requests / 10 min,
//      override with BRIEF_RATE_LIMIT). In-memory, so it is per server
//      instance: best-effort burst protection. The access key is the real lock.
//
// If BRIEF_ACCESS_KEY is unset the endpoint stays OPEN (so a deploy can't lock
// the team out before env vars exist) and responses report security:"open…".

import { timingSafeEqual } from "node:crypto";

const WINDOW_MS = 10 * 60 * 1000;
const hits = new Map(); // `${bucket}:${ip}` -> number[] (timestamps)

function list(envVal) {
  return String(envVal || "").split(",").map((s) => s.trim()).filter(Boolean);
}

function safeEqual(a, b) {
  const A = Buffer.from(String(a));
  const B = Buffer.from(String(b));
  if (A.length !== B.length) return false;
  return timingSafeEqual(A, B);
}

function hostOf(u) {
  try { return new URL(u).host.toLowerCase(); } catch { return null; }
}

function originAllowed(request) {
  const origin = request.headers.get("origin");
  if (!origin) return true; // non-browser client (curl/server) — the key still applies
  const oHost = hostOf(origin);
  if (!oHost) return false;
  const selfHost = (request.headers.get("x-forwarded-host") || request.headers.get("host") || "").toLowerCase();
  if (oHost === selfHost) return true;
  return list(process.env.ALLOWED_ORIGINS).some((a) => hostOf(a) === oHost);
}

/** CORS headers: only ever echo an explicitly allowed origin — never "*". */
export function corsHeaders(request) {
  const origin = request.headers.get("origin");
  const oHost = origin && hostOf(origin);
  if (oHost && list(process.env.ALLOWED_ORIGINS).some((a) => hostOf(a) === oHost)) {
    return { "Access-Control-Allow-Origin": origin, "Vary": "Origin" };
  }
  return { "Vary": "Origin" }; // same-origin requests need no CORS header
}

export function preflight(request, methods) {
  return new Response(null, {
    status: 204,
    headers: {
      ...corsHeaders(request),
      "Access-Control-Allow-Methods": methods,
      "Access-Control-Allow-Headers": "Content-Type, x-brief-key",
      "Access-Control-Max-Age": "600",
    },
  });
}

function clientIp(request) {
  return (request.headers.get("x-forwarded-for") || "").split(",")[0].trim()
    || request.headers.get("x-real-ip") || "unknown";
}

function rateCheck(key, limit) {
  const now = Date.now();
  const arr = (hits.get(key) || []).filter((t) => now - t < WINDOW_MS);
  if (arr.length >= limit) {
    hits.set(key, arr);
    return { ok: false, retryAfter: Math.max(1, Math.ceil((WINDOW_MS - (now - arr[0])) / 1000)) };
  }
  arr.push(now);
  hits.set(key, arr);
  if (hits.size > 5000) { // keep memory bounded on long-lived instances
    for (const [k, v] of hits) if (!v.length || now - v[v.length - 1] > WINDOW_MS) hits.delete(k);
  }
  return { ok: true };
}

/**
 * guard(request, { bucket, limit }) →
 *   { ok: true, headers, security }  |  { ok: false, response }
 */
export function guard(request, { bucket = "default", limit } = {}) {
  const headers = corsHeaders(request);
  const deny = (status, error, extra = {}) => ({
    ok: false,
    response: new Response(JSON.stringify({ error, code: status }), {
      status,
      headers: { "Content-Type": "application/json", ...headers, ...extra },
    }),
  });

  if (!originAllowed(request)) return deny(403, "Origin not allowed.");

  const keys = list(process.env.BRIEF_ACCESS_KEY);
  if (keys.length) {
    const got = request.headers.get("x-brief-key") || "";
    if (!keys.some((k) => safeEqual(k, got))) {
      return deny(401, "Missing or invalid access key — enter the team access key in the brief form.");
    }
  }

  const max = limit ?? (Number(process.env.BRIEF_RATE_LIMIT) || 20);
  const r = rateCheck(`${bucket}:${clientIp(request)}`, max);
  if (!r.ok) {
    return deny(429, `Rate limit reached (${max} requests per 10 min). Try again in ${r.retryAfter}s.`,
      { "Retry-After": String(r.retryAfter) });
  }

  return {
    ok: true,
    headers,
    security: keys.length ? "key-protected" : "open — set BRIEF_ACCESS_KEY in Vercel env to lock this endpoint",
  };
}
