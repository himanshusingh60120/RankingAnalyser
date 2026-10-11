// lib/competitors.js
// Auto-finds the matching report on the FIVE FIXED competitor sites only,
// and checks the live Google SERP (via lib/serp.js — Serper / SerpApi) so the
// planner knows which of them ACTUALLY rank for the keyword — the ones to beat.

import { fetchPage } from "./fetcher.js";
import { searchGoogle } from "./serp.js";

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
 * Kept strict — used for fabricated (slug-probed) URLs and by /api/analyze.
 */
export function keywordMatches(keyword, url = "", title = "") {
  const tokens = keywordTokens(keyword);
  if (!tokens.length) return true; // nothing to enforce
  const hay = (url + " " + title).toLowerCase();
  return tokens.every((t) => hay.includes(t));
}

/**
 * RELAXED match for TRUSTED urls (search-API / on-site-search results, which
 * are real pages, not fabricated): the head noun (last topic token) MUST be
 * present; short keywords (≤3 tokens) still need every token; longer keywords
 * may miss ONE modifier. Fixes false negatives like a 4-token keyword failing
 * against a competitor titled with 3 of the 4 tokens — the benchmark that
 * matters most would otherwise be silently dropped.
 */
export function keywordMatchesRelaxed(keyword, url = "", title = "") {
  const tokens = keywordTokens(keyword);
  if (!tokens.length) return true;
  const hay = (url + " " + title).toLowerCase();
  const head = tokens[tokens.length - 1];
  if (!hay.includes(head)) return false;
  const hits = tokens.filter((t) => hay.includes(t)).length;
  return tokens.length <= 3 ? hits === tokens.length : hits >= tokens.length - 1;
}

/**
 * Live SERP check — which of the five fixed competitors (and our own site)
 * hold Google top-10 positions for the keyword. Reuses lib/serp.js, so it runs
 * on Serper / SerpApi (same SERPER_API_KEY as the Content Brief) and survives
 * the Google CSE shutdown on 1 Jan 2027. Fails soft when no provider is set.
 */
export async function serpPositions(keyword, { gl, hl } = {}) {
  const ourDomain = String(process.env.OUR_DOMAIN || process.env.GSC_SITE_URL || "kingsresearch.com")
    .trim().replace(/^sc-domain:/i, "").replace(/^https?:\/\//i, "").replace(/^www\./i, "").replace(/\/.*$/, "").toLowerCase();
  try {
    const serp = await searchGoogle(keyword, {
      gl: gl || process.env.SERP_DEFAULT_GL || "us",
      hl: hl || process.env.SERP_DEFAULT_HL || "en",
      num: 10,
    });
    const top10 = [];
    for (const r of serp.organic || []) {
      const host = r.domain || "";
      const comp = COMPETITOR_SITES.find((s) => host === s || host.endsWith("." + s));
      const self = !!ourDomain && (host === ourDomain || host.endsWith("." + ourDomain));
      if (comp || self) {
        top10.push({ position: r.position, site: self ? `${ourDomain} (you)` : comp, url: r.link, title: r.title || "" });
      }
    }
    return { available: true, provider: serp.provider, query: keyword, gl: serp.gl, top10, warning: serp.warning || null };
  } catch (e) {
    return {
      available: false,
      reason: e.code === "NO_SERP_PROVIDER" ? "no SERP provider configured — add SERPER_API_KEY" : String(e.message || e),
    };
  }
}

/**
 * Find the best-matching report URL on each fixed competitor site for a keyword.
 * Strategy per site, in order of preference:
 *   1. A configured search provider (Google Programmable Search or Bing) via env.
 *   2. Direct slug probe (reports only — predictable URLs).
 *   3. The site's own on-site search results page.
 * PARALLEL across the 5 sites (discovery per site is independent); a
 * sequential loop could eat most of the 60s function budget by itself.
 * Returns [{ site, url, method }] in the fixed site order (url may be null).
 */
export async function findCompetitorUrls(keyword, contentType = "report") {
  const isBlog = contentType === "blog";

  const findForSite = async (site) => {
    let url = null;
    let method = "none";

    // 1. External search provider (most reliable) if configured.
    url = await viaSearchProvider(keyword, site, isBlog);
    if (url && !keywordMatchesRelaxed(keyword, url, "")) url = null; // real URL → relaxed
    if (url && !(await isLivePage(url))) url = null;                 // must be live
    if (url) method = isBlog ? "search-api(blog)" : "search-api";

    // 2. Direct slug probe ONLY for report pages (predictable URLs).
    if (!url && !isBlog) {
      url = await viaSlugProbe(keyword, site);
      if (url) method = "slug-probe"; // viaSlugProbe verifies 200 + own <title>
    }

    // 3. Fallback: the site's own search page.
    if (!url) {
      const cand = await viaOnSiteSearch(keyword, site, isBlog);
      if (cand && (await isLivePage(cand))) {
        url = cand;
        method = isBlog ? "on-site-search(blog)" : "on-site-search";
      }
    }

    return { site, url, method };
  };

  return Promise.all(COMPETITOR_SITES.map(findForSite));
}

/**
 * Verify a candidate URL actually resolves to a live, substantial page.
 * Prevents "faked" matches where a search API returns a stale/redirected
 * URL that 404s or redirects away.
 */
async function isLivePage(url) {
  try {
    const { status, html, finalUrl } = await fetchPage(url, { retries: 1, timeoutMs: 14000 });
    if (status !== 200 || !html || html.length < 12000) return false;
    if (finalUrl && !sameCorePath(url, finalUrl)) return false;
    return true;
  } catch {
    return false;
  }
}

// Loose check that we ended up on (broadly) the page we asked for.
function sameCorePath(a, b) {
  try {
    const seg = (u) => new URL(u).pathname.replace(/\/+$/, "").split("/").pop().toLowerCase();
    const sa = seg(a), sb = seg(b);
    if (!sa || !sb) return true;
    return sb.includes(sa) || sa.includes(sb);
  } catch {
    return true;
  }
}

// Probe the predictable report-URL patterns directly with the keyword slug.
// Tries the "-market" suffix AND the bare slug where sites publish both.
async function viaSlugProbe(keyword, site) {
  const tokens = keywordTokens(keyword);
  const slug = tokens.join("-");
  if (!slug) return null;
  const slugMarket = `${slug}-market`;

  const candidates = {
    "precedenceresearch.com": [`https://www.precedenceresearch.com/${slugMarket}`],
    "futuremarketinsights.com": [
      `https://www.futuremarketinsights.com/reports/${slugMarket}`,
      `https://www.futuremarketinsights.com/reports/${slug}`,
    ],
    "marketresearchfuture.com": [
      `https://www.marketresearchfuture.com/reports/${slugMarket}`,
      `https://www.marketresearchfuture.com/reports/${slug}`,
    ],
    "persistencemarketresearch.com": [
      `https://www.persistencemarketresearch.com/market-research/${slugMarket}.asp`,
    ],
    "marketsandmarkets.com": [], // numeric IDs in path — can't probe blind
  }[site] || [];

  for (const cand of candidates) {
    const { status, html, finalUrl } = await fetchPage(cand, { retries: 0, timeoutMs: 12000 });
    if (status !== 200 || !html || html.length < 20000) continue;
    // Fabricated URL → must self-prove via the page's OWN <title>, STRICT,
    // and the fetch must not have bounced to a different slug.
    const title = (html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1] || "").toLowerCase();
    const titleAboutKeyword = !!title && tokens.every((t) => title.includes(t));
    const landedHere = !finalUrl || finalUrl.toLowerCase().includes(slug);
    if (titleAboutKeyword && landedHere) return cand;
  }
  return null;
}

// --- Provider 1: Google Programmable Search (CSE) or Bing, via env vars ---
async function viaSearchProvider(keyword, site, isBlog = false) {
  const q = isBlog ? `${keyword} (blog OR insights OR article OR guide)` : `${keyword} market report`;
  const blogPath = /\/(blog|blogs|insights?|articles?|resources?|knowledge|learn|guides?)\//i;
  const reportPath = /\/reports?\/|-market-?\d*\/?$|\/report\//i;

  const accept = (link) => {
    if (!link || !link.includes(site)) return false;
    if (isBlog) {
      if (reportPath.test(link)) return false;
      return blogPath.test(link) || /\/[a-z0-9-]{8,}\/?$/i.test(link);
    }
    return true;
  };

  // Pick the FIRST result that passes accept AND (relaxed) keyword match —
  // results arrive in relevance order, and these are REAL urls, so the
  // relaxed matcher applies (strict matching dropped near-miss titles).
  const pick = (items, getLink) => {
    for (const it of items || []) {
      const link = getLink(it);
      if (accept(link) && keywordMatchesRelaxed(keyword, link, it.title || "")) return link;
    }
    return null;
  };

  const gKey = process.env.GOOGLE_CSE_KEY;
  const gCx = process.env.GOOGLE_CSE_CX;
  if (gKey && gCx) {
    try {
      const u = `https://www.googleapis.com/customsearch/v1?key=${gKey}&cx=${gCx}&q=${encodeURIComponent(q)}&siteSearch=${encodeURIComponent(site)}&num=5`;
      const r = await fetch(u);
      if (r.ok) {
        const data = await r.json();
        const link = pick(data.items, (it) => it.link);
        if (link) return link;
      }
    } catch { /* fall through */ }
  }

  const bKey = process.env.BING_SEARCH_KEY;
  if (bKey) {
    try {
      const u = `https://api.bing.microsoft.com/v7.0/search?q=${encodeURIComponent(`${q} site:${site}`)}&count=5`;
      const r = await fetch(u, { headers: { "Ocp-Apim-Subscription-Key": bKey } });
      if (r.ok) {
        const data = await r.json();
        const link = pick(data.webPages?.value, (it) => it.url);
        if (link) return link;
      }
    } catch { /* fall through */ }
  }
  return null;
}

// --- Provider 2: the site's own search page (best-effort HTML parse) ---
async function viaOnSiteSearch(keyword, site, isBlog = false) {
  const enc = encodeURIComponent(keyword);
  const searchUrls = {
    "marketresearchfuture.com": `https://www.marketresearchfuture.com/search?q=${enc}`,
    "futuremarketinsights.com": `https://www.futuremarketinsights.com/search?keyword=${enc}`,
    "marketsandmarkets.com": `https://www.marketsandmarkets.com/search.asp?Search=${enc}`,
    "precedenceresearch.com": `https://www.precedenceresearch.com/search?q=${enc}`,
    "persistencemarketresearch.com": `https://www.persistencemarketresearch.com/search.asp?Search=${enc}`,
  };
  const reportPathRe = {
    "marketresearchfuture.com": /\/(reports|en)\/[a-z0-9-]+/i,
    "futuremarketinsights.com": /\/reports\/[a-z0-9-]+/i,
    "marketsandmarkets.com": /Market-Reports\/[a-z0-9-]+\.html/i,
    "precedenceresearch.com": /precedenceresearch\.com\/[a-z0-9-]+-market/i,
    "persistencemarketresearch.com": /\/market-research\/[a-z0-9-]+\.asp/i,
  };
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
  // Relaxed match on REAL urls (head noun required); the final x-ray in
  // /api/plan still verifies the fetched page's own title before counting it.
  for (const h of hrefs) {
    const abs = absolutize(h, site);
    if (!abs) continue;
    if (re.test(abs) && keywordMatchesRelaxed(keyword, abs, "")) {
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
