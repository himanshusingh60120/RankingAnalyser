// api/brief.js
// CONTENT BRIEF — keyword in -> Google rankings -> analyst-ready brief, plus saving to Google Drive,
// draft checks and rank tracking. Everything runs in this ONE function because Vercel Hobby allows
// only 12 functions per deployment. Also serves GET /api/health via a rewrite in vercel.json.
//
// GET  /api/brief  -> status: { serpProvider, ai, ourDomain, storage, aiOverview, scraper }
// GET  /api/health -> { ok, service, competitors, time }
// POST /api/brief  { stage: ... }
//   collect { keyword, gl?, hl?, contentType?, ourUrl?, ourDomain?, manual? } -> { collected }
//           manual = [{ url, html? }] — competitor pages added by the analyst (html = pasted page)
//   write   { collected }                       -> { ai, internalLinks }
//   full    collect + write in one call (scripts only — may pass 60s)
//   save    { brief: { collected, ai, internalLinks }, html, country } -> Google Doc + JSON in Drive, row in the Sheet
//   list    { limit? }                          -> saved briefs from the Sheet
//   get     { id }                              -> one saved brief, to reopen in the tool
//   check   { collected, title, meta, html }    -> draft checker results
//   ranks   { secret, keyword, gl, hl? }        -> current Google ranks (called weekly by the Sheet's Apps Script)

import { searchGoogle, serpProviderName } from "../lib/serp.js";
import { collectSerpPages, fetchOurPage, analyseSerp, sameUrl, BRIEF_TRACKED, displayName } from "../lib/brief.js";
import { writeBriefWithAi } from "../lib/brief-ai.js";
import { suggestInternalLinks } from "../lib/internal-links.js";
import { COMPETITOR_SITES } from "../lib/competitors.js";
import { callStorage, storageConfigured } from "../lib/storage.js";
import { findDuplicates, dupesSummary } from "../lib/dupes.js";
import { checkDraft } from "../lib/draft-check.js";

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

export async function GET(request) {
  const u = new URL(request.url);
  if (u.searchParams.has("health") || /\/api\/health\/?$/.test(u.pathname)) {
    return new Response(
      JSON.stringify({ ok: true, service: "seo-xray-api", competitors: COMPETITOR_SITES, time: new Date().toISOString() }, null, 2),
      { headers: { "Content-Type": "application/json" } }
    );
  }
  return json({
    ok: true,
    serpProvider: serpProviderName(),
    ai: !!process.env.OPENAI_API_KEY,
    ourDomain: normaliseDomain(process.env.OUR_DOMAIN || process.env.GSC_SITE_URL || ""),
    storage: storageConfigured(),
    aiOverview: !!process.env.SERPAPI_KEY,
    scraper: !!process.env.SCRAPER_API_URL,
  });
}

export async function POST(request) {
  let body;
  try { body = await request.json(); }
  catch { return json({ error: "Invalid JSON body" }, 400); }
  const stage = String(body.stage || "full");

  switch (stage) {
    case "collect":
    case "full":
      return stageCollect(body, stage);
    case "write":
      return stageWrite(body);
    case "save":
      return stageSave(body, request);
    case "list": {
      const r = await callStorage("list", { limit: Math.min(200, Number(body.limit) || 50) });
      return json(r, r.error ? 502 : 200);
    }
    case "get": {
      if (!body.id) return json({ error: "Missing 'id'." }, 400);
      const r = await callStorage("get", { id: String(body.id) });
      return json(r, r.error ? 404 : 200);
    }
    case "check": {
      const r = checkDraft(body.collected, { html: body.html, title: body.title, meta: body.meta });
      return json(r, r.error ? 400 : 200);
    }
    case "ranks":
      return stageRanks(body);
    default:
      return json({ error: `Unknown stage '${stage}'.` }, 400);
  }
}

/* ---------------- stages ---------------- */

async function stageCollect(body, stage) {
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
  const manual = cleanManual(body.manual);

  let serp;
  try {
    serp = await searchGoogle(keyword, { gl, hl, num: 10, prefer: "serpapi" });
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
  const [pages, ourPage, dupes] = await Promise.all([
    collectSerpPages(serp, { ourDomain, manual }),
    ourUrl && !ourInSerp ? fetchOurPage(ourUrl) : Promise.resolve(null),
    withDeadline(
      findDuplicates({ keyword, gl, hl, ourDomain, ourUrl, serpOrganic: serp.organic })
        .catch((e) => ({ checked: false, reason: String(e.message || e), pages: [], queries: [] })),
      20000,
      { checked: false, reason: "Existing-page check timed out.", pages: [], queries: [] }
    ),
  ]);

  const collected = analyseSerp({ keyword, contentType, serp, pages, ourDomain, ourPage, ourUrl });
  collected.dupes = dupes;
  if (stage === "collect") return json({ stage, collected });

  const [ai, internalLinks] = await Promise.all([safe(() => writeBriefWithAi(collected)), internalLinkBlock(collected)]);
  return json({ stage, collected, ai, internalLinks });
}

async function stageWrite(body) {
  const c = body.collected;
  if (!c || !c.keyword || !c.serp || !c.topics) {
    return json({ error: "Stage 'write' needs the 'collected' object returned by stage 'collect'." }, 400);
  }
  if (JSON.stringify(c).length > 800000) return json({ error: "'collected' payload too large." }, 413);
  const [ai, internalLinks] = await Promise.all([safe(() => writeBriefWithAi(c)), internalLinkBlock(c)]);
  return json({ stage: "write", ai, internalLinks });
}

async function stageSave(body, request) {
  const brief = body.brief || {};
  const c = brief.collected;
  if (!c || !c.keyword) return json({ error: "Nothing to save — generate a brief first." }, 400);
  if (JSON.stringify(brief).length > 3500000) return json({ error: "This brief is too large to save." }, 413);

  let origin = process.env.APP_URL || "";
  if (!origin) { try { origin = new URL(request.url).origin; } catch { origin = ""; } }

  const r = await callStorage("save", {
    brief,
    html: String(body.html || "").slice(0, 900000),
    appUrl: origin,
    meta: {
      keyword: c.keyword,
      gl: c.gl,
      country: String(body.country || c.gl || ""),
      contentType: c.contentType,
      ourUrl: (c.ourPage && c.ourPage.url) || "",
      ourRank: (c.ourRank && c.ourRank.position) || "",
      dupes: dupesSummary(c.dupes),
    },
  }, 55000);
  return json(r, r.error ? 502 : 200);
}

async function stageRanks(body) {
  if (!process.env.STORAGE_SECRET || body.secret !== process.env.STORAGE_SECRET) return json({ error: "Unauthorized" }, 401);
  const keyword = String(body.keyword || "").replace(/\s+/g, " ").trim();
  if (!keyword) return json({ error: "Missing keyword" }, 400);
  const gl = String(body.gl || process.env.SERP_DEFAULT_GL || "us").toLowerCase().slice(0, 2);
  const hl = String(body.hl || process.env.SERP_DEFAULT_HL || "en").toLowerCase().slice(0, 5);
  const ourDomain = normaliseDomain(process.env.OUR_DOMAIN || process.env.GSC_SITE_URL || "");

  try {
    const [p1, p2] = await Promise.all([
      searchGoogle(keyword, { gl, hl, num: 10 }),
      searchGoogle(keyword, { gl, hl, num: 10, page: 2 }).catch(() => ({ organic: [] })),
    ]);
    const all = [...(p1.organic || []), ...(p2.organic || [])];
    const our = ourDomain ? all.find((r) => sameDomain(r.domain, ourDomain)) : null;
    const tracked = {};
    BRIEF_TRACKED.forEach((t) => {
      const hit = all.find((r) => sameDomain(r.domain, t.domain));
      tracked[t.name] = hit ? hit.position : null;
    });
    const top = (p1.organic || [])[0];
    return json({
      ok: true, keyword, gl, checkedAt: new Date().toISOString(),
      ourPosition: our ? our.position : null, ourUrl: our ? our.link : null,
      tracked, top1: top ? `${displayName(top.domain)} — ${top.link}` : "",
    });
  } catch (e) {
    return json({ error: String(e.message || e) }, 502);
  }
}

/* ---------------- helpers ---------------- */

// Competitor pages the analyst added: [{ url, html? }]. Max 8 pages, ~1.5 MB each, ~3.5 MB total.
function cleanManual(list) {
  if (!Array.isArray(list)) return [];
  let total = 0;
  const out = [];
  for (const m of list.slice(0, 8)) {
    const url = String((m && m.url) || "").trim();
    if (!/^https?:\/\//i.test(url)) continue;
    let html = m && typeof m.html === "string" && m.html.length > 300 ? m.html : null;
    if (html && html.length > 1500000) html = html.slice(0, 1500000);
    if (html) {
      total += html.length;
      if (total > 3500000) html = null;
    }
    out.push({ url, html });
  }
  return out;
}

async function internalLinkBlock(c) {
  try {
    const text = [
      c.keyword,
      ...c.topics.topics.slice(0, 30).map((t) => t.label),
      ...(c.serp.peopleAlsoAsk || []).map((p) => p.question),
      ...(c.serp.relatedSearches || []),
    ].join(". ");
    const res = await withDeadline(suggestInternalLinks(c.keyword, text, (c.ourPage && c.ourPage.url) || null, 12), 25000, null);
    if (!res) return { suggestions: [], note: "Sitemap lookup timed out." };
    return { suggestions: (res.suggestions || []).slice(0, 12) };
  } catch (e) {
    return { suggestions: [], error: String(e.message || e) };
  }
}

function withDeadline(promise, ms, fallback) {
  let t;
  return Promise.race([
    Promise.resolve(promise).finally(() => clearTimeout(t)),
    new Promise((resolve) => { t = setTimeout(() => resolve(fallback), ms); }),
  ]);
}

async function safe(fn) {
  try { return await fn(); }
  catch (e) { return { error: String(e.message || e) }; }
}

function sameDomain(d, base) {
  return !!d && !!base && (d === base || d.endsWith("." + base));
}

function normaliseDomain(v) {
  const s = String(v || "").trim().replace(/^sc-domain:/i, "");
  if (!s) return null;
  try { return new URL(/^https?:\/\//i.test(s) ? s : "https://" + s).hostname.replace(/^www\./, "").toLowerCase(); }
  catch { return null; }
}
