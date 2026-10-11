// lib/competitors.js
// Auto-finds the matching report on the FIVE FIXED competitor sites only,
// and checks the live Google SERP so the planner knows which of them ACTUALLY
// rank for the keyword. All Google lookups go through lib/serp.js
// (Serper / SerpApi / legacy CSE). Bing was retired by Microsoft on 11 Aug 2025.

import { fetchPage } from "./fetcher.js";
import { searchGoogle, serpProviderName } from "./serp.js";

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
 * Used for fabricated (slug-probed) URLs and by /api/analyze.
 */
export function keywordMatches(keyword, url = "", title = "") {
  const tokens = keywordTokens(keyword);
  if (!tokens.length) return true;
  const hay = (url + " " + title).toLowerCase();
  return tokens.every((t) => hay.includes(t));
}

/**
 * RELAXED match for REAL urls (search results, on-site search): the head noun
 * (last topic token) must be present; keywords of ≤3 tokens still need every
 * token; longer keywords may miss ONE modifier.
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
 * hold Google top-10 positions for the keyword. Fails soft without a provider.
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
 * Find the best-matching report URL on each fixed competitor site.
 * Per site: 1) live Google site: search via lib/serp.js, 2) slug probe
 * (reports only), 3) the site's own search page. Runs the 5 sites in parallel.
 * Returns [{ site, url, method }] in the fixed site order (url may be null).
 */
export async function findCompetitorUrls(keyword, contentType = "report") {
  const isBlog = contentType === "blog";

  const findForSite = async (site) => {
    let url = null;
    let method = "none";

    url = await viaSearchProvider(keyword, site, isBlog);
    if (url && !keywordMatchesRelaxed(keyword, url, "")) url = null;
    if (url && !(await isLivePage(url))) url = null;
    if (url) method = isBlog ? "search-api(blog)" : "search-api";

    if (!url && !isBlog) {
      url = await viaSlugProbe(keyword, site);
      if (url) method = "slug-probe";
    }

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

/** A candidate must be a live, substantial page that didn't redirect elsewhere. */
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

// Probe predictable report URLs with the keyword slug ("-market" and bare slug).
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
    // Fabricated URL → must self-prove via the page's OWN <title> (strict).
    const title = (html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1] || "").toLowerCase();
    const titleAboutKeyword = !!title && tokens.every((t) => title.includes(t));
    const landedHere = !finalUrl || finalUrl.toLowerCase().includes(slug);
    if (titleAboutKeyword && landedHere) return cand;
  }
  return null;
}

// --- Provider 1: live Google results via lib/serp.js (Serper / SerpApi / legacy CSE) ---
// One SERP-provider credit per tracked site per run.
async function viaSearchProvider(keyword, site, isBlog = false) {
  if (!serpProviderName()) return null;
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

  try {
    const serp = await searchGoogle(`${q} site:${site}`, { num: 10 });
    // Relevance order; these are real pages, so the relaxed matcher applies.
    for (const r of serp.organic || []) {
      if (accept(r.link) && keywordMatchesRelaxed(keyword, r.link, r.title || "")) return r.link;
    }
  } catch {
    /* fall through to slug probe / on-site search */
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
  for (const h of hrefs) {
    const abs = absolutize(h, site);
    if (!abs) continue;
    if (re.test(abs) && keywordMatchesRelaxed(keyword, abs, "")) return abs;
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
