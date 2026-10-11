// lib/dupes.js
// Existing-page check: finds Kings Research pages that already target the SAME market as the keyword,
// so analysts update or link instead of publishing a page that competes with our own.
// Pages about a different market (even if they share a word) are listed as "Related" — link from them.
// Works before a page is live. Sources:
//   1. Google — our pages in today's top 10, plus "keyword site:ourdomain"
//   2. Search Console (optional) — our pages + searches with impressions for this topic, and each page's
//      average position for searches containing the keyword (uses GSC_REFRESH_TOKEN + GSC_SITE_URL)

import { searchGoogle, serpProviderName } from "./serp.js";
import { refreshAccessToken } from "./gsc.js";

const GENERIC = new Set(["market", "markets", "report", "reports", "size", "share", "growth", "industry",
  "analysis", "global", "forecast", "trends", "outlook"]);
const STOPW = new Set(["the", "of", "and", "in", "for", "to", "by", "a", "an", "on", "with", "at", "vs"]);
const QUERY_HINT_RE = /\b(markets?|industry|size|share|growth|companies|players|manufacturers|trends?|forecast|reports?|cagr|revenue|analysis|outlook|demand|value)\b/;
const TRANSLATION_RE = /^\/(ja|ko|zh|zh-cn|zh-tw|de|fr|es|it|pt|pt-br|ru|ar|tr|nl|pl|vi|th|id|ms|he|sv|da|fi|no|cs|hu|ro|uk)(\/|$)/i;

const stem = (w) => (w.length > 4 && w.endsWith("ies") ? w.slice(0, -3) + "y" : w.length > 3 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w);
const words = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(Boolean);
const coreTokens = (kw) => words(kw).filter((w) => w.length > 2 && !GENERIC.has(w) && !STOPW.has(w)).map(stem);
const sameDomain = (d, base) => !!d && !!base && (d === base || d.endsWith("." + base));
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export async function findDuplicates({ keyword, gl = "us", hl = "en", ourDomain, ourUrl = null, serpOrganic = [] }) {
  if (!ourDomain) return { checked: false, reason: "Set OUR_DOMAIN to enable the existing-page check.", pages: [], queries: [] };
  const core = coreTokens(keyword);
  const map = new Map();
  const add = (url, patch, force = false) => {
    if (!url || (!force && isTranslation(url))) return;
    const k = normUrl(url);
    const cur = map.get(k) || { url, title: "", type: pageType(url), googleRank: null, kwRank: null, kwImpr: null, inSiteSearch: false, gsc: null, isYourPage: false };
    map.set(k, Object.assign(cur, patch));
  };

  serpOrganic.filter((r) => sameDomain(r.domain, ourDomain)).forEach((r) => add(r.link, { title: r.title, googleRank: r.position }));
  if (ourUrl) add(ourUrl, { isYourPage: true }, true);

  const [site, gsc] = await Promise.all([siteSearch(keyword, core, gl, hl, ourDomain), gscData(keyword, core, ourDomain)]);
  site.forEach((r) => add(r.link, { title: r.title || "", inSiteSearch: true }));
  if (gsc && gsc.pages) {
    gsc.pages.forEach((g) => add(g.url, { gsc: { impressions: g.impressions, clicks: g.clicks, position: g.position, topQuery: g.topQuery } }));
  }
  if (gsc && gsc.exact) {
    gsc.exact.forEach((e) => {
      const p = map.get(normUrl(e.url));
      if (p) { p.kwRank = e.position; p.kwImpr = e.impressions; }
      else add(e.url, { kwRank: e.position, kwImpr: e.impressions });
    });
  }

  const pages = [...map.values()].map((p) => ({ ...p, sameMarket: p.isYourPage || isSameMarketPage(keyword, core, p.url, p.title) }));
  return {
    checked: true,
    core: core.join(" "),
    sources: {
      google: !!serpProviderName(),
      searchConsole: gsc && !gsc.error ? true : gsc && gsc.error ? gsc.error : "not configured",
    },
    queries: (gsc && gsc.queries) || [],
    ...recommend(pages, ourUrl),
  };
}

export function dupesSummary(d) {
  if (!d || !d.checked) return "";
  const same = (d.pages || []).filter((p) => p.sameMarket);
  if (!same.length) return "None";
  return same.slice(0, 5).map((p) => `${p.role}: ${p.url}`).join("\n");
}

function recommend(pages, ourUrl) {
  const score = (p) =>
    (p.isYourPage ? 1000 : 0) + (p.type === "report" ? 50 : 0) + (p.googleRank ? 40 - p.googleRank : 0) +
    (p.kwRank ? Math.max(0, 30 - p.kwRank / 3) : 0) + (p.gsc ? Math.min(30, Math.log10(1 + p.gsc.impressions) * 8) : 0) +
    (p.inSiteSearch ? 5 : 0);
  const same = pages.filter((p) => p.sameMarket).sort((a, b) => score(b) - score(a)).slice(0, 6);
  const related = pages.filter((p) => !p.sameMarket)
    .sort((a, b) => ((b.gsc && b.gsc.impressions) || 0) - ((a.gsc && a.gsc.impressions) || 0)).slice(0, 5);

  same.forEach((p, i) => {
    if (i === 0) {
      p.role = "Main page";
      p.action = p.isYourPage ? "The page you're updating — the one page for this keyword." : "Your main page for this keyword.";
      return;
    }
    p.role = "Competes";
    p.action =
      p.type === "report" ? "Same market as the main page? Merge it in and 301-redirect it. Different scope? Retitle it for its own keyword and link to the main page."
      : p.type === "blog" ? "Keep it, but aim it at a question (not the market keyword) and link to the main page with the keyword as anchor text."
      : p.type === "press release" ? "Keep it, but don't lead its title with the exact keyword; link to the main page."
      : "Link it to the main page and avoid repeating the main page's title.";
  });
  related.forEach((p) => {
    p.role = "Related";
    p.action = "Different market — add a link to the new page from here where it fits.";
  });

  let verdict, message;
  if (!same.length) {
    verdict = related.length ? "related" : "clear";
    message = related.length
      ? "No Kings Research page targets this exact market yet. The related pages below already show up for similar searches — link to the new page from them."
      : "No Kings Research page targets this keyword yet — safe to create a new page.";
  } else if (ourUrl) {
    verdict = same.length > 1 ? "conflict" : "ok";
    message = same.length > 1
      ? `${same.length - 1} other Kings Research page(s) target the same keyword. Follow the actions below so they support your page.`
      : "Only the page you're updating targets this keyword.";
  } else if (same[0].type === "report") {
    verdict = "exists";
    message = `You already have a report on this market: ${same[0].url}`;
  } else {
    verdict = "related";
    message = "No report page on this market yet, but these pages target the same keyword — link to the new report from them.";
  }
  return { verdict, message, pages: [...same, ...related] };
}

async function siteSearch(keyword, core, gl, hl, ourDomain) {
  if (!serpProviderName()) return [];
  try {
    const s = await searchGoogle(`${keyword} site:${ourDomain}`, { gl, hl, num: 10 });
    return (s.organic || []).filter((r) => {
      if (!sameDomain(r.domain, ourDomain)) return false;
      const have = new Set(words(`${r.link} ${r.title}`).map(stem));
      return core.every((t) => have.has(t));
    });
  } catch {
    return [];
  }
}

async function gscData(keyword, core, ourDomain) {
  const token = process.env.GSC_REFRESH_TOKEN;
  const site = process.env.GSC_SITE_URL;
  if (!token || !site || !core.length) return null;
  try {
    const { access_token } = await refreshAccessToken(token);
    const end = new Date(Date.now() - 2 * 864e5);
    const start = new Date(end.getTime() - 90 * 864e5);
    const iso = (d) => d.toISOString().slice(0, 10);
    const call = (body) =>
      fetch(`https://searchconsole.googleapis.com/webmasters/v3/sites/${encodeURIComponent(site)}/searchAnalytics/query`, {
        method: "POST",
        headers: { Authorization: `Bearer ${access_token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ startDate: iso(start), endDate: iso(end), ...body }),
      }).then(async (r) => (r.ok ? r.json() : { error: `Search Console HTTP ${r.status}` }));

    const longest = core.slice().sort((a, b) => b.length - a.length)[0];
    // Plural-tolerant regex for the whole keyword: "pharmaceutical\w*\s+market\w*"
    const phraseRe = words(keyword).map((w) => escapeRe(stem(w)) + "\\w*").join("\\s+");
    const [broad, exact] = await Promise.all([
      call({ dimensions: ["page", "query"], rowLimit: 1000,
        dimensionFilterGroups: [{ filters: [{ dimension: "query", operator: "contains", expression: longest }] }] }),
      call({ dimensions: ["page"], rowLimit: 50,
        dimensionFilterGroups: [{ filters: [{ dimension: "query", operator: "includingRegex", expression: phraseRe }] }] }),
    ]);
    if (broad.error) return { error: broad.error };

    const pageAgg = new Map();
    const qAgg = new Map();
    for (const row of broad.rows || []) {
      const [page, query] = row.keys || [];
      if (!page || !query) continue;
      const imp = row.impressions || 0;
      if (sameDomain(domainOf(page), ourDomain) && !isTranslation(page)) {
        const a = pageAgg.get(page) || { page, impressions: 0, clicks: 0, pw: 0, topQuery: null, topImpr: 0 };
        a.impressions += imp;
        a.clicks += row.clicks || 0;
        a.pw += (row.position || 0) * imp;
        if (imp > a.topImpr) { a.topImpr = imp; a.topQuery = query; }
        pageAgg.set(page, a);
      }
      const q = qAgg.get(query) || { query, impressions: 0, clicks: 0, pw: 0 };
      q.impressions += imp;
      q.clicks += row.clicks || 0;
      q.pw += (row.position || 0) * imp;
      qAgg.set(query, q);
    }

    const pages = [...pageAgg.values()]
      .filter((a) => a.impressions >= 5)
      .map((a) => ({ url: a.page, impressions: a.impressions, clicks: a.clicks, position: +(a.pw / a.impressions).toFixed(1), topQuery: a.topQuery }))
      .sort((x, y) => y.impressions - x.impressions)
      .slice(0, 15);

    // Searches your site already appears for that are about THIS market (good secondary keywords).
    const queries = [...qAgg.values()]
      .filter((q) => {
        const toks = words(q.query).map(stem);
        return core.every((t) => toks.includes(t)) && toks.length <= 8 && QUERY_HINT_RE.test(q.query) && q.impressions >= 3;
      })
      .map((q) => ({ query: q.query, impressions: q.impressions, clicks: q.clicks, position: +(q.pw / q.impressions).toFixed(1) }))
      .sort((x, y) => y.impressions - x.impressions)
      .slice(0, 15);

    const exactRows = (exact.rows || [])
      .filter((r) => r.keys && r.keys[0] && !isTranslation(r.keys[0]))
      .map((r) => ({ url: r.keys[0], impressions: r.impressions || 0, position: +(r.position || 0).toFixed(1) }));

    return { pages, queries, exact: exactRows };
  } catch (e) {
    return { error: String(e.message || e) };
  }
}

// Same market = the words before "market" in the URL slug or title match the keyword exactly
// (no extra topic words, nothing missing). "generic-drugs-market" ≠ "pharmaceutical market".
function isSameMarketPage(keyword, core, url, title) {
  const kw = new Set(words(keyword).map(stem));
  const slugText = lastSegment(url).replace(/\.html?$/i, "").replace(/-\d+$/, "").replace(/[-_]/g, " ");
  for (const text of [slugText, title].filter(Boolean)) {
    const mw = marketWords(text);
    if (mw.length && mw.every((w) => kw.has(w)) && core.every((t) => mw.includes(t))) return true;
  }
  return false;
}

function marketWords(text) {
  const t = words(text);
  const i = t.findIndex((w) => w === "market" || w === "markets");
  const head = i >= 0 ? t.slice(0, i) : t;
  return head.filter((w) => w.length > 2 && !GENERIC.has(w) && !STOPW.has(w) && !/^\d+$/.test(w)).map(stem);
}

function isTranslation(url) {
  try { return TRANSLATION_RE.test(new URL(url).pathname); }
  catch { return false; }
}

function lastSegment(url) {
  try { return new URL(url).pathname.split("/").filter(Boolean).pop() || ""; }
  catch { return ""; }
}

function pageType(url) {
  const u = String(url || "").toLowerCase();
  if (/\/(blog|blogs|insights?|articles?)\//.test(u)) return "blog";
  if (/press[-_]?releases?/.test(u)) return "press release";
  if (/\/(report|reports|market-research|industry-reports?)\//.test(u) || /-market(-\d+)?\/?$/.test(u)) return "report";
  return "other";
}

function normUrl(u) {
  try {
    const x = new URL(u);
    return (x.hostname.replace(/^www\./, "") + x.pathname.replace(/\/+$/, "")).toLowerCase();
  } catch {
    return String(u || "").toLowerCase();
  }
}

function domainOf(u) {
  try { return new URL(u).hostname.replace(/^www\./, "").toLowerCase(); }
  catch { return ""; }
}
