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
// Returns full deep X-ray + ranking verdict per fixed competitor + GSC findings.

import { fetchPage } from "../lib/fetcher.js";
import { xray } from "../lib/xray.js";
import { auditPage, scoreOf } from "../lib/audit.js";
import { rankingVerdict } from "../lib/verdict.js";
import { findCompetitorUrls, COMPETITOR_SITES } from "../lib/competitors.js";
import { refreshAccessToken, queryPagePerformance, analyzeGsc } from "../lib/gsc.js";

const UPDATE_NOTE =
  "Google May 2026 core update (Gemini-based quality models): rewards original " +
  "people-first depth, credible authorship/E-E-A-T, topical authority and " +
  "AI-Overview readiness; demotes automated, thin, ad-heavy content.";

export async function POST(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }
  const { url, competitors, gscRefreshToken, gscSiteUrl, gscDays = 90 } = body;
  let keyword = body.keyword;
  if (!url || !/^https?:\/\//i.test(url)) {
    return json({ error: "Provide a valid 'url'." }, 400);
  }

  // --- 1. X-ray target ---
  const tgtFetch = await fetchPage(url);
  const target = xray(url, tgtFetch.status, tgtFetch.html);
  if (!target.fetched) {
    return json(
      {
        error: "Could not fetch target page.",
        status: tgtFetch.status,
        blocked: tgtFetch.blocked,
        hint: tgtFetch.blocked
          ? "Target returned a bot-block status even with browser headers."
          : tgtFetch.error || "Unknown fetch error.",
      },
      502
    );
  }
  if (!keyword) {
    const h1 = target.headingTree.find(([l]) => l === 1);
    keyword = h1 ? h1[1] : target.title.split(/[|\-–]/)[0].trim();
  }
  const targetText = tgtFetch.html.replace(/<[^>]+>/g, " ");
  const targetFindings = auditPage(target, keyword, targetText);
  const targetScore = scoreOf(targetFindings);

  // --- 2. Resolve competitor URLs (fixed sites only) ---
  let compUrls;
  if (Array.isArray(competitors) && competitors.length) {
    // manual override, but still restrict to the fixed competitor domains
    compUrls = competitors
      .filter((u) => COMPETITOR_SITES.some((s) => u.includes(s)))
      .map((u) => ({ site: domainOf(u), url: u, method: "manual" }));
  } else {
    compUrls = await findCompetitorUrls(keyword);
  }

  // --- 3. X-ray each competitor + verdict ---
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
        site: c.site,
        url: c.url,
        found: true,
        fetched: false,
        blocked: cf.blocked,
        method: c.method,
      });
      continue;
    }
    const verdict = rankingVerdict(target, cx);
    competitorsOut.push({
      site: c.site,
      url: c.url,
      found: true,
      fetched: true,
      method: c.method,
      xray: slimXray(cx),
      verdict,
      topReason: verdict.reasons[0]?.factor || null,
    });
  }

  // --- 4. Optional GSC ---
  let gsc = null;
  if (gscRefreshToken && gscSiteUrl) {
    try {
      const { access_token } = await refreshAccessToken(gscRefreshToken);
      const rows = await queryPagePerformance(access_token, gscSiteUrl, url, gscDays);
      gsc = { rows, findings: analyzeGsc(rows) };
    } catch (e) {
      gsc = { error: String(e.message || e) };
    }
  }

  return json({
    generatedAt: new Date().toISOString(),
    updateNote: UPDATE_NOTE,
    keyword,
    target: {
      url,
      score: targetScore,
      findings: targetFindings,
      xray: slimXray(target),
    },
    competitors: competitorsOut,
    gsc,
  });
}

// Trim heavy fields for the response payload but keep the useful detail.
function slimXray(x) {
  return {
    domain: x.domain,
    title: x.title,
    titleLen: x.titleLen,
    metaDescLen: x.metaDescLen,
    canonical: x.canonical,
    contentWords: x.contentWords,
    totalWords: x.totalWords,
    contentRatio: x.contentRatio,
    totalDomNodes: x.totalDomNodes,
    inContentInternal: x.inContentInternal,
    inContentExternal: x.inContentExternal,
    inContentInternalCount: x.inContentInternal.length,
    inContentExternalCount: x.inContentExternal.length,
    chromeLinkCount: x.chromeLinkCount,
    totalLinkCount: x.totalLinkCount,
    headings: x.headingTree.length,
    headingTree: x.headingTree,
    paragraphs: x.paragraphs,
    tables: x.tables,
    lists: x.lists,
    listItems: x.listItems,
    faqCount: x.faqCount,
    schemaBlocks: [...new Set(x.schemaBlocks)],
    hasFaqPage: x.hasFaqPage,
    hasArticle: x.hasArticle,
    hasBreadcrumb: x.hasBreadcrumb,
    hasDataset: x.hasDataset,
    ogCount: x.ogCount,
    twitterCount: x.twitterCount,
    hreflangCount: x.hreflangCount,
    images: x.images,
    imagesNoAlt: x.imagesNoAlt,
    hasAuthor: x.hasAuthor,
    hasReviewer: x.hasReviewer,
    hasDates: x.hasDates,
  };
}

function domainOf(u) {
  try {
    return new URL(u).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// api/health.js  -> GET /api/health
import { COMPETITOR_SITES } from "../lib/competitors.js";
export function GET() {
  return new Response(
    JSON.stringify({
      ok: true,
      service: "seo-xray-api",
      competitors: COMPETITOR_SITES,
      time: new Date().toISOString(),
    }, null, 2),
    { headers: { "Content-Type": "application/json" } }
  );
}
