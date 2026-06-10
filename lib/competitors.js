// lib/competitors.js
// Auto-finds the matching report on the FOUR FIXED competitor sites only.
// These are the competitors specified for cross-checking — no others.

import { fetchPage } from "./fetcher.js";

// Locked competitor set.
export const COMPETITOR_SITES = [
  "marketresearchfuture.com",
  "futuremarketinsights.com",
  "marketsandmarkets.com",
  "precedenceresearch.com",
];

/**
 * Find the best-matching report URL on each fixed competitor site for a keyword.
 * Strategy, in order of preference:
 *   1. A configured search provider (Google Programmable Search or Bing) via env.
 *   2. The site's own on-site search results page (parsed for the first report link).
 * Returns [{ site, url, method }] (url may be null if nothing found).
 */
export async function findCompetitorUrls(keyword) {
  const results = [];
  for (const site of COMPETITOR_SITES) {
    let url = null;
    let method = "none";

    // 1. External search provider (most reliable) if configured.
    url = await viaSearchProvider(keyword, site);
    if (url) method = "search-api";

    // 2. Fallback: the site's own search page.
    if (!url) {
      url = await viaOnSiteSearch(keyword, site);
      if (url) method = "on-site-search";
    }

    results.push({ site, url, method });
  }
  return results;
}

// --- Provider 1: Google Programmable Search (CSE) or Bing, via env vars ---
async function viaSearchProvider(keyword, site) {
  const q = `${keyword} market report`;

  // Google Programmable Search
  const gKey = process.env.GOOGLE_CSE_KEY;
  const gCx = process.env.GOOGLE_CSE_CX;
  if (gKey && gCx) {
    try {
      const u = `https://www.googleapis.com/customsearch/v1?key=${gKey}&cx=${gCx}&q=${encodeURIComponent(
        q
      )}&siteSearch=${encodeURIComponent(site)}&num=3`;
      const r = await fetch(u);
      if (r.ok) {
        const data = await r.json();
        const item = (data.items || []).find((it) => (it.link || "").includes(site));
        if (item) return item.link;
      }
    } catch {
      /* fall through */
    }
  }

  // Bing Web Search
  const bKey = process.env.BING_SEARCH_KEY;
  if (bKey) {
    try {
      const u = `https://api.bing.microsoft.com/v7.0/search?q=${encodeURIComponent(
        `${q} site:${site}`
      )}&count=3`;
      const r = await fetch(u, { headers: { "Ocp-Apim-Subscription-Key": bKey } });
      if (r.ok) {
        const data = await r.json();
        const item = (data.webPages?.value || []).find((it) =>
          (it.url || "").includes(site)
        );
        if (item) return item.url;
      }
    } catch {
      /* fall through */
    }
  }

  return null;
}

// --- Provider 2: the site's own search page (best-effort HTML parse) ---
// Each site exposes a search endpoint; we request it and pull the first
// result link that points at a report path.
async function viaOnSiteSearch(keyword, site) {
  const enc = encodeURIComponent(keyword);
  const searchUrls = {
    "marketresearchfuture.com": `https://www.marketresearchfuture.com/search?q=${enc}`,
    "futuremarketinsights.com": `https://www.futuremarketinsights.com/search?keyword=${enc}`,
    "marketsandmarkets.com": `https://www.marketsandmarkets.com/search.asp?Search=${enc}`,
    "precedenceresearch.com": `https://www.precedenceresearch.com/search?q=${enc}`,
  };
  const reportPathRe = {
    "marketresearchfuture.com": /\/(reports|en)\/[a-z0-9-]+/i,
    "futuremarketinsights.com": /\/reports\/[a-z0-9-]+/i,
    "marketsandmarkets.com": /Market-Reports\/[a-z0-9-]+\.html/i,
    "precedenceresearch.com": /precedenceresearch\.com\/[a-z0-9-]+-market/i,
  };

  const su = searchUrls[site];
  if (!su) return null;
  const { status, html } = await fetchPage(su, { retries: 1 });
  if (status !== 200 || !html) return null;

  const re = reportPathRe[site];
  // collect hrefs, pick the first that matches a report path and contains a
  // keyword token (so we don't grab an unrelated featured report).
  const hrefs = [...html.matchAll(/href=["']([^"']+)["']/gi)].map((m) => m[1]);
  const kwTokens = keyword.toLowerCase().split(/\s+/).filter((t) => t.length > 2);
  for (const h of hrefs) {
    const abs = absolutize(h, site);
    if (!abs) continue;
    if (re.test(abs) && kwTokens.some((t) => abs.toLowerCase().includes(t))) {
      return abs;
    }
  }
  // looser: first report-path match even without keyword token
  for (const h of hrefs) {
    const abs = absolutize(h, site);
    if (abs && re.test(abs)) return abs;
  }
  return null;
}

function absolutize(href, site) {
  try {
    if (href.startsWith("http")) return href;
    if (href.startsWith("/")) return `https://www.${site}${href}`;
    return null;
  } catch {
    return null;
  }
}
