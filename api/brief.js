// api/brief.js
// CONTENT BRIEF — keyword in -> live Google page 1 -> analyst-ready brief.
//
// GET  /api/brief  -> { serpProvider, ai, ourDomain }  (UI health check)
// POST /api/brief
// {
//   keyword: "plywood market",        // required
//   gl?: "us", hl?: "en",             // Google country / language (defaults: SERP_DEFAULT_GL / SERP_DEFAULT_HL)
//   contentType?: "report" | "blog",  // auto: market/industry/size/share keywords -> report
//   ourUrl?: "https://...",           // optional existing page -> gap analysis
//   ourDomain?: "kingsresearch.com",  // optional; else OUR_DOMAIN, ourUrl's domain, GSC_SITE_URL
//   stage?: "collect" | "write" | "full",
//   collected?: {...}                 // stage "write" only: the 'collected' object from stage "collect"
// }
// The UI runs "collect" (SERP + X-ray) then "write" (AI) so each half gets its own 60s budget.
// "full" does both in one call — fine for scripts, but slow pages can push it past 60s.

import { searchGoogle, serpProviderName } from "../lib/serp.js";
import { collectSerpPages, fetchOurPage, analyseSerp, sameUrl } from "../lib/brief.js";
import { writeBriefWithAi } from "../lib/brief-ai.js";
import { suggestInternalLinks } from "../lib/internal-links.js";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};
const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", ...CORS } });

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS });
}

export async function GET() {
  return json({
    ok: true,
    serpProvider: serpProviderName(),
    ai: !!process.env.OPENAI_API_KEY,
    ourDomain: normaliseDomain(process.env.OUR_DOMAIN || process.env.GSC_SITE_URL || ""),
  });
}

export async function POST(request) {
  let body;
  try { body = await request.json(); }
  catch { return json({ error: "Invalid JSON body" }, 400); }
  const stage = ["collect", "write", "full"].includes(body.stage) ? body.stage : "full";

  // ---- Stage 2: AI writing on an existing analysis ----
  if (stage === "write") {
    const c = body.collected;
    if (!c || !c.keyword || !c.serp || !c.topics) {
      return json({ error: "Stage 'write' needs the 'collected' object returned by stage 'collect'." }, 400);
    }
    if (JSON.stringify(c).length > 800000) return json({ error: "'collected' payload too large." }, 413);
    const [ai, internalLinks] = await Promise.all([safe(() => writeBriefWithAi(c)), internalLinkBlock(c)]);
    return json({ stage, ai, internalLinks });
  }

  // ---- Stage 1: SERP + X-ray + analysis ----
  const keyword = String(body.keyword || "").replace(/\s+/g, " ").trim();
  if (keyword.length < 2 || keyword.length > 120) return json({ error: "Provide a 'keyword' (2–120 characters)." }, 400);

  const gl = String(body.gl || process.env.SERP_DEFAULT_GL || "us").toLowerCase().slice(0, 2);
  const hl = String(body.hl || process.env.SERP_DEFAULT_HL || "en").toLowerCase().slice(0, 5);
  const contentType =
    body.contentType === "report" || body.contentType === "blog"
      ? body.contentType
      : /\b(market|industry|forecast|size|share)\b/i.test(keyword) ? "report" : "blog";
  const ourUrl = /^https?:\/\//i.test(body.ourUrl || "") ? body.ourUrl.trim() : null;
  const ourDomain = normaliseDomain(body.ourDomain || process.env.OUR_DOMAIN || ourUrl || process.env.GSC_SITE_URL || "");

  let serp;
  try {
    serp = await searchGoogle(keyword, { gl, hl, num: 10 });
  } catch (e) {
    const noProvider = e.code === "NO_SERP_PROVIDER";
    return json(
      { error: noProvider ? "No Google results provider configured." : "Google results lookup failed.", hint: String(e.message || e) },
      noProvider ? 501 : 502
    );
  }
  if (!serp.organic.length) {
    return json({ error: "Google returned no organic results for this keyword.", hint: "Check the spelling or try another country." }, 404);
  }

  const ourInSerp = ourUrl && serp.organic.some((r) => sameUrl(r.link, ourUrl));
  const [pages, ourPage] = await Promise.all([
    collectSerpPages(serp, { ourDomain }),
    ourUrl && !ourInSerp ? fetchOurPage(ourUrl) : Promise.resolve(null),
  ]);

  const collected = analyseSerp({ keyword, contentType, serp, pages, ourDomain, ourPage, ourUrl });
  if (stage === "collect") return json({ stage, collected });

  const [ai, internalLinks] = await Promise.all([safe(() => writeBriefWithAi(collected)), internalLinkBlock(collected)]);
  return json({ stage, collected, ai, internalLinks });
}

// Real pages from our own sitemaps to link to (same helper the Content Planner uses).
async function internalLinkBlock(c) {
  try {
    const text = [
      c.keyword,
      ...c.topics.topics.slice(0, 30).map((t) => t.label),
      ...(c.serp.peopleAlsoAsk || []).map((p) => p.question),
      ...(c.serp.relatedSearches || []),
    ].join(". ");
    const res = await Promise.race([
      suggestInternalLinks(c.keyword, text, c.ourPage?.url || null, 12),
      new Promise((resolve) => setTimeout(() => resolve(null), 25000)),
    ]);
    if (!res) return { suggestions: [], note: "Sitemap lookup timed out." };
    return { suggestions: (res.suggestions || []).slice(0, 12) };
  } catch (e) {
    return { suggestions: [], error: String(e.message || e) };
  }
}

async function safe(fn) {
  try { return await fn(); }
  catch (e) { return { error: String(e.message || e) }; }
}

function normaliseDomain(v) {
  const s = String(v || "").trim().replace(/^sc-domain:/i, "");
  if (!s) return null;
  try { return new URL(/^https?:\/\//i.test(s) ? s : "https://" + s).hostname.replace(/^www\./, "").toLowerCase(); }
  catch { return null; }
}
