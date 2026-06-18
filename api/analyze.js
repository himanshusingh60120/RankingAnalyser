// api/analyze.js
// POST /api/analyze
// Body: {
//   url: string,                  // required — your page
//   keyword?: string,             // inferred from H1/title if omitted
//   competitors?: string[],       // manual override (restricted to fixed sites)
//   gscRefreshToken?: string,     // from /api/auth flow
//   gscSiteUrl?: string,          // e.g. "https://www.kingsresearch.com/" or "sc-domain:kingsresearch.com"
//   gscDays?: number,             // default 90
//   ai?: boolean                  // default true — set false to skip the AI step
// }

import { fetchPage } from "../lib/fetcher.js";
import { xray } from "../lib/xray.js";
import { auditPage, scoreOf } from "../lib/audit.js";
import { rankingVerdict } from "../lib/verdict.js";
import { findCompetitorUrls, COMPETITOR_SITES, keywordMatches } from "../lib/competitors.js";
import { refreshAccessToken, queryPagePerformance, queryPageTotals, analyzeGsc } from "../lib/gsc.js";
import { aiRecommendations } from "../lib/ai.js";

const UPDATE_NOTE =
  "Google May 2026 core update (Gemini-based quality models): rewards original " +
  "people-first depth, credible authorship/E-E-A-T, topical authority and " +
  "AI-Overview readiness; demotes automated, thin, ad-heavy content.";

export async function POST(request) {
  let body;
  try { body = await request.json(); }
  catch { return json({ error: "Invalid JSON body" }, 400); }

  const { url, competitors, gscDays = 90 } = body;
  // GSC creds: use request values if provided, else fall back to env vars so
  // the tool pulls GSC automatically on every run without pasting a token.
  const gscRefreshToken = body.gscRefreshToken || process.env.GSC_REFRESH_TOKEN || null;
  const gscSiteUrl = body.gscSiteUrl || process.env.GSC_SITE_URL || null;
  const wantAi = body.ai !== false;
  let keyword = body.keyword;
  // Content type: explicit from request, else auto-detect from the URL path.
  // /blog/, /insights/, /articles/ => blog; everything else => report.
  let contentType = body.contentType === "blog" || body.contentType === "report"
    ? body.contentType
    : (/\/(blog|insights|articles?)\//i.test(url || "") ? "blog" : "report");

  if (!url || !/^https?:\/\//i.test(url)) {
    return json({ error: "Provide a valid 'url'." }, 400);
  }

  // ---- 1. X-ray the target ----
  const tgtFetch = await fetchPage(url);
  const target = xray(url, tgtFetch.status, tgtFetch.html);
  if (!target.fetched) {
    return json({
      error: "Could not fetch target page.",
      status: tgtFetch.status,
      blocked: tgtFetch.blocked,
      hint: tgtFetch.blocked
        ? "Target returned a bot-block status even with browser headers."
        : tgtFetch.error || "Unknown fetch error.",
    }, 502);
  }
  if (!keyword) {
    keyword = (target.h1List && target.h1List[0]) ||
      target.title.split(/[|\-–]/)[0].trim();
  }
  const targetText = tgtFetch.html.replace(/<[^>]+>/g, " ");
  const targetFindings = auditPage(target, keyword, targetText, contentType);
  const targetScore = scoreOf(targetFindings);

  // ---- 2. Resolve competitor URLs (fixed sites only) ----
  let compUrls;
  if (Array.isArray(competitors) && competitors.length) {
    compUrls = competitors
      .filter((u) => COMPETITOR_SITES.some((s) => u.includes(s)))
      .map((u) => ({ site: domainOf(u), url: u, method: "manual" }));
  } else {
    compUrls = await findCompetitorUrls(keyword, contentType);
  }

  // ---- 3. X-ray each competitor, VERIFY keyword match, verdict ----
  const competitorsOut = [];
  for (const c of compUrls) {
    if (!c.url) {
      competitorsOut.push({ site: c.site, url: null, found: false, method: c.method });
      continue;
    }
    const cf = await fetchPage(c.url);
    const cx = xray(c.url, cf.status, cf.html);
    if (!cx.fetched) {
      competitorsOut.push({
        site: c.site, url: c.url, found: true, fetched: false,
        blocked: cf.blocked, method: c.method,
      });
      continue;
    }
    // STRICT post-fetch verification: the fetched page must actually be about
    // the keyword. The page's own <title> is the reliable signal. A slug-probed
    // URL is fabricated from the keyword, so it must NOT self-validate; URLs from
    // real search results (search-api/on-site-search/manual) are valid evidence.
    const titleMatch = keywordMatches(keyword, "", cx.title);
    const urlTrustworthy = c.method !== "slug-probe";
    const matches = titleMatch || (urlTrustworthy && keywordMatches(keyword, c.url, ""));
    if (!matches) {
      competitorsOut.push({
        site: c.site, url: c.url, found: true, fetched: true,
        keywordMatch: false, method: c.method,
        pageTitle: cx.title,
        note: "Found page does not match the keyword — excluded from comparison.",
      });
      continue;
    }
    const verdict = rankingVerdict(target, cx, contentType);
    competitorsOut.push({
      site: c.site, url: c.url, found: true, fetched: true,
      keywordMatch: true, method: c.method,
      xray: slimXray(cx),
      verdict,
      topReason: verdict.reasons[0]?.factor || null,
    });
  }

  // ---- 4. Optional GSC (page totals + per-query quick-wins) ----
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

  // ---- 5. AI synthesis: what to add + content draft ----
  let ai = null;
  if (wantAi) {
    try {
      ai = await aiRecommendations({
        keyword,
        contentType,
        target: { url, findings: targetFindings, xray: slimXray(target) },
        competitors: competitorsOut,
      });
    } catch (e) { ai = { error: String(e.message || e) }; }
  }

  return json({
    generatedAt: new Date().toISOString(),
    updateNote: UPDATE_NOTE,
    keyword,
    contentType,
    target: { url, score: targetScore, findings: targetFindings, xray: slimXray(target) },
    competitors: competitorsOut,
    gsc,
    ai,
  });
}

function slimXray(x) {
  return {
    domain: x.domain, title: x.title, titleLen: x.titleLen, metaDesc: x.metaDesc, metaDescLen: x.metaDescLen,
    canonical: x.canonical,
    h1List: x.h1List || [],
    contentWords: x.contentWords, totalWords: x.totalWords, contentRatio: x.contentRatio,
    totalDomNodes: x.totalDomNodes,
    inContentInternal: x.inContentInternal, inContentExternal: x.inContentExternal,
    inContentInternalCount: x.inContentInternal.length,
    inContentExternalCount: x.inContentExternal.length,
    chromeLinkCount: x.chromeLinkCount, totalLinkCount: x.totalLinkCount,
    headings: x.headingTree.length, headingTree: x.headingTree, paragraphs: x.paragraphs,
    tables: x.tables, lists: x.lists, listItems: x.listItems, faqCount: x.faqCount,
    faqQuestions: x.faqQuestions || [],
    schemaBlocks: [...new Set(x.schemaBlocks)],
    schemaBlocksAll: x.schemaBlocks,
    schemaDetail: x.schemaDetail || [],
    hasFaqPage: x.hasFaqPage, hasArticle: x.hasArticle,
    hasBreadcrumb: x.hasBreadcrumb, hasDataset: x.hasDataset,
    ogCount: x.ogCount, twitterCount: x.twitterCount, hreflangCount: x.hreflangCount,
    images: x.images, imagesNoAlt: x.imagesNoAlt,
    hasAuthor: x.hasAuthor, hasReviewer: x.hasReviewer, hasDates: x.hasDates,
  };
}

function domainOf(u) {
  try { return new URL(u).hostname.replace(/^www\./, ""); }
  catch { return ""; }
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
