// api/analyze.js
// POST /api/analyze
// Body: {
//   url: string,                     // required - your page
//   keyword?: string,               // primary keyword (inferred if omitted)
//   competitors?: string[],         // optional manual override URLs
//   gscRefreshToken?: string,       // optional - from OAuth flow
//   gscSiteUrl?: string,            // e.g. "https://www.kingsresearch.com/"
//   gscDays?: number                // default 90
// }

import { fetchPage } from "../lib/fetcher.js";
import { xray } from "../lib/xray.js";
import { auditPage, scoreOf } from "../lib/audit.js";
import { rankingVerdict } from "../lib/verdict.js";
import { findCompetitorUrls, COMPETITOR_SITES } from "../lib/competitors.js";
import { refreshAccessToken, queryPagePerformance, queryPageTotals, analyzeGsc } from "../lib/gsc.js";

const UPDATE_NOTE =
  "Google May 2026 core update (Gemini-based quality models): rewards original " +
  "people-first depth, credible authorship/E-E-A-T, topical authority and " +
  "AI-Overview readiness; demotes automated, thin, ad-heavy content.";

const TARGET_FETCH = { timeoutMs: 12000, retries: 1 };
const COMP_FETCH = { timeoutMs: 10000, retries: 0 };

export async function POST(request) {
  // Outer guard: ALWAYS return JSON, never a platform error page.
  try {
    return await handle(request);
  } catch (err) {
    return json(
      { error: "Analyzer crashed while processing the request.", detail: String(err && err.message ? err.message : err) },
      500
    );
  }
}

async function handle(request) {
  let body;
  try { body = await request.json(); }
  catch { return json({ error: "Invalid JSON body" }, 400); }

  const { url, competitors, gscRefreshToken, gscSiteUrl, gscDays = 90 } = body || {};
  let keyword = body && body.keyword;
  if (!url || !/^https?:\/\//i.test(url)) {
    return json({ error: "Provide a valid 'url' (must start with http/https)." }, 400);
  }

  // 1. X-ray target
  const tgtFetch = await safeFetch(url, TARGET_FETCH);
  const target = xray(url, tgtFetch.status, tgtFetch.html);
  if (!target.fetched) {
    return json({
      error: "Could not fetch your target page.",
      status: tgtFetch.status,
      blocked: tgtFetch.blocked,
      hint: tgtFetch.blocked
        ? "The target returned a bot-block (HTTP 403/429/503) even with browser headers. kingsresearch.com is blocking Vercel's server IP. Add a rendering proxy (SCRAPER_API_URL) to clear it."
        : (tgtFetch.error || "Unknown fetch error (timeout or DNS)."),
    }, 200);
  }
  if (!keyword) {
    const h1 = target.headingTree.find(([l]) => l === 1);
    keyword = h1 ? h1[1] : (target.title.split(/[|\-\u2013]/)[0] || "").trim();
  }
  const targetText = tgtFetch.html.replace(/<[^>]+>/g, " ");
  const targetFindings = auditPage(target, keyword, targetText);
  const targetScore = scoreOf(targetFindings);

  // 2. Resolve competitor URLs (fixed sites only)
  let compUrls;
  if (Array.isArray(competitors) && competitors.length) {
    compUrls = competitors
      .filter((u) => COMPETITOR_SITES.some((s) => u.includes(s)))
      .map((u) => ({ site: domainOf(u), url: u, method: "manual" }));
  } else {
    try { compUrls = await findCompetitorUrls(keyword); }
    catch { compUrls = COMPETITOR_SITES.map((s) => ({ site: s, url: null, method: "find-failed" })); }
  }

  // 3. X-ray each competitor IN PARALLEL, each guarded
  const competitorsOut = await Promise.all(compUrls.map((c) => analyzeCompetitor(c, target)));

  // 4. Optional GSC
  let gsc = null;
  if (gscRefreshToken && gscSiteUrl) {
    try {
      const { access_token } = await refreshAccessToken(gscRefreshToken);
      const [totals, rows] = await Promise.all([
        queryPageTotals(access_token, gscSiteUrl, url, gscDays),
        queryPagePerformance(access_token, gscSiteUrl, url, gscDays),
      ]);
      gsc = { days: gscDays, totals, rows, findings: analyzeGsc(rows) };
    } catch (e) { gsc = { error: String(e.message || e) }; }
  }

  return json({
    generatedAt: new Date().toISOString(),
    updateNote: UPDATE_NOTE,
    keyword,
    target: { url, score: targetScore, findings: targetFindings, xray: slimXray(target) },
    competitors: competitorsOut,
    gsc,
  });
}

async function analyzeCompetitor(c, target) {
  try {
    if (!c.url) return { site: c.site, url: null, found: false, method: c.method };
    const cf = await safeFetch(c.url, COMP_FETCH);
    const cx = xray(c.url, cf.status, cf.html);
    if (!cx.fetched) {
      return { site: c.site, url: c.url, found: true, fetched: false, blocked: cf.blocked, method: c.method };
    }
    const verdict = rankingVerdict(target, cx);
    return {
      site: c.site, url: c.url, found: true, fetched: true, method: c.method,
      xray: slimXray(cx), verdict, topReason: verdict.reasons[0]?.factor || null,
    };
  } catch (e) {
    return { site: c.site, url: c.url || null, found: !!c.url, fetched: false, error: String(e.message || e) };
  }
}

async function safeFetch(url, opts) {
  try { return await fetchPage(url, opts); }
  catch (e) { return { status: 0, html: "", finalUrl: url, blocked: false, error: String(e.message || e) }; }
}

function slimXray(x) {
  return {
    domain: x.domain, title: x.title, titleLen: x.titleLen, metaDescLen: x.metaDescLen, canonical: x.canonical,
    contentWords: x.contentWords, totalWords: x.totalWords, contentRatio: x.contentRatio, totalDomNodes: x.totalDomNodes,
    inContentInternal: x.inContentInternal, inContentExternal: x.inContentExternal,
    inContentInternalCount: x.inContentInternal.length, inContentExternalCount: x.inContentExternal.length,
    chromeLinkCount: x.chromeLinkCount, totalLinkCount: x.totalLinkCount,
    headings: x.headingTree.length, headingTree: x.headingTree, paragraphs: x.paragraphs,
    tables: x.tables, lists: x.lists, listItems: x.listItems, faqCount: x.faqCount,
    schemaBlocks: [...new Set(x.schemaBlocks)], hasFaqPage: x.hasFaqPage, hasArticle: x.hasArticle,
    hasBreadcrumb: x.hasBreadcrumb, hasDataset: x.hasDataset, ogCount: x.ogCount, twitterCount: x.twitterCount,
    hreflangCount: x.hreflangCount, images: x.images, imagesNoAlt: x.imagesNoAlt,
    hasAuthor: x.hasAuthor, hasReviewer: x.hasReviewer, hasDates: x.hasDates,
  };
}

function domainOf(u) { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return ""; } }

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj, null, 2), { status, headers: { "Content-Type": "application/json" } });
}
