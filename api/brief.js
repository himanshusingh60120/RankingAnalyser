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
//           collected also carries intentMix, keywordCheck, freshness and figureCheck (lib/brief-checks.js)
//           and competitorGaps — what most competitors miss, which we can add (lib/competitor-gaps.js)
//           OURS — no ourUrl given: the main page the existing-page check finds is compared automatically
//   write   { collected } -> { ai, internalLinks }
//   gap     { keyword, market?, url? | html? | text? } -> { gap }   GAP — reads the research team's gap
//           analysis (Google Doc link or pasted document) and words its H3s; the UI stores it in
//           collected.gap so it is saved and reopened with the brief
//   full    collect + write in one call (scripts only — may pass 60s)
//   save    { brief: { collected, ai, internalLinks }, html, country } -> Google Doc + JSON in Drive, row in the Sheet
//           SHEET — also sends meta.sheet (competitor gaps, page-1 URLs, tracked competitors' ranks + URLs)
//   list    { limit? } -> saved briefs from the Sheet
//   get     { id } -> one saved brief, to reopen in the tool
//   check   { collected, title, meta, html } -> draft checker results
//   ranks   { secret, keyword, gl, hl? } -> current Google ranks (called weekly by the Sheet's Apps Script)
//           SHEET — also returns trackedUrls (each competitor's ranking URL) and page1 (top-10 URLs)
//   summary { secret, collected } -> { sheet }   SHEET — competitor gaps + page 1 for briefs saved before
//           this version (the Sheet's "Fill misses for older briefs" menu)

import { searchGoogle, serpProviderName } from "../lib/serp.js";
import { collectSerpPages, fetchOurPage, analyseSerp, sameUrl, displayName } from "../lib/brief.js";
import { writeBriefWithAi, phraseGapH3s } from "../lib/brief-ai.js";
import { suggestInternalLinks } from "../lib/internal-links.js";
import { COMPETITOR_SITES } from "../lib/competitors.js";
import { callStorage, storageConfigured } from "../lib/storage.js";
import { findDuplicates, dupesSummary } from "../lib/dupes.js";
import { checkDraft } from "../lib/draft-check.js";
import { annotateBrief } from "../lib/brief-checks.js"; // search intent, keyword check, stale-data flags, figure check
import { readGapAnalysis, applyGapPhrasing } from "../lib/gap-analysis.js"; // GAP
import { sheetSummary, page1List, page1Text, trackedFromResults } from "../lib/sheet-summary.js"; // SHEET
import { competitorGaps } from "../lib/competitor-gaps.js"; // EDGE

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
    case "gap":
      return stageGap(body); // GAP
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
    case "summary":
      return stageSummary(body); // SHEET
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
  const dupesJob = withDeadline(
    findDuplicates({ keyword, gl, hl, ourDomain, ourUrl, serpOrganic: serp.organic })
      .catch((e) => ({ checked: false, reason: String(e.message || e), pages: [], queries: [] })),
    20000,
    { checked: false, reason: "Existing-page check timed out.", pages: [], queries: [] }
  );
  // OURS — no URL given: compare with the main page the existing-page check finds (unless it's already on page 1,
  // where it's read with the other results). Runs alongside the page reading, so it adds little time.
  const ourJob = ourUrl
    ? (ourInSerp ? Promise.resolve(null) : fetchOurPage(ourUrl))
    : dupesJob.then((d) => {
        const main = mainPageOf(d);
        if (!main || serp.organic.some((r) => sameUrl(r.link, main))) return null;
        return withDeadline(fetchOurPage(main).catch(() => null), 18000, null)
          .then((p) => (p ? { ...p, auto: true } : { link: main, fetched: false, auto: true }));
      });
  const [pages, ourRaw, dupes] = await Promise.all([collectSerpPages(serp, { ourDomain, manual }), ourJob, dupesJob]);

  const autoOur = !!(ourRaw && ourRaw.auto);
  const ourPage = autoOur && !ourRaw.fetched ? null : ourRaw;
  const collected = analyseSerp({ keyword, contentType, serp, pages, ourDomain, ourPage, ourUrl: ourUrl || (ourPage && ourPage.link) || null });
  collected.dupes = dupes;
  if (autoOur) {
    if (collected.ourPage) collected.ourPage.auto = true;
    else collected.warnings.push(`The existing-page check found your main page (${ourRaw.link}), but we couldn't read it, so it isn't compared. Add its URL under “Your existing page & language” to try again.`);
  }

  // Search intent, keyword-vs-top-10 check, stale-data flags and the competitor figure check.
  // Flags only — every page stays in the comparison. Wrapped so a problem here can never break generation.
  try { annotateBrief(collected, { keyword, serp, pages, ourPage, ourDomain, dupes }); }
  catch (e) { collected.checksError = String(e.message || e); }

  // EDGE — what most competitors miss, checked on the pages we just read (lib/competitor-gaps.js)
  try { collected.competitorGaps = competitorGaps(collected, pages, { ourPage }); }
  catch (e) { collected.competitorGapsError = String(e.message || e); }

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

// GAP — read the gap analysis, then word its H3s (one AI call; templates are used if it fails).
async function stageGap(body) {
  const keyword = String(body.keyword || "").replace(/\s+/g, " ").trim();
  if (keyword.length < 2) return json({ error: "Missing 'keyword'." }, 400);
  const url = /^https?:\/\//i.test(body.url || "") ? String(body.url).trim() : "";
  const html = typeof body.html === "string" ? body.html : "";
  const text = typeof body.text === "string" ? body.text : "";
  if (!url && !html && !text) return json({ error: "Add a Google Doc link or paste the gap analysis." }, 400);

  let gap;
  try {
    gap = await readGapAnalysis({ url, html, text, keyword });
  } catch (e) {
    return json({ error: String(e.message || e), hint: e.hint || "" }, 422);
  }
  const ph = await withDeadline(
    safe(() => phraseGapH3s(gap, { market: String(body.market || "").slice(0, 160) || keyword })),
    40000,
    { error: "H3 wording timed out." }
  );
  applyGapPhrasing(gap, ph);
  return json({ stage: "gap", gap });
}

async function stageSave(body, request) {
  const brief = body.brief || {};
  const c = brief.collected;
  if (!c || !c.keyword) return json({ error: "Nothing to save — generate a brief first." }, 400);
  if (JSON.stringify(brief).length > 3500000) return json({ error: "This brief is too large to save." }, 413);
  let origin = process.env.APP_URL || "";
  if (!origin) { try { origin = new URL(request.url).origin; } catch { origin = ""; } }
  let sheet = null; // SHEET — competitor gaps, page-1 URLs, tracked competitors' ranks + URLs for the tracking sheet
  try { sheet = sheetSummary(c); } catch { sheet = null; }
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
      sheet,
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
    // SHEET — each tracked competitor's position and the URL that ranks (top 20)
    const tr = trackedFromResults(all);
    const tracked = {};
    const trackedUrls = {};
    Object.keys(tr).forEach((n) => { tracked[n] = tr[n].position; trackedUrls[n] = tr[n].url; });
    const top = (p1.organic || [])[0];
    return json({
      ok: true, keyword, gl, checkedAt: new Date().toISOString(),
      ourPosition: our ? our.position : null, ourUrl: our ? our.link : null,
      tracked, trackedUrls,
      top1: top ? `${displayName(top.domain)} — ${top.link}` : "",
      page1: page1Text(page1List(p1.organic || [], ourDomain)), // SHEET — the ten page-1 URLs
    });
  } catch (e) {
    return json({ error: String(e.message || e) }, 502);
  }
}

// SHEET — competitor gaps + page 1 for a brief saved before this version (called by the Sheet's Apps Script).
async function stageSummary(body) {
  if (!process.env.STORAGE_SECRET || body.secret !== process.env.STORAGE_SECRET) return json({ error: "Unauthorized" }, 401);
  const c = body.collected;
  if (!c || !c.keyword) return json({ error: "Missing 'collected'." }, 400);
  if (JSON.stringify(c).length > 3500000) return json({ error: "'collected' payload too large." }, 413);
  try {
    return json({ ok: true, sheet: sheetSummary(c) });
  } catch (e) {
    return json({ error: String(e.message || e) }, 500);
  }
}

/* ---------------- helpers ---------------- */

// OURS — the "Main page" the existing-page check (lib/dupes.js) found for this keyword, if any
function mainPageOf(d) {
  const list = d && d.checked && Array.isArray(d.pages) ? d.pages : [];
  const main = list.find((p) => p && /^main/i.test(String(p.role || "")) && /^https?:\/\//i.test(String(p.url || "")));
  return main ? main.url : null;
}

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
