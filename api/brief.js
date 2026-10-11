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
    storage
