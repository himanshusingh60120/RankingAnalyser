// lib/crawl-store.js
// Reads the latest completed Screaming Frog crawl (stored in KV by
// /api/crawl/ingest) into a Map for the report to look up per-URL index status.

import { isKvConfigured, kvGetJSON, kvMGetJSON } from "./kv.js";

/**
 * @returns {Promise<{ map: Map<string,{indexed:boolean|null,label:string,statusCode:string}>,
 *                     meta: object|null }>}
 * map is keyed by BOTH the exact URL and its normalized form for robust matching.
 */
export async function loadLatestCrawl() {
  if (!isKvConfigured()) return { map: new Map(), meta: null };
  const latest = await kvGetJSON("crawl:latest");
  if (!latest || !Array.isArray(latest.chunkKeys) || !latest.chunkKeys.length) {
    return { map: new Map(), meta: latest || null };
  }
  const map = new Map();
  // fetch chunks in batches
  const keys = latest.chunkKeys;
  for (let i = 0; i < keys.length; i += 25) {
    const batch = await kvMGetJSON(keys.slice(i, i + 25));
    for (const chunk of batch) {
      if (!Array.isArray(chunk)) continue;
      for (const r of chunk) {
        const rec = { indexed: r.i, label: r.l, statusCode: r.s };
        if (r.u) map.set(r.u, rec);
        if (r.n) map.set(r.n, rec);
      }
    }
  }
  return { map, meta: latest };
}
