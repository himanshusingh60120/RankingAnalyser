// lib/kv.js
// Tiny wrapper over Vercel KV (Upstash Redis REST API) using fetch — no npm
// dependency. Used for the Screaming Frog crawl job queue and the parsed
// index-status store.
//
// Requires the env vars Vercel injects when you add a KV/Upstash store:
//   KV_REST_API_URL
//   KV_REST_API_TOKEN
// If they're missing, isKvConfigured() returns false and callers surface a
// clear "connect a KV store" message instead of crashing.

const URL_ = () => process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || "";
const TOK_ = () => process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || "";

export function isKvConfigured() {
  return Boolean(URL_() && TOK_());
}

async function cmd(args) {
  if (!isKvConfigured()) throw new Error("KV store not configured (KV_REST_API_URL / KV_REST_API_TOKEN).");
  const res = await fetch(URL_(), {
    method: "POST",
    headers: { Authorization: `Bearer ${TOK_()}`, "Content-Type": "application/json" },
    body: JSON.stringify(args),
  });
  if (!res.ok) throw new Error(`KV ${args[0]} failed: ${res.status} ${await res.text().catch(() => "")}`);
  const data = await res.json();
  return data.result;
}

async function pipeline(commands) {
  if (!isKvConfigured()) throw new Error("KV store not configured.");
  const res = await fetch(`${URL_()}/pipeline`, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOK_()}`, "Content-Type": "application/json" },
    body: JSON.stringify(commands),
  });
  if (!res.ok) throw new Error(`KV pipeline failed: ${res.status} ${await res.text().catch(() => "")}`);
  return (await res.json()).map((r) => r.result);
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
