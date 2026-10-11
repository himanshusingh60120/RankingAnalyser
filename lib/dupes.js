// lib/dupes.js
// Duplicate-page check: finds Kings Research pages that already target the keyword, so analysts
// update or link an existing page instead of publishing one that competes with our own.
// Works before a page is live. Sources:
//   1. Google — "keyword site:ourdomain" (plus our pages already in the top 10)
//   2. Search Console (optional) — our pages getting impressions for searches containing the keyword
//      (uses GSC_REFRESH_TOKEN + GSC_SITE_URL, same as the rest of the tool)

import { searchGoogle, serpProviderName } from "./serp.js";
import { refreshAccessToken } from "./gsc.js";
import { keywordMatches } from "./competitors.js";

const GENERIC = new Set(["market", "markets", "report", "reports", "size", "share", "growth", "industry",
  "analysis", "global", "forecast", "trends", "outlook"]);
const sameDomain = (d, base) => !!d && !!base && (d === base || d.endsWith("." + base));

export async function findDuplicates({ keyword, gl = "us", hl = "en", ourDomain, ourUrl = null, serpOrganic = [] }) {
  if (!ourDomain) return { checked: false, reason: "Set OUR_DOMAIN to enable the duplicate-page check.", pages: [] };
  const core = coreTerm(keyword);
  const map = new Map();
  const add = (url, patch) => {
    if (!url) return;
    const k = normUrl(url);
    const cur = map.get(k) || { url, title: "", type: pageType(url), googleRank: null, inSiteSearch: false, gsc: null, isYourPage: false };
    map.set(k, Object.assign(cur, patch));
  };

  serpOrganic.filter((r) => sameDomain(r.domain, ourDomain)).forEach((r) => add(r.link, { title: r.title, googleRank: r.position }));
  if (ourUrl) add(ourUrl, { isYourPage: true });

  const [site, gsc] = await Promise.all([siteSearch(keyword, gl, hl, ourDomain), gscPages(core, ourDomain)]);
  site.forEach((r) => add(r.link, { title: r.title || "", inSiteSearch: true }));
  if (Array.isArray(gsc)) {
    gsc.forEach((g) => add(g.url, { gsc: { impressions: g.impressions, clicks: g.clicks, position: g.position, topQuery: g.topQuery } }));
  }

  return {
    checked: true,
    core,
    sources: {
      google: !!serpProviderName(),
      searchConsole: Array.isArray(gsc) ? true : gsc && gsc.error ? gsc.error : "not configured",
    },
    ...recommend([...map.values()], ourUrl),
  };
}

export function dupesSummary(d) {
  if (!d || !d.checked) return "";
  if (!d.pages.length) return "None";
  return d.pages.slice(0, 5).map((p) => `${p.role}: ${p.url}`).join("\n");
}

function recommend(pages, ourUrl) {
  if (!pages.length) {
    return { verdict: "clear", message: "No existing Kings Research page targets this keyword — safe to create a new page.", pages: [] };
  }
  const score = (p) =>
    (p.isYourPage ? 1000 : 0) + (p.type === "report" ? 50 : 0) + (p.googleRank ? 40 - p.googleRank : 0) +
    (p.gsc ? Math.min(30, Math.log10(1 + p.gsc.impressions) * 8) : 0) + (p.inSiteSearch ? 5 : 0);
  const sorted = pages.sort((a, b) => score(b) - score(a)).slice(0, 8);
  const main = sorted[0];

  sorted.forEach((p, i) => {
    if (i === 0) {
      p.role = "Main page";
      p.action = p.isYourPage
        ? "This is the page you're updating — keep it as the one page for this keyword."
        : p.type === "report"
          ? "Keep this as the one page for this keyword and update it with this brief."
          : "Currently your strongest page for this keyword.";
      return;
    }
    p.role = "Competes";
    p.action =
      p.type === "report" ? "Same topic as the main page? Merge it in and 301-redirect it. Different scope? Retitle it for its own keyword and link to the main page."
      : p.type === "blog" ? "Keep it, but aim it at a question (not the market keyword) and link to the main page with the keyword as anchor text."
      : p.type === "press release" ? "Keep it, but don't lead its title with the exact keyword; link to the main page."
      : "Link it to the main page and avoid repeating the main page's title.";
  });

  let verdict, message;
  if (ourUrl) {
    verdict = sorted.length > 1 ? "conflict" : "ok";
    message = sorted.length > 1
      ? `${sorted.length - 1} other Kings Research page(s) also show up for this keyword. Follow the actions below so they support your page instead of competing with it.`
      : "Only the page you're updating targets this keyword — good.";
  } else if (main.type === "report") {
    verdict = "exists";
    message = `You already have a report for this keyword (${main.url}). Update it with this brief instead of publishing a new page.`;
  } else {
    verdict = "related";
    message = "No report page exists yet, but these Kings Research pages already show up for the keyword. Create the report, then link to it from them.";
  }
  return { verdict, message, pages: sorted };
}

async function siteSearch(keyword, gl, hl, ourDomain) {
  if (!serpProviderName()) return [];
  try {
    const s = await searchGoogle(`${keyword} site:${ourDomain}`, { gl, hl, num: 10 });
    return (s.organic || []).filter((r) => sameDomain(r.domain, ourDomain) && keywordMatches(keyword, r.link, r.title));
  } catch {
    return [];
  }
}

async function gscPages(core, ourDomain) {
  const token = process.env.GSC_REFRESH_TOKEN;
  const site = process.env.GSC_SITE_URL;
  if (!token || !site || !core) return null;
  try {
    const { access_token } = await refreshAccessToken(token);
    const end = new Date(Date.now() - 2 * 864e5);
    const start = new Date(end.getTime() - 90 * 864e5);
    const iso = (d) => d.toISOString().slice(0, 10);
    const r = await fetch(`https://searchconsole.googleapis.com/webmasters/v3/sites/${encodeURIComponent(site)}/searchAnalytics/query`, {
      method: "POST",
      headers: { Authorization: `Bearer ${access_token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        startDate: iso(start),
        endDate: iso(end),
        dimensions: ["page", "query"],
        rowLimit: 500,
        dimensionFilterGroups: [{ filters: [{ dimension: "query", operator: "contains", expression: core }] }],
      }),
    });
    if (!r.ok) return { error: `Search Console HTTP ${r.status}` };
    const d = await r.json();
    const agg = new Map();
    for (const row of d.rows || []) {
      const [page, query] = row.keys || [];
      if (!page) continue;
      const a = agg.get(page) || { page, impressions: 0, clicks: 0, posWeighted: 0, topQuery: null, topImpr: 0 };
      a.impressions += row.impressions || 0;
      a.clicks += row.clicks || 0;
      a.posWeighted += (row.position || 0) * (row.impressions || 0);
      if ((row.impressions || 0) > a.topImpr) { a.topImpr = row.impressions; a.topQuery = query; }
      agg.set(page, a);
    }
    return [...agg.values()]
      .filter((a) => a.impressions >= 5 && sameDomain(domainOf(a.page), ourDomain))
      .map((a) => ({
        url: a.page, impressions: a.impressions, clicks: a.clicks,
        position: a.impressions ? +(a.posWeighted / a.impressions).toFixed(1) : null, topQuery: a.topQuery,
      }))
      .sort((x, y) => y.impressions - x.impressions)
      .slice(0, 10);
  } catch (e) {
    return { error: String(e.message || e) };
  }
}

function coreTerm(keyword) {
  return String(keyword || "").toLowerCase().replace(/[^a-z0-9\s-]/g, " ").split(/\s+/)
    .filter((w) => w && !GENERIC.has(w)).join(" ").trim();
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
