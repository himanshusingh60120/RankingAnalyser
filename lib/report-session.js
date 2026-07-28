// lib/report-session.js
// Supports the free-tier "one language per request" mode. Each per-language
// request stores its computed slice in KV under a session id; a final assemble
// request reads all slices and builds the workbook — so no single function call
// has to process all ~27k URLs (which would exceed Vercel Hobby's 60s limit).

import { kvSetJSON, kvGetJSON, kvDel } from "./kv.js";

const TTL = 60 * 60 * 2; // 2 hours — a session only needs to live through one run

/** Known language path prefixes on the site (root = default/English). */
const LANG_PREFIXES = ["fr", "de", "es", "zh", "ko", "pt", "ru", "tr", "ja",
  "it", "nl", "pl", "id", "th", "vi", "ar", "hi"];

/**
 * A GSC page-dimension regex that scopes a query to one language, so each
 * per-language request pulls only that language's rows (fast, small).
 * @param {string} code  e.g. "fr" or "x-default"
 * @returns {{ pageIncludingRegex?: string, pageExcludingRegex?: string }}
 */
export function pageFilterForLang(code) {
  if (!code || code === "x-default") {
    // English/root = pages NOT under any known language prefix
    return { pageExcludingRegex: `/(${LANG_PREFIXES.join("|")})/` };
  }
  const base = code.split("-")[0];
  return { pageIncludingRegex: `/${base}/` };
}

const key = (sessionId, langCode) => `hlreport:${sessionId}:${langCode}`;
const metaKey = (sessionId) => `hlreport:${sessionId}:_meta`;

/** Store one language's computed slice. */
export async function saveSlice(sessionId, langCode, slice) {
  await kvSetJSON(key(sessionId, langCode), slice, TTL);
}

/** Record/refresh session metadata (weeks, filters, language list). */
export async function saveSessionMeta(sessionId, meta) {
  const prev = (await kvGetJSON(metaKey(sessionId))) || { langs: [] };
  const langs = Array.from(new Set([...(prev.langs || []), ...(meta.langs || [])]));
  await kvSetJSON(metaKey(sessionId), { ...prev, ...meta, langs }, TTL);
}

export async function loadSession(sessionId) {
  const meta = await kvGetJSON(metaKey(sessionId));
  if (!meta) return null;
  const slices = [];
  for (const code of meta.langs || []) {
    const s = await kvGetJSON(key(sessionId, code));
    if (s) slices.push(s);
  }
  return { meta, slices };
}

export async function clearSession(sessionId) {
  const meta = await kvGetJSON(metaKey(sessionId));
  if (meta) for (const code of meta.langs || []) await kvDel(key(sessionId, code)).catch(() => {});
  await kvDel(metaKey(sessionId)).catch(() => {});
}
