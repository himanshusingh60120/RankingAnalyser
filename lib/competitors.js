// lib/competitors.js
// Auto-finds the matching report on the FIVE FIXED competitor sites only.
// These are the competitors specified for cross-checking — no others.

import { fetchPage } from "./fetcher.js";

// Locked competitor set.
export const COMPETITOR_SITES = [
  "marketresearchfuture.com",
  "futuremarketinsights.com",
  "marketsandmarkets.com",
  "precedenceresearch.com",
  "persistencemarketresearch.com",
];

// Generic words that don't identify the topic — ignored when matching.
const GENERIC = new Set([
  "market", "markets", "report", "reports", "size", "share", "growth",
  "industry", "analysis", "global", "forecast", "trends", "outlook", "and",
  "the", "of", "by", "to", "in", "for",
]);

/** Significant tokens of a keyword (topic words only). */
export function keywordTokens(keyword) {
  return (keyword || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/[\s-]+/)
    .filter((t) => t.length > 2 && !GENERIC.has(t));
}

/**
 * STRICT keyword match: ALL significant tokens must appear in the URL slug
 * or the page title. "phosphoric acid" will never match a nitrogen-gas page.
 */
export function keywordMatches(keyword, url = "", title = "") {
  const tokens = keywordTokens(keyword);
  if (!tokens.length) return true; // nothing to enforce
  const hay = (url + " " + title).toLowerCase();
  return tokens.every((t) => hay.includes(t));
}

/**
 * Find the best-matching report URL on each fixed competitor site for a keyword.
 * Strategy, in order of preference:
 *   1. A configured search provider (Google Programmable Search or Bing) via env.
 *   2. The site's own on-site search results page (parsed for the first report link).
 * Returns [{ site, url, method }] (url may be null if nothing found).
 */
export async function findCompetitorUrls(keyword, contentType = "report") {
  const isBlog = contentType === "blog";
  const results = [];
  for (const site of COMPETITOR_SITES) {
    let url = null;
    let method = "none";

    // 1. External search provider (most reliable) if configured.
    //    For blogs, scope the query to articles/insights/blog content.
    url = await viaSearchProvider(keyword, site, isBlog);
    if (url && !keywordMatches(keyword, url, "")) url = null; // strict
    if (url && !(await isLivePage(url))) url = null;          // must be live
    if (url) method = isBlog ? "search-api(blog)" : "search-api";

    // 2. Direct slug probe ONLY makes sense for report pages (predictable URLs).
    //    Blogs live at unpredictable paths, so we skip blind probing for them.
    if (!url && !isBlog) {
      url = await viaSlugProbe(keyword, site);
      if (url) method = "slug-probe"; // viaSlugProbe already verifies 200
    }

    // 3. Fallback: the site's own search page (strict-matched).
    if (!url) {
      const cand = await viaOnSiteSearch(keyword, site, isBlog);
      if (cand && (await isLivePage(cand))) {
        url = cand;
        method = isBlog ? "on-site-search(blog)" : "on-site-search";
      }
    }

    results.push({ site, url, method });
  }
  return results;
}

/**
 * Verify a candidate URL actually resolves to a live, substantial page.
 * Prevents "faked" matches where a search API returns a stale/redirected
 * URL that 404s or redirects away. A real report/article page is 200 and
 * has meaningful HTML; soft-404s and redirects to a hub are rejected.
 */
async function isLivePage(url) {
  try {
    const { status, html, finalUrl } = await fetchPage(url, { retries: 1, timeoutMs: 14000 });
    if (status !== 200 || !html || html.length < 12000) return false;
    // If the fetch landed somewhere else entirely (redirect to a category hub
    // or search page), distrust it.
    if (finalUrl && !sameCorePath(url, finalUrl)) return false;
    return true;
  } catch {
    return false;
  }
}

// Loose check that we ended up on (broadly) the page we asked for, not a
// redirect to a different section. Compares the last path segment.
function sameCorePath(a, b) {
  try {
    const seg = (u) => new URL(u).pathname.replace(/\/+$/, "").split("/").pop().toLowerCase();
    const sa = seg(a), sb = seg(b);
    if (!sa || !sb) return true; // can't tell — don't over-reject
    return sb.includes(sa) || sa.includes(sb);
  } catch {
    return true;
  }
}

// Probe the predictable report-URL patterns directly with the keyword slug.
async function viaSlugProbe(keyword, site) {
  const tokens = keywordTokens(keyword);
  const slug = tokens.join("-");
  if (!slug) return null;
  const slugMarket = `${slug}-market`;
  const candidates = {
    "precedenceresearch.com": [`https://www.precedenceresearch.com/${slugMarket}`],
    "futuremarketinsights.com": [
      `https://www.futuremarketinsights.com/reports/${slugMarket}`,
    ],
    "marketresearchfuture.com": [
      `https://www.marketresearchfuture.com/reports/${slugMarket}`,
    ],
    "persistencemarketresearch.com": [
      `https://www.persistencemarketresearch.com/market-research/${slugMarket}.asp`,
    ],
    "marketsandmarkets.com": [], // numeric IDs in path — can't probe blind
  }[site] || [];

  for (const cand of candidates) {
    const { status, html, finalUrl } = await fetchPage(cand, { retries: 0, timeoutMs: 12000 });
    // Must be a real 200 with substantial HTML (rules out hard failures).
    if (status !== 200 || !html || html.length < 20000) continue;
    // The probed URL is FABRICATED from the keyword, so 200 + length alone is
    // NOT proof the report exists — these sites serve soft-404s as 200 and may
    // redirect to a broader report. Verify against the page's OWN <title>, and
    // confirm the fetch did not bounce to a different slug.
    const title = (html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1] || "").toLowerCase();
    const titleAboutKeyword = !!title && tokens.every((t) => title.includes(t));
    const landedHere = !finalUrl || finalUrl.toLowerCase().includes(slugMarket);
    if (titleAboutKeyword && landedHere) return cand;
  }
  return null;
}

// --- Provider 1: Google Programmable Search (CSE) or Bing, via env vars ---
async function viaSearchProvider(keyword, site, isBlog = false) {
  // Blogs: search for an article/insight, not a report page.
  const q = isBlog ? `${keyword} (blog OR insights OR article OR guide)` : `${keyword} market report`;
  // For blogs we POSITIVELY look for article-style paths and reject report pages.
  const blogPath = /\/(blog|blogs|insights?|articles?|resources?|knowledge|learn|guides?)\//i;
  const reportPath = /\/reports?\/|-market-?\d*\/?$|\/report\//i;
  const accept = (link) => {
    if (!link || !link.includes(site)) return false;
    if (isBlog) {
      // Prefer a clear blog/insight path; always reject obvious report URLs.
      if (reportPath.test(link)) return false;
      return blogPath.test(link) || /\/[a-z0-9-]{8,}\/?$/i.test(link);
    }
    return true;
  };
  // Among CSE results, pick the FIRST that passes accept AND matches the keyword
  // tokens — order is relevance, so the first valid hit is best.
  const pick = (items, getLink) => {
    for (const it of items || []) {
      const link = getLink(it);
      if (accept(link) && keywordMatches(keyword, link, it.title || "")) return link;
    }
    return null;
  };

  // Google Programmable Search
  const gKey = process.env.GOOGLE_CSE_KEY;
  const gCx = process.env.GOOGLE_CSE_CX;
  if (gKey && gCx) {
    try {
      const u = `https://www.googleapis.com/customsearch/v1?key=${gKey}&cx=${gCx}&q=${encodeURIComponent(
        q
      )}&siteSearch=${encodeURIComponent(site)}&num=5`;
      const r = await fetch(u);
      if (r.ok) {
        const data = await r.json();
        const link = pick(data.items, (it) => it.link);
        if (link) return link;
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
      )}&count=5`;
      const r = await fetch(u, { headers: { "Ocp-Apim-Subscription-Key": bKey } });
      if (r.ok) {
        const data = await r.json();
        const link = pick(data.webPages?.value, (it) => it.url);
        if (link) return link;
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
async function viaOnSiteSearch(keyword, site, isBlog = false) {
  const enc = encodeURIComponent(keyword);
  const searchUrls = {
    "marketresearchfuture.com": `https://www.marketresearchfuture.com/search?q=${enc}`,
    "futuremarketinsights.com": `https://www.futuremarketinsights.com/search?keyword=${enc}`,
    "marketsandmarkets.com": `https://www.marketsandmarkets.com/search.asp?Search=${enc}`,
    "precedenceresearch.com": `https://www.precedenceresearch.com/search?q=${enc}`,
    // NOTE: Persistence's exact search-results endpoint is unverified; this is a
    // best-effort guess. Slug-probe handles most Persistence reports regardless,
    // and a wrong endpoint here fails safe (no candidate returned).
    "persistencemarketresearch.com": `https://www.persistencemarketresearch.com/search.asp?Search=${enc}`,
  };
  // Report-page path patterns (used when matching reports).
  const reportPathRe = {
    "marketresearchfuture.com": /\/(reports|en)\/[a-z0-9-]+/i,
    "futuremarketinsights.com": /\/reports\/[a-z0-9-]+/i,
    "marketsandmarkets.com": /Market-Reports\/[a-z0-9-]+\.html/i,
    "precedenceresearch.com": /precedenceresearch\.com\/[a-z0-9-]+-market/i,
    "persistencemarketresearch.com": /\/market-research\/[a-z0-9-]+\.asp/i,
  };
  // Blog/article/insight path patterns (used when matching blogs).
  const blogPathRe = {
    "marketresearchfuture.com": /\/(blog|insights|articles?)\/[a-z0-9-]+/i,
    "futuremarketinsights.com": /\/(blog|insights|articles?)\/[a-z0-9-]+/i,
    "marketsandmarkets.com": /\/(blog|insights|articles?)\/[a-z0-9-]+/i,
    "precedenceresearch.com": /\/(blog|insights|articles?)\/[a-z0-9-]+/i,
    "persistencemarketresearch.com": /\/(blog|insights|articles?)\/[a-z0-9-]+/i,
  };

  const su = searchUrls[site];
  if (!su) return null;
  const { status, html } = await fetchPage(su, { retries: 1 });
  if (status !== 200 || !html) return null;

  const re = (isBlog ? blogPathRe : reportPathRe)[site];
  const hrefs = [...html.matchAll(/href=["']([^"']+)["']/gi)].map((m) => m[1]);
  // STRICT: every significant keyword token must appear in the URL.
  // No loose fallback — a wrong-topic match is worse than no match.
  for (const h of hrefs) {
    const abs = absolutize(h, site);
    if (!abs) continue;
    if (re.test(abs) && keywordMatches(keyword, abs, "")) {
      return abs;
    }
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
