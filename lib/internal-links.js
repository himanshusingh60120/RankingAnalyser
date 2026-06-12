// lib/internal-links.js
// Suggests REAL internal links for new content by reading Kings Research's
// own sitemaps (reports, blogs, PR). Each suggestion is a live URL from the
// site, with a generated anchor text, ranked by how well it matches the
// draft's topic. Optionally enriched with GSC position + impressions so the
// writer links to pages that are actually ranking / getting impressions.

import { fetchPage } from "./fetcher.js";

// Kings Research sitemaps to mine for internal-link targets.
export const KR_SITEMAPS = [
  { type: "report", url: "https://www.kingsresearch.com/sitemap-reports.xml" },
  { type: "blog", url: "https://www.kingsresearch.com/sitemap-blogs.xml" },
  { type: "pr", url: "https://www.kingsresearch.com/sitemap-pr.xml" },
];

const GENERIC = new Set([
  "market", "markets", "report", "reports", "size", "share", "growth",
  "industry", "analysis", "global", "forecast", "trends", "outlook", "and",
  "the", "of", "by", "to", "in", "for", "a", "an", "blog", "with", "how",
  "what", "why", "is", "are", "your", "you", "kings", "research", "www",
  "com", "https", "http",
]);

function tokenize(text) {
  return (text || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/[\s-]+/)
    .filter((t) => t.length > 2 && !GENERIC.has(t));
}

// Turn a slug into readable anchor text. report/blog slugs end in -<id>; drop it.
function slugToAnchor(url, type) {
  try {
    const path = new URL(url).pathname.replace(/\/+$/, "");
    let slug = path.split("/").pop() || "";
    slug = slug.replace(/-\d+$/, ""); // strip trailing numeric id
    const words = slug.split(/-+/).filter(Boolean);
    if (!words.length) return null;
    const titled = words
      .map((w) => (w.length <= 3 ? w.toUpperCase() === w ? w : w : w[0].toUpperCase() + w.slice(1)))
      .join(" ");
    // Reports read naturally with "Market" already in the slug; blogs read as titles.
    return titled;
  } catch {
    return null;
  }
}

// Fetch + parse one sitemap into [{ url, type, tokens, anchor }].
async function loadSitemap(sm) {
  try {
    const { status, html } = await fetchPage(sm.url, { retries: 1, timeoutMs: 15000 });
    if (status !== 200 || !html) return [];
    const locs = [...html.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((m) => m[1].trim());
    return locs
      .map((url) => {
        const anchor = slugToAnchor(url, sm.type);
        if (!anchor) return null;
        return { url, type: sm.type, anchor, tokens: tokenize(url + " " + anchor) };
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

let _cache = null;
let _cacheAt = 0;
const CACHE_MS = 10 * 60 * 1000; // 10 min — sitemaps change slowly

export async function loadAllSitemaps() {
  if (_cache && Date.now() - _cacheAt < CACHE_MS) return _cache;
  const lists = await Promise.all(KR_SITEMAPS.map(loadSitemap));
  _cache = lists.flat();
  _cacheAt = Date.now();
  return _cache;
}

// Score how well a sitemap entry matches the draft's topic tokens (overlap).
function matchScore(entryTokens, draftTokenSet, keywordTokenSet) {
  let score = 0;
  for (const t of entryTokens) {
    if (keywordTokenSet.has(t)) score += 3; // keyword tokens weigh most
    else if (draftTokenSet.has(t)) score += 1;
  }
  return score;
}

/**
 * Suggest internal links for a draft.
 * @param {string} keyword
 * @param {string} content   raw draft text
 * @param {string} selfUrl   optional — the page being written (excluded from suggestions)
 * @param {number} limit     how many to return
 * @returns [{ url, anchor, type, score }]
 */
export async function suggestInternalLinks(keyword, content, selfUrl, limit = 8) {
  const entries = await loadAllSitemaps();
  if (!entries.length) return { entries: [], suggestions: [] };

  const draftTokenSet = new Set(tokenize(content).slice(0, 400));
  const keywordTokenSet = new Set(tokenize(keyword));
  const selfPath = (() => { try { return selfUrl ? new URL(selfUrl).pathname.replace(/\/+$/, "") : null; } catch { return null; } })();

  const scored = entries
    .map((e) => ({ ...e, score: matchScore(e.tokens, draftTokenSet, keywordTokenSet) }))
    .filter((e) => e.score > 0)
    .filter((e) => {
      if (!selfPath) return true;
      try { return new URL(e.url).pathname.replace(/\/+$/, "") !== selfPath; } catch { return true; }
    })
    .sort((a, b) => b.score - a.score);

  // De-dupe by URL, keep a healthy mix of reports + blogs.
  const seen = new Set();
  const out = [];
  for (const e of scored) {
    if (seen.has(e.url)) continue;
    seen.add(e.url);
    out.push({ url: e.url, anchor: e.anchor, type: e.type, score: e.score });
    if (out.length >= limit) break;
  }
  return { entries, suggestions: out };
}
