// lib/kv.js
// Tiny wrapper over Vercel KV / Upstash Redis REST API using fetch — no npm
// dependency. Used for the Screaming Frog crawl job queue and index-status store.
//
// Recognizes every common env-var name Vercel/Upstash may inject, with or
// without a "STORAGE_" prefix, so it works no matter how the store was added.

function firstEnv(names) {
  for (const n of names) {
    // exact match
    if (process.env[n]) return process.env[n];
  }
  // prefix-tolerant match (e.g. STORAGE_KV_REST_API_URL, myredis_KV_REST_API_URL)
  for (const key of Object.keys(process.env)) {
    for (const n of names) {
      if (key === n || key.endsWith("_" + n)) {
        if (process.env[key]) return process.env[key];
      }
    }
  }
  return "";
}

const URL_ = () => firstEnv(["KV_REST_API_URL", "UPSTASH_REDIS_REST_URL", "REDIS_URL"]);
const TOK_ = () => firstEnv(["KV_REST_API_TOKEN", "UPSTASH_REDIS_REST_TOKEN", "KV_REST_API_READ_ONLY_TOKEN"]);

export function isKvConfigured() {
  return Boolean(URL_() && TOK_());
}

/** Human-readable reason KV is unavailable, for clear API errors (never throws). */
export function kvStatus() {
  const url = URL_(), tok = TOK_();
  if (url && tok) return { ok: true };
  return {
    ok: false,
    reason: !url && !tok ? "No KV env vars found (KV_REST_API_URL / KV_REST_API_TOKEN)."
      : !url ? "KV token found but KV_REST_API_URL is missing."
      : "KV URL found but KV_REST_API_TOKEN is missing.",
  };
}

async function cmd(args) {
  const url = URL_(), tok = TOK_();
  if (!url || !tok) throw new Error("KV store not configured (KV_REST_API_URL / KV_REST_API_TOKEN).");
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
    body: JSON.stringify(args),
  });
  if (!res.ok) throw new Error(`KV ${args[0]} failed: ${res.status} ${await res.text().catch(() => "")}`);
  const data = await res.json();
  return data.result;
}

export const kvGet = (key) => cmd(["GET", key]);
export const kvSet = (key, val, ttlSec) =>
  ttlSec ? cmd(["SET", key, val, "EX", String(ttlSec)]) : cmd(["SET", key, val]);
export const kvDel = (key) => cmd(["DEL", key]);
export const kvLPush = (key, val) => cmd(["LPUSH", key, val]);
export const kvRPop = (key) => cmd(["RPOP", key]);
export const kvLRange = (key, a = 0, b = -1) => cmd(["LRANGE", key, String(a), String(b)]);

export async function kvGetJSON(key) {
  const v = await kvGet(key);
  if (v == null) return null;
  try { return typeof v === "string" ? JSON.parse(v) : v; } catch { return null; }
}
export const kvSetJSON = (key, obj, ttlSec) => kvSet(key, JSON.stringify(obj), ttlSec);

export async function kvMGetJSON(keys) {
  if (!keys.length) return [];
  const vals = await cmd(["MGET", ...keys]);
  return vals.map((v) => { try { return v == null ? null : JSON.parse(v); } catch { return null; } });
}
