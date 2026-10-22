// lib/brief.js
// CONTENT BRIEF engine (v6) — built for research analysts, not SEO specialists.
//   1. Google top 10 for the keyword in the chosen country, plus ranks 11–20
//   2. ALWAYS analyses the tracked competitors (MarketsandMarkets, MRFR, Precedence Research,
//      Future Market Insights, Fortune Business Insights, Grand View Research, Statista) — even when
//      they're not on page 1
//   3. Reads every page; blocked sites go through fallback routes incl. ChatGPT web search (lib/fetcher.js)
//   4. Analysts can add competitor pages themselves (URL, or URL + pasted page for blocked sites)
//   5. Category pages (lists of reports) are left out of comparisons but their keywords are shown
//   6. Secondary keywords: competitors' titles/headings + Google autocomplete, with off-topic
//      phrases removed (other countries, other markets)
//   7. Plural-tolerant keyword matching ("pharmaceuticals market" = "Pharmaceutical Market")
//   8. FIG — market values are read with their years, so base → forecast is the right pair
// Deterministic: the brief still works when the AI step is off.

import * as cheerio from "cheerio";
import { fetchPage } from "./fetcher.js";
import { xray } from "./xray.js";
import { COMPETITOR_SITES, keywordTokens } from "./competitors.js";
import { searchGoogle } from "./serp.js";
import { POLICY_BASELINE } from "./google-policy.js";

/* ===================== 1. Competitors & site types ===================== */

export const BRIEF_TRACKED = [
  { domain: "marketsandmarkets.com", name: "MarketsandMarkets", short: "M&M" },
  { domain: "marketresearchfuture.com", name: "MRFR", short: "MRFR" },
  { domain: "precedenceresearch.com", name: "Precedence Research", short: "Precedence" },
  { domain: "futuremarketinsights.com", name: "Future Market Insights", short: "FMI" },
  { domain: "fortunebusinessinsights.com", name: "Fortune Business Insights", short: "Fortune BI" },
  { domain: "grandviewresearch.com", name: "Grand View Research", short: "Grand View" },
  { domain: "statista.com", name: "Statista", short: "Statista" },
];

const REPORT_URL = {
  "marketsandmarkets.com": /\/market-reports\/[a-z0-9-]+\.html/i,
  "marketresearchfuture.com": /\/reports\/[a-z0-9-]+/i,
  "futuremarketinsights.com": /\/reports\/[a-z0-9-]+/i,
  "precedenceresearch.com": /precedenceresearch\.com\/[a-z0-9-]+-market(?:-\d+)?\/?$/i,
  "fortunebusinessinsights.com": /-\d{5,7}\/?$/i,
  "grandviewresearch.com": /\/industry-analysis\/[a-z0-9-]+/i,
  "statista.com": /statista\.com\/outlook\//i, // Market Insights pages
};
// Sites where ONLY report-type URLs count. Statista's single-chart and topic pages are too thin to compare.
const STRICT_REPORT_URL = new Set(["statista.com"]);

const KNOWN_NAMES = {
  "persistencemarketresearch.com": "Persistence MR",
  "grandviewresearch.com": "Grand View Research",
  "mordorintelligence.com": "Mordor Intelligence",
  "imarcgroup.com": "IMARC",
  "alliedmarketresearch.com": "Allied MR",
  "researchandmarkets.com": "Research and Markets",
  "gminsights.com": "GMI",
  "straitsresearch.com": "Straits Research",
  "verifiedmarketresearch.com": "Verified MR",
  "coherentmarketinsights.com": "Coherent MI",
  "transparencymarketresearch.com": "Transparency MR",
  "theinsightpartners.com": "The Insight Partners",
  "insightaceanalytic.com": "InsightAce Analytic",
  "towardshealthcare.com": "Towards Healthcare",
  "datamintelligence.com": "DataM Intelligence",
  "statista.com": "Statista",
  "ibisworld.com": "IBISWorld",
  "kingsresearch.com": "Kings Research",
};

const PUBLISHERS = [
  "kingsresearch.com", "grandviewresearch.com", "mordorintelligence.com", "imarcgroup.com",
  "alliedmarketresearch.com", "researchandmarkets.com", "marketresearch.com", "gminsights.com",
  "straitsresearch.com", "verifiedmarketresearch.com", "verifiedmarketreports.com",
  "databridgemarketresearch.com", "coherentmarketinsights.com", "transparencymarketresearch.com",
  "factmr.com", "technavio.com", "expertmarketresearch.com", "businessresearchinsights.com",
  "thebusinessresearchcompany.com", "snsinsider.com", "skyquestt.com", "zionmarketresearch.com",
  "emergenresearch.com", "polarismarketresearch.com", "reportsanddata.com", "kbvresearch.com",
  "marketdataforecast.com", "credenceresearch.com", "maximizemarketresearch.com",
  "cognitivemarketresearch.com", "sphericalinsights.com", "towardshealthcare.com", "novaoneadvisor.com",
  "custommarketinsights.com", "marketresearchintellect.com", "globalgrowthinsights.com",
  "theinsightpartners.com", "insightaceanalytic.com", "datamintelligence.com",
  "statista.com", "ibisworld.com", "mintel.com", "euromonitor.com", "frost.com", "idc.com", "gartner.com",
];
const PRESS = ["globenewswire.com", "prnewswire.com", "businesswire.com", "einpresswire.com", "openpr.com",
  "newswire.com", "accesswire.com", "prweb.com", "issuewire.com", "whatech.com"];
const NEWS = ["reuters.com", "bloomberg.com", "forbes.com", "cnbc.com", "ft.com", "wsj.com", "marketwatch.com",
  "finance.yahoo.com", "economictimes.indiatimes.com", "business-standard.com", "livemint.com", "thehindubusinessline.com"];
const UGC = ["linkedin.com", "medium.com", "reddit.com", "quora.com", "youtube.com", "scribd.com", "slideshare.net", "issuu.com"];
const AUTHORITY_RE =
  /(\.gov|\.gov\.[a-z]{2}|\.gouv\.[a-z]{2}|\.edu|\.edu\.[a-z]{2}|\.ac\.[a-z]{2}|\.int|\.mil)$|^gov\.[a-z]{2}$|(^|\.)(europa\.eu|worldbank\.org|oecd\.org|iea\.org|un\.org|imf\.org|wto\.org|irena\.org)$/;
const PUBLISHER_HINT_RE = /(research|insight|intelligence|analytic|marketdata|marketreport|reports|consult)/;
const REPORT_KW_RE = /\b(market|industry|forecast|size|share)\b/i;
const NON_REPORT_PATH_RE = /\/(blog|blogs|news|press[-_]?releases?|pressreleases|articles?|insights?)\//i;
const BAD_PHRASE_RE = /frequently asked|table of contents|key takeaways|related reports?|request (?:a )?sample|key questions|report scope|research methodology|buy now|contact us|get in touch/i;

const LISTING_PATH_RE = /\/(categor(?:y|ies)|industry-verticals?|search|tags?|topics?)(?:\/|$|\?)|-market-research-\d+\.html$|\/reports\/?$/i;
const LISTING_TITLE_RE = /market research reports|research reports\b|industry reports\b|reports?\s*(?:&|and)\s*(?:industry\s+)?analysis/i;
const RELATED_HEAD_RE = /related|similar|recent(?:ly)? (?:published|viewed)|popular|trending|you may also|other reports|more reports|explore more/i;

const TRACKED_DOMAINS = [...new Set([...BRIEF_TRACKED.map((t) => t.domain), ...COMPETITOR_SITES])];
const matchesDomain = (d, base) => !!d && !!base && (d === base || d.endsWith("." + base));
const inList = (d, list) => list.some((x) => matchesDomain(d, x));

const stem = (w) => (w.length > 4 && w.endsWith("ies") ? w.slice(0, -3) + "y" : w.length > 3 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w);
const stemTokens = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(Boolean).map(stem);
function kwMatch(keyword, ...texts) {
  const need = keywordTokens(keyword).map(stem);
  if (!need.length) return true;
  const have = new Set(texts.flatMap((t) => stemTokens(t)));
  return need.every((t) => have.has(t));
}

export function displayName(domain) {
  const d = String(domain || "").toLowerCase();
  const t = BRIEF_TRACKED.find((x) => matchesDomain(d, x.domain));
  if (t) return t.name;
  const k = Object.keys(KNOWN_NAMES).find((x) => matchesDomain(d, x));
  if (k) return KNOWN_NAMES[k];
  return d.replace(/\.(com|org|net|io|co|gov|edu|in|co\.uk)$/i, "");
}

export function classifyDomain(domain, ourDomain) {
  const d = String(domain || "").toLowerCase();
  if (!d) return "other";
  if (ourDomain && matchesDomain(d, ourDomain)) return "ours";
  if (inList(d, TRACKED_DOMAINS)) return "tracked";
  if (inList(d, PUBLISHERS)) return "publisher";
  if (inList(d, PRESS)) return "press";
  if (AUTHORITY_RE.test(d)) return "authority";
  if (inList(d, NEWS)) return "news";
  if (inList(d, UGC)) return "ugc";
  if (PUBLISHER_HINT_RE.test(d.split(".")[0])) return "publisher";
  return "other";
}

/* ===================== 2. Fetching ===================== */

export async function collectSerpPages(serp, { ourDomain = null, maxPages = 10, manual = [] } = {}) {
  const keyword = serp.query || "";
  const contentType = REPORT_KW_RE.test(keyword) ? "report" : "blog";
  const manualList = (manual || [])
    .filter((m) => m && /^https?:\/\//i.test(m.url))
    .slice(0, 8)
    .map((m) => ({ url: m.url, html: m.html || null, domain: domainOf(m.url) }));
  const pastedFor = (link) => manualList.find((m) => m.html && sameUrl(m.url, link));

  const rows = (serp.organic || []).slice(0, maxPages)
    .map((r) => ({ ...r, type: classifyDomain(r.domain, ourDomain), page1: true }));

  const page1Job = Promise.all(rows.map((r) => {
    const m = pastedFor(r.link);
    return m ? Promise.resolve({ ...r, ...trusted(pageFromHtml(r.link, m.html)) }) : loadRow(r);
  }));
  const suggestJob = collectSuggestions(keyword, serp.gl, serp.hl);

  const page2 = await withDeadline(
    searchGoogle(keyword, { gl: serp.gl, hl: serp.hl, num: 10, page: 2 }).catch(() => null), 8000, null);
  const ranks11to20 = (page2?.organic || []).map((r) => ({ ...r, type: classifyDomain(r.domain, ourDomain) }));
  const rankOf = (link) => { const hit = ranks11to20.find((r) => sameUrl(r.link, link)); return hit ? hit.position : null; };

  const used = new Set();
  const missing = BRIEF_TRACKED.filter((t) => !rows.some((r) => matchesDomain(r.domain, t.domain)));
  const trackedJob = Promise.all(missing.map((t) => {
    const m = manualList.find((x) => matchesDomain(x.domain, t.domain));
    if (m) {
      used.add(m.url);
      return loadManual(m, { domain: t.domain, type: "tracked", page1: false, position: rankOf(m.url) });
    }
    return withDeadline(discoverTracked(t, keyword, contentType, serp, ranks11to20), 36000, {
      domain: t.domain, type: "tracked", page1: false, position: null, link: null, fetched: false,
      discovery: "Search timed out",
    });
  }));

  const extras = manualList.filter((m) => !used.has(m.url) && !rows.some((r) => sameUrl(r.link, m.url)));
  const extraJob = Promise.all(extras.map((m) =>
    loadManual(m, { domain: m.domain, type: classifyDomain(m.domain, ourDomain), page1: false, position: rankOf(m.url), manualExtra: true })));

  const ourP2 = ourDomain && !rows.some((r) => r.type === "ours") ? ranks11to20.find((r) => r.type === "ours") : null;
  const ourJob = ourP2 ? loadRow({ ...ourP2, page1: false }) : Promise.resolve(null);

  const [page1, tracked, our, suggestions, extra] = await Promise.all([page1Job, trackedJob, ourJob, suggestJob, extraJob]);
  serp.suggestions = suggestions;
  return [...page1, ...tracked, ...(our ? [our] : []), ...extra];
}

export async function fetchOurPage(url) {
  return { link: url, domain: domainOf(url), position: null, type: "ours", page1: false, ...(await loadPage(url)) };
}

async function loadRow(r) {
  if (!/^https?:\/\//i.test(r.link)) return { ...r, fetched: false, skipped: "Not a web page" };
  if (/\.(pdf|docx?|xlsx?|pptx?)(\?|$)/i.test(r.link)) return { ...r, fetched: false, skipped: "PDF / document" };
  if (/(^|\.)youtube\.com$/.test(r.domain)) return { ...r, fetched: false, skipped: "Video" };
  return { ...r, ...(await loadPage(r.link)) };
}

async function loadPage(url) {
  const f = await withDeadline(
    fetchPage(url, { timeoutMs: 11000, retries: 1 }),
    33000,
    { status: 0, html: "", blocked: false, error: "timeout" }
  );
  const x = xray(url, f.status, f.html);
  if (!x.fetched) return { fetched: false, blocked: !!f.blocked, status: f.status || 0 };
  // Pages read by ChatGPT: use its word / table counts (the rebuilt page is a summary).
  if (f.aiMeta) {
    if (f.aiMeta.words) x.contentWords = f.aiMeta.words;
    if (Number.isFinite(f.aiMeta.tables)) x.tables = f.aiMeta.tables;
  }
  let signals = {};
  try { signals = extractSignals(f.html); } catch { /* best effort */ }
  signals.isListing = isListingFrom(signals, url);
  return { fetched: true, status: f.status, xray: x, signals, via: f.via || null, archivedAt: f.archivedAt || null };
}

function pageFromHtml(url, html) {
  const x = xray(url, 200, html);
  if (!x.fetched) return { fetched: false, blocked: false, status: 0, discovery: "Couldn't read the pasted content — copy the whole page (Ctrl+A, Ctrl+C) and try again" };
  let signals = {};
  try { signals = extractSignals(html); } catch { /* best effort */ }
  signals.isListing = false;
  return { fetched: true, status: 200, xray: x, signals, via: "pasted" };
}

function trusted(page) {
  if (page && page.signals) page.signals.isListing = false;
  return page;
}

async function loadManual(m, base) {
  const page = m.html
    ? pageFromHtml(m.url, m.html)
    : trusted(await withDeadline(loadPage(m.url), 33000, { fetched: false, blocked: false }));
  return {
    ...base, link: m.url, title: (page.xray && (page.xray.title || (page.xray.h1List || [])[0])) || "", method: "manual", manual: true,
    ...page,
    discovery: page.fetched ? null : page.discovery || "Added by you, but the site blocked our reader — use “Paste page” to paste its content",
  };
}

function withDeadline(promise, ms, fallback) {
  let t;
  return Promise.race([
    promise.finally(() => clearTimeout(t)),
    new Promise((resolve) => { t = setTimeout(() => resolve(fallback), ms); }),
  ]);
}

async function collectSuggestions(keyword, gl = "us", hl = "en") {
  const k = String(keyword || "").toLowerCase().trim();
  if (!k) return [];
  const seeds = [k, `${k} `, `${k} size`, `${k} share`, `${k} growth`, `${k} by`, `${k} in`, `${k} report`,
    `${k} companies`, `${k} trends`, `${k} forecast`, `what is ${k}`, `how big is ${k}`];
  const lists = await Promise.all(seeds.map((s) => withDeadline(googleSuggest(s, gl, hl), 4000, [])));
  return [...new Set(lists.flat().map((s) => String(s).toLowerCase().trim()))].filter((s) => s && s !== k && s.length < 90);
}

async function googleSuggest(q, gl, hl) {
  const u = `https://suggestqueries.google.com/complete/search?client=firefox&hl=${encodeURIComponent(hl)}&gl=${encodeURIComponent(gl)}&q=${encodeURIComponent(q)}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 3500);
  try {
    const r = await fetch(u, { headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36" }, signal: ctrl.signal });
    if (!r.ok) return [];
    const d = JSON.parse(await r.text());
    return Array.isArray(d[1]) ? d[1] : [];
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

async function discoverTracked(t, keyword, contentType, serp, ranks11to20) {
  const base = { domain: t.domain, type: "tracked", page1: false, position: null, title: "", snippet: "", link: null };
  const isReport = contentType === "report";
  const reportRe = REPORT_URL[t.domain];
  const strict = STRICT_REPORT_URL.has(t.domain);
  try {
    let link = null, position = null, title = "", method = null, page = null, closest = null;

    const inTop20 = ranks11to20.find((r) => matchesDomain(r.domain, t.domain));
    if (inTop20) { link = inTop20.link; position = inTop20.position; title = inTop20.title; method = "google"; }

    if (!link) {
      const s = await searchGoogle(`${keyword} site:${t.domain}`, { gl: serp.gl, hl: serp.hl, num: 10 }).catch(() => null);
      const hits = (s?.organic || []).filter((r) => matchesDomain(r.domain, t.domain) && kwMatch(keyword, r.link, r.title));
      const usable = hits.filter((r) =>
        !LISTING_PATH_RE.test(pathOf(r.link)) && !LISTING_TITLE_RE.test(r.title || "") &&
        (!isReport || !NON_REPORT_PATH_RE.test(r.link)));
      const exact = usable.filter((r) => isSameMarket(keyword, r.title, t.domain));
      const typed = reportRe ? exact.find((r) => reportRe.test(r.link)) : null;
      const best = strict ? typed || null : typed || exact[0] || null;
      if (best) { link = best.link; title = best.title; method = "site-search"; }
      else closest = usable[0] || null;
    }

    if (!link && isReport) {
      const probe = await slugProbe(keyword, t.domain);
      if (probe) { link = probe.link; page = probe.page; method = "slug-probe"; }
    }

    if (!link) {
      return {
        ...base, fetched: false,
        discovery: closest ? `No report for this exact market — closest is “${truncate(closest.title, 70)}”` : "No report found for this keyword",
      };
    }
    if (!page) page = await loadPage(link);

    if (page.fetched && page.signals && page.signals.isListing) {
      return {
        ...base, link, position, title, fetched: false, kind: "category",
        discovery: position ? "Ranks with a category page (a list of reports), not a single report" : "Only a category page (a list of reports) was found",
      };
    }
    if (page.fetched && method !== "google" && !kwMatch(keyword, page.xray.title) && !kwMatch(keyword, link)) {
      return { ...base, link, fetched: false, discovery: "Closest page is about a different topic" };
    }
    return { ...base, link, position, title: title || (page.xray && page.xray.title) || "", method, ...page };
  } catch {
    return { ...base, fetched: false, discovery: "Lookup failed" };
  }
}

const SLUG_URL = {
  "precedenceresearch.com": (s) => `https://www.precedenceresearch.com/${s}-market`,
  "futuremarketinsights.com": (s) => `https://www.futuremarketinsights.com/reports/${s}-market`,
  "marketresearchfuture.com": (s) => `https://www.marketresearchfuture.com/reports/${s}-market`,
  "grandviewresearch.com": (s) => `https://www.grandviewresearch.com/industry-analysis/${s}-market-report`,
};

async function slugProbe(keyword, domain) {
  const make = SLUG_URL[domain];
  const slug = String(keyword || "").toLowerCase().replace(/[^a-z0-9\s-]/g, " ").split(/[\s-]+/)
    .filter((w) => w && !["market", "markets", "report", "size", "share", "industry", "global", "analysis", "forecast"].includes(w))
    .join("-");
  if (!make || !slug) return null;
  const link = make(slug);
  const page = await loadPage(link);
  if (!page.fetched || (page.signals && page.signals.isListing) || !kwMatch(keyword, page.xray.title)) return null;
  return { link, page };
}

// Same market as the keyword? Extra words before "market" in the title mean a narrower market
// ("Generic Pharmaceuticals Market" ≠ "Pharmaceuticals Market"). The site's own name and
// "worldwide" don't count — Statista titles read "Pharmaceuticals - Worldwide | Statista Market Forecast".
const SAME_MARKET_OK = new Set(["worldwide", "world"].map(stem));
function isSameMarket(keyword, title, domain = "") {
  if (!/\bmarkets?\b/i.test(keyword)) return true;
  const kw = new Set(stemTokens(keyword));
  const brand = stem(String(domain || "").toLowerCase().split(".")[0] || "");
  const head = String(title || "").split(/\bmarkets?\b/i)[0] || "";
  const extra = stemTokens(head).filter((w) => w.length > 2 && !kw.has(w) && !MOD_STEM.has(w) && !STOP_STEM.has(w) &&
    !SAME_MARKET_OK.has(w) && w !== brand && !/^\d+$/.test(w));
  return extra.length === 0;
}

function isListingFrom(signals, url) {
  if (LISTING_PATH_RE.test(pathOf(url))) return true;
  if (signals.titleListing) return true;
  return !!signals.contentListing && !signals.reportLike;
}

/* ===================== 3. Market-research signals ===================== */

const VAL_RE = /(?:USD|US\$|\$|EUR|€|GBP|£|INR|₹)\s?\d[\d,]*(?:\.\d+)?\s?(?:trillion|billion|million|bn|mn|tn)\b/gi;
const CAGR_RES = [
  /(\d{1,2}(?:\.\d{1,2})?)\s?%\s*(?:CAGR|compound annual growth rate)/i,
  /CAGR\s*(?:of|at|:|is|was)?\s*(?:around|about|nearly|approximately)?\s*(\d{1,2}(?:\.\d{1,2})?)\s?%/i,
  /compound annual growth rate[^%\d]{0,40}?(\d{1,2}(?:\.\d{1,2})?)\s?%/i,
];
const PERIOD_RE = /\b(20[1-4]\d)\s?(?:-|–|—|to)\s?(20[2-5]\d)\b/g;

const REGIONS = [
  ["North America", /\bnorth america/i],
  ["Europe", /\beurope/i],
  ["Asia Pacific", /\basia[\s-]?pacific|\bapac\b/i],
  ["Latin America", /\blatin america|\bsouth america/i],
  ["Middle East & Africa", /\bmiddle east|\bafrica\b|\bmea\b|\bgcc\b/i],
];
const COUNTRIES = [
  ["United States", /\b[Uu]nited [Ss]tates\b|\bU\.S\.|\bUSA\b/], ["Canada", /\bcanada\b/i], ["Mexico", /\bmexico\b/i],
  ["Brazil", /\bbrazil\b/i], ["Germany", /\bgermany\b/i], ["United Kingdom", /\b[Uu]nited [Kk]ingdom\b|\bUK\b|\bU\.K\./],
  ["France", /\bfrance\b/i], ["Italy", /\bitaly\b/i], ["Spain", /\bspain\b/i], ["China", /\bchina\b/i],
  ["India", /\bindia\b/i], ["Japan", /\bjapan\b/i], ["South Korea", /\bsouth korea\b/i], ["Australia", /\baustralia\b/i],
  ["Saudi Arabia", /\bsaudi arabia\b/i], ["UAE", /\bUAE\b|\bunited arab emirates\b/i], ["South Africa", /\bsouth africa\b/i],
];
const REGION_ALT = "(north america|europe|asia[\\s-]?pacific|latin america|middle east (?:and|&) africa)";
const LARGEST_RE = new RegExp(REGION_ALT + "[^.]{0,90}?(?:dominat|largest|leading position|highest share|major share|accounted for)", "i");
const FASTEST_RE = new RegExp(REGION_ALT + "[^.]{0,90}?(?:fastest|highest cagr|most rapid)", "i");

const SEG_RE =
  /\bby\s+(product\s+type|type|product|application|end[\s-]?use(?:rs?)?|end[\s-]?users?|industry\s+vertical|vertical|industry|component|technology|deployment(?:\s+mode)?|distribution\s+channel|sales\s+channel|channel|material|form|source|grade|capacity|organi[sz]ation\s+size|enterprise\s+size|offering|service|solution|platform|vehicle\s+type|packaging|category|function|indication|route\s+of\s+administration|modality|molecule\s+type|age\s+group|ownership|disease|region|geography)\b/gi;

const MONTH = "(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\\.?";
const DATE_TXT_RE = new RegExp(
  `(?:last updated|updated on|updated|published on|published)\\s*:?\\s*(${MONTH}\\s+\\d{1,2},?\\s+20\\d{2}|\\d{1,2}\\s+${MONTH},?\\s+20\\d{2}|20\\d{2}-\\d{2}-\\d{2}|${MONTH}\\s+20\\d{2})`,
  "i"
);

const PLAYER_HEAD_RE =
  /\b(key|major|leading|prominent|top|prime|notable)\s+(?:market\s+)?(?:players|companies|vendors|manufacturers|participants|suppliers)\b|competitive landscape|company profiles|companies (?:covered|profiled)|list of (?:key )?companies/i;

export function extractSignals(html) {
  const $ = cheerio.load(html);
  const pageTitle = $("title").first().text().replace(/\s+/g, " ").trim();
  $("script, style, noscript, svg").remove();
  const h1 = $("h1").first().text().replace(/\s+/g, " ").trim();
  const heads = [];
  $("h1, h2, h3, h4").each((_, el) => {
    const t = $(el).text().replace(/\s+/g, " ").trim();
    if (t && t.length < 200) heads.push(t);
  });
  const headText = heads.join(" | ");
  const body = $("body").text().replace(/\s+/g, " ").slice(0, 80000);
  const figures = extractFigures(body);

  const priceCount = (body.match(/\bprice\s*:\s*(?:us\s*)?\$?\s*\d/gi) || []).length;
  let linkedReportHeads = 0;
  let inRelated = false;
  $("h2, h3, h4").each((_, el) => {
    const txt = $(el).text().replace(/\s+/g, " ").trim();
    if (RELATED_HEAD_RE.test(txt)) { inRelated = true; return; }
    if (inRelated) return;
    const t = $(el).find("a").first().text().replace(/\s+/g, " ").trim();
    if (t.length > 30 && /\bmarket\b/i.test(t)) linkedReportHeads++;
  });
  const mainHead = h1 || pageTitle;
  const reportLike = /\bmarkets?\b/i.test(mainHead) && !/\breports\b/i.test(h1) &&
    (figures.cagr != null || figures.values.length > 0 || !!figures.period);

  return {
    pageTitle,
    h1,
    titleListing: LISTING_TITLE_RE.test(pageTitle) || LISTING_TITLE_RE.test(h1),
    contentListing: priceCount >= 3 || linkedReportHeads >= 4,
    reportLike,
    figures,
    segments: extractSegments(headText + " | " + body.slice(0, 30000)),
    regions: REGIONS.filter(([, re]) => re.test(headText)).map(([n]) => n),
    countries: COUNTRIES.filter(([, re]) => re.test(headText)).map(([n]) => n),
    largestRegion: regionClaim(body, LARGEST_RE),
    fastestRegion: regionClaim(body, FASTEST_RE),
    companies: extractCompanies($),
    lastUpdated: (body.match(DATE_TXT_RE) || [])[1] || null,
    hasMethodology: /methodology/i.test(headText) || /research methodology/i.test(body),
    questionHeadings: heads.filter((h) => /\?\s*$/.test(h)).slice(0, 25),
  };
}

function extractFigures(text) {
  const firstMentions = [...new Set((text.match(VAL_RE) || []).map((s) => s.replace(/\s+/g, " ").trim()))].slice(0, 4);
  let cagr = null;
  for (const re of CAGR_RES) {
    const m = text.match(re);
    if (m) { const v = parseFloat(m[1]); if (v > 0 && v < 80) { cagr = v; break; } }
  }
  const now = new Date().getFullYear();
  let period = null;
  for (const m of text.matchAll(PERIOD_RE)) {
    const a = +m[1], b = +m[2];
    if (b > a && b - a >= 3 && b >= now) { period = `${a}–${b}`; break; }
  }
  // FIG — base and forecast values read with their years, e.g. "USD 1.88 trillion in 2026 … USD 3.20 trillion
  // by 2035" or "2033 Projected Market Size: USD 2,780 Billion". Values come out as "USD 1.88 trillion (2026)",
  // which lib/brief-checks.js reads, so the figure check compares the right pair. Falls back to the first
  // two values mentioned when the years can't be read.
  const dated = datedValues(text, period);
  return { values: dated || firstMentions, cagr, period, dated: !!dated };
}

// A year right after the value needs a preposition or brackets ("in 2025", "by 2033", "(2026)"), so a label
// that starts the next item ("… Billion 2026 Market Size: …") isn't taken. Otherwise the closest year in
// the same sentence before the value ("2025 Market Size: USD …", "In 2025, the market was valued at USD …").
const YEAR_AFTER_RE = /^\s*,?\s*(?:\(\s*|(?:in|by|for|during|till|until|through|at the end of)\s+(?:the\s+(?:year|end of)\s+)?)((?:19|20)\d{2})\b/i;
const YEAR_BEFORE_RE = /\b((?:19|20)\d{2})\b[^.;!?\d]{0,45}$/;

function datedValues(text, period) {
  const re = new RegExp(VAL_RE.source, "gi");
  const pairs = [];
  let prevEnd = 0;
  let consumed = 0;
  let seen = 0;
  let m;
  while ((m = re.exec(text)) && seen < 60) {
    seen++;
    const start = m.index;
    const end = start + m[0].length;
    let year = null;
    const after = text.slice(end, end + 40).match(YEAR_AFTER_RE);
    if (after) {
      year = +after[1];
      consumed = end + after[0].length;
    } else {
      const before = text.slice(Math.max(prevEnd, consumed, start - 60), start).match(YEAR_BEFORE_RE);
      if (before) year = +before[1];
    }
    prevEnd = end;
    if (year && year >= 2010 && year <= 2050) pairs.push({ raw: m[0].replace(/\s+/g, " ").trim(), year, at: start });
  }
  if (pairs.length < 2) return null;
  // The headline figures sit together, usually at the top — use the values near the first dated one.
  const cluster = pairs.filter((p) => p.at - pairs[0].at <= 1500);
  const years = cluster.map((p) => p.year);
  const per = period ? period.split("–").map(Number) : null;
  const base = (per && cluster.find((p) => p.year === per[0])) || cluster.find((p) => p.year === Math.min(...years));
  const fc = (per && cluster.find((p) => p.year === per[1])) || cluster.find((p) => p.year === Math.max(...years));
  if (!base || !fc || fc.year <= base.year) return null;
  return [`${base.raw} (${base.year})`, `${fc.raw} (${fc.year})`];
}

function extractSegments(text) {
  const set = new Set();
  for (const m of text.matchAll(SEG_RE)) set.add(canonSegment(m[1]));
  return [...set];
}

function canonSegment(s) {
  const l = s.toLowerCase().replace(/[\s-]+/g, " ").trim();
  if (/^(product type|type|product)$/.test(l)) return "Type / product";
  if (/^end use|end user/.test(l)) return "End user";
  if (/vertical|industry/.test(l)) return "Industry";
  if (/channel/.test(l)) return "Distribution channel";
  if (/size$/.test(l)) return "Organization size";
  if (/^(region|geography)$/.test(l)) return "Region";
  if (/deployment/.test(l)) return "Deployment";
  return l.charAt(0).toUpperCase() + l.slice(1);
}

function regionClaim(text, re) {
  const m = text.match(re);
  if (!m) return null;
  const l = m[1].toLowerCase();
  if (l.startsWith("north")) return "North America";
  if (l.startsWith("europe")) return "Europe";
  if (l.startsWith("asia")) return "Asia Pacific";
  if (l.startsWith("latin")) return "Latin America";
  return "Middle East & Africa";
}

function extractCompanies($) {
  const out = [];
  const seen = new Set();
  const push = (raw) => {
    const name = cleanCompany(raw);
    const k = companyKey(name);
    if (!name || !k || seen.has(k) || out.length >= 40) return;
    seen.add(k);
    out.push(name);
  };
  const collectFrom = ($nodes) => {
    let found = 0;
    $nodes.each((_, sib) => {
      const $s = $(sib);
      const lis = $s.is("li") ? $s : $s.find("li");
      lis.each((__, li) => { push($(li).text()); found++; });
    });
    return found;
  };
  $("h2, h3, h4, p > strong, p > b").each((_, el) => {
    if (out.length >= 40) return false;
    const t = $(el).text().replace(/\s+/g, " ").trim();
    if (!t || t.length > 120 || !PLAYER_HEAD_RE.test(t)) return;
    const tag = String(el.name || el.tagName || "").toLowerCase();
    const anchor = tag === "strong" || tag === "b" ? $(el).parent() : $(el);
    const found = collectFrom(anchor.nextUntil("h1, h2, h3").slice(0, 6));
    if (!found && anchor.parent().text().trim().length < 300) collectFrom(anchor.parent().nextUntil("h1, h2, h3").slice(0, 3));
  });
  return out;
}

const JUNK_COMPANY_RE = /\b(population|diseases?|demand|growth|rising|increasing|adoption|prevalence|awareness|markets?|segments?|regulations?|investments?|expansion|chronic|aging|ageing|trends?|factors?|drivers?|challenges?|opportunit\w*|innovation)\b/i;

function cleanCompany(raw) {
  let t = String(raw || "").replace(/\s+/g, " ").trim();
  t = t.replace(/\([^)]*\)/g, "").replace(/\s[–—-]\s.*$/, "").replace(/:.*$/, "").replace(/[.,;]+$/, "").trim();
  if (t.length < 2 || t.length > 60) return "";
  const words = t.split(" ").length;
  if (words > 7) return "";
  if (!/[A-Za-z]/.test(t) || /https?:|www\.|^(and|others?|etc\.?|more|other key players)$/i.test(t)) return "";
  if (/^[a-z]/.test(t) && words > 3) return "";
  if (JUNK_COMPANY_RE.test(t)) return "";
  return t;
}

function companyKey(name) {
  return String(name || "")
    .toLowerCase()
    .replace(/\b(inc|incorporated|ltd|limited|llc|plc|corp|corporation|co|company|gmbh|ag|s\.?a|n\.?v|b\.?v|s\.?p\.?a|holdings?|group|international|industries)\b\.?/g, "")
    .replace(/[^a-z0-9]/g, "");
}

/* ===================== 4. Topics (standard report sections only) ===================== */

const SKIP_HEAD_RE =
  /related (?:reports?|articles?|posts?|news)|request (?:a |for )?(?:free )?sample|why choose|our clients|testimonial|contact us|buy now|licen[cs]e|subscribe|newsletter|need help|get in touch|download|enquir|inquir|customi[sz]ation|share this|follow us|trusted by|you may also|recently viewed|popular reports?|latest reports?|our (?:services|offerings)|cookie|table of contents|report description|speak to|talk to|ask an analyst|payment|checkout|meet the team|ask for sample/i;

const HEAD_STOP = new Set(["market", "markets", "global", "report", "reports", "the", "of", "and", "in", "for", "to", "by",
  "a", "an", "on", "with", "its", "what", "is", "are", "how", "does", "do", "which", "who", "why", "will", "key",
  "analysis", "industry", "share", "size", "outlook", "vs"]);

const TOPIC_RULES = [
  ["FAQs", /\bfaqs?\b|frequently asked/],
  ["Report scope & methodology", /\bscope\b|methodolog|research approach|assumption|data source|report coverage|report attribute|report highlights/],
  ["Macro impact (tariffs, geopolitics, AI…)", /impact|tariff|covid|geopolit|inflation|recession|trade war/],
  ["Competitive landscape & key players", /competit|key (?:market )?players|\bcompan(?:y|ies)\b|vendor|manufacturer|market share analysis|leading players|market leaders/],
  ["Recent developments", /recent development|\bnews\b|merger|acquisition|partnership|\blaunch|expansion|strategic|collaboration/],
  ["Regional & country analysis", /region|geograph|north america|europe|asia|latin america|middle east|africa|\bcountr|\bu\.s\.|\bunited states|china|india|japan|germany/],
  ["Segmentation by application", /application|use case/],
  ["Segmentation by end use / industry", /end[\s-]?use|end[\s-]?user|vertical|by industry|\bindustries\b|\bsector/],
  ["Segmentation by type / product", /\btypes?\b|\bproducts?\b|\bcategor|\bgrade/],
  ["Other segmentation (component, technology, channel…)", /component|technolog|deployment|distribution|channel|material|\bforms?\b|\bsources?\b|offering|solution|platform|\bservices?\b/],
  ["Segmentation overview", /segment/],
  ["Market dynamics & growth drivers", /dynamic|driver|driving|growth factor|propel|\bfuel/],
  ["Restraints & challenges", /restrain|challenge|barrier|hinder|limitation|pitfall/],
  ["Opportunities", /opportunit/],
  ["Market trends & innovation", /trend|innovation|emerging|advancement/],
  ["Pricing analysis", /\bpric|cost analysis/],
  ["Value chain & industry analysis", /value chain|supply chain|ecosystem|porter|pest[le]{2}|\bswot/],
  ["Regulatory landscape", /regulat|\bpolic(?:y|ies)\b|\bstandards?\b|compliance|reimbursement/],
  ["Investment & funding", /invest|funding|venture/],
  ["Market size & forecast", /\bsize\b|forecast|valuation|revenue|volume|projection|\bcagr\b|growth rate/],
  ["Market overview & definition", /overview|introduction|definition|\bwhat is\b|summary|snapshot|at a glance|highlights|key (?:insights|findings|takeaways)/],
  ["Analyst view & conclusion", /analyst|conclusion|recommendation|verdict/],
];

const PLACEMENT = {
  "Market overview & definition": { order: 1, h2: (K) => `${K} Overview`, where: "Top of the page, right after the summary", write: "Define the market, what's included, and who buys it." },
  "Market size & forecast": { order: 2, h2: (K) => `${K} Size & Forecast`, where: "Second section, before segmentation", write: "Base-year size, forecast value and CAGR, with a year-by-year table." },
  "Market dynamics & growth drivers": { order: 3, h2: (K) => `${K} Growth Drivers`, where: "Middle — 'Market dynamics' section", write: "3–5 drivers, each backed by a figure or a cited source." },
  "Restraints & challenges": { order: 4, h2: (K) => `${K} Challenges`, where: "Middle — inside 'Market dynamics'", write: "What slows growth (cost, regulation, reimbursement) and by how much." },
  "Opportunities": { order: 5, h2: (K) => `${K} Opportunities`, where: "Middle — inside 'Market dynamics'", write: "Where new revenue will come from during the forecast period." },
  "Market trends & innovation": { order: 6, h2: (K) => `${K} Trends`, where: "After market dynamics", write: "3–4 current trends, each with a real example." },
  "Macro impact (tariffs, geopolitics, AI…)": { order: 7, h2: () => "Impact of Tariffs, Policy & AI", where: "After trends", write: "How tariffs, policy or AI change the outlook — be specific." },
  "Segmentation overview": { order: 8, h2: (K) => `${K} Segmentation`, where: "After market dynamics", write: "Summarise the segment splits, then one H3 per split." },
  "Segmentation by type / product": { order: 9, h2: (K) => `${K} by Type`, where: "Segmentation section", write: "Share and growth of each type, with a table." },
  "Segmentation by application": { order: 10, h2: (K) => `${K} by Application`, where: "Segmentation section", write: "Share and growth of each application, with a table." },
  "Segmentation by end use / industry": { order: 11, h2: (K) => `${K} by End User`, where: "Segmentation section", write: "Share and growth of each end-user group, with a table." },
  "Other segmentation (component, technology, channel…)": { order: 12, h2: (K) => `${K} by Service / Component`, where: "Segmentation section", write: "Any other split competitors use (service, component, technology)." },
  "Regional & country analysis": { order: 13, h2: (K) => `${K} by Region`, where: "After segmentation", write: "Size and growth by region; name the largest and fastest-growing." },
  "Pricing analysis": { order: 14, h2: (K) => `${K} Pricing`, where: "After regional analysis", write: "Price ranges and how they are changing." },
  "Value chain & industry analysis": { order: 15, h2: (K) => `${K} Value Chain`, where: "After regional analysis", write: "Who does what, from supplier to end user." },
  "Regulatory landscape": { order: 16, h2: (K) => `${K} Regulations`, where: "After regional analysis", write: "Key rules, approvals or reimbursement that shape the market." },
  "Investment & funding": { order: 17, h2: (K) => `${K} Investments`, where: "Before competitive landscape", write: "Notable funding rounds and investors." },
  "Competitive landscape & key players": { order: 18, h2: (K) => `${K} Competitive Landscape`, where: "Near the end, before FAQs", write: "Leading companies, their strategies and share (if known)." },
  "Recent developments": { order: 19, h2: () => "Recent Developments", where: "Right after competitive landscape", write: "Dated launches, deals and partnerships from the last 12 months." },
  "Analyst view & conclusion": { order: 20, h2: () => "Analyst View", where: "Before FAQs", write: "Our take: what buyers should watch next." },
  "Report scope & methodology": { order: 21, h2: () => "Report Scope & Methodology", where: "Bottom of the page, before FAQs", write: "Base year, forecast period, units, segments covered, and how we estimated." },
  "FAQs": { order: 22, h2: () => "Frequently Asked Questions", where: "Last section", write: "5–6 real questions with 2–3 sentence answers." },
};
const ORDER = (label) => (PLACEMENT[label] ? PLACEMENT[label].order : 50);

function sectionHeadings(tree = []) {
  const h2 = tree.filter(([l]) => l === 2).map(([, t]) => t);
  const h3 = tree.filter(([l]) => l === 3).map(([, t]) => t);
  const list = h2.length >= 4 ? h2 : h3.length >= 4 ? h3 : [...h2, ...h3];
  return list.map((t) => String(t).replace(/\s+/g, " ").trim()).filter((t) => t && t.length <= 160 && !SKIP_HEAD_RE.test(t));
}

function sectionHeadingsAll(tree = []) {
  return tree.filter(([l]) => l === 2 || l === 3)
    .map(([, t]) => String(t).replace(/\s+/g, " ").trim())
    .filter((t) => t && t.length <= 160 && !SKIP_HEAD_RE.test(t));
}

function topicOf(heading, kw) {
  const stripped = stripKeyword(heading, kw);
  for (const [label, re] of TOPIC_RULES) if (re.test(stripped)) return label;
  return null;
}

// Topic labels for a list of headings ("H2: …" strings from a saved brief work too) — used by
// lib/competitor-gaps.js to see which sections our own page already has.
export function topicLabels(headings, keyword) {
  const kw = keywordTokens(keyword);
  return [...new Set((headings || [])
    .map((h) => String(h || "").replace(/^H\d:\s*/i, "").replace(/\s+/g, " ").trim())
    .filter((h) => h && h.length <= 160 && !SKIP_HEAD_RE.test(h))
    .map((h) => topicOf(h, kw))
    .filter(Boolean))];
}

function buildTopicMatrix(pages, kw) {
  const map = new Map();
  for (const p of pages) {
    for (const h of sectionHeadingsAll(p.xray.headingTree)) {
      const label = topicOf(h, kw);
      if (!label) continue;
      if (!map.has(label)) map.set(label, { label, sites: new Set(), examples: [] });
      const r = map.get(label);
      r.sites.add(p.domain);
      if (r.examples.length < 3 && !r.examples.includes(h)) r.examples.push(h);
    }
  }
  const n = pages.length;
  const mustMin = Math.max(2, Math.ceil(n * 0.5));
  const topics = [...map.values()].map((r) => {
    const count = r.sites.size;
    return { label: r.label, count, sites: [...r.sites], examples: r.examples, tier: count >= mustMin ? "must" : count >= 2 ? "should" : "differentiator" };
  }).sort((a, b) => b.count - a.count || ORDER(a.label) - ORDER(b.label));
  return { pagesCompared: n, mustMin, topics };
}

function markOurTopics(matrix, ourPage, kw) {
  const labels = new Set(sectionHeadingsAll(ourPage.xray.headingTree).map((h) => topicOf(h, kw)).filter(Boolean));
  matrix.topics.forEach((t) => { t.ours = labels.has(t.label); });
}

function orderColumns(pages) {
  const seen = new Set();
  const cols = [];
  const push = (p) => {
    if (seen.has(p.domain)) return;
    seen.add(p.domain);
    const t = BRIEF_TRACKED.find((x) => matchesDomain(p.domain, x.domain));
    cols.push({ domain: p.domain, name: displayName(p.domain), short: t ? t.short : displayName(p.domain).slice(0, 14) });
  };
  BRIEF_TRACKED.forEach((t) => pages.filter((p) => matchesDomain(p.domain, t.domain)).forEach(push));
  pages.slice().sort((a, b) => (a.position || 99) - (b.position || 99)).forEach(push);
  return cols.slice(0, 9);
}

/* ===================== 5. Keywords ===================== */

const KW_STOP = new Set(["the", "of", "and", "in", "for", "to", "by", "a", "an", "on", "with", "its", "is", "are", "what",
  "how", "which", "who", "why", "will", "from", "at", "as", "or", "vs", "into", "&", "your", "our", "their", "this", "that",
  "these", "those", "be", "can", "do", "does", "per", "more", "most", "new", "top", "best", "get", "all", "you", "we", "it"]);
const MODIFIERS = new Set(["market", "markets", "size", "share", "growth", "trends", "trend", "forecast", "analysis", "outlook",
  "demand", "revenue", "cagr", "players", "companies", "company", "segmentation", "segment", "segments", "regional", "region",
  "opportunities", "opportunity", "drivers", "driver", "industry", "report", "statistics", "value", "volume", "insights", "insight",
  "research", "landscape", "competitive", "applications", "application", "types", "type", "overview", "scope", "global", "key",
  "future", "latest"]);
const MOD_STEM = new Set([...MODIFIERS].map(stem));
const STOP_STEM = new Set([...KW_STOP].map(stem));
const BRAND_SAFE = new Set(["future", "business", "global", "group", "market", "markets", "the"]);
const MAX_GRAM = 6;

// Off-topic filter: phrases about other countries or other markets don't belong in this brief.
const COUNTRY_NAMES = ["united states", "usa", "u s", "canada", "mexico", "brazil", "argentina", "chile", "colombia", "peru",
  "united kingdom", "uk", "britain", "england", "germany", "france", "italy", "spain", "netherlands", "belgium", "switzerland",
  "sweden", "norway", "denmark", "finland", "poland", "russia", "turkey", "ukraine", "ireland", "portugal", "austria", "greece",
  "czech", "hungary", "romania", "india", "china", "japan", "south korea", "korea", "indonesia", "vietnam", "thailand",
  "malaysia", "singapore", "philippines", "australia", "new zealand", "pakistan", "bangladesh", "sri lanka", "nepal",
  "saudi arabia", "saudi", "uae", "emirates", "dubai", "qatar", "kuwait", "oman", "bahrain", "israel", "egypt", "nigeria",
  "kenya", "south africa", "morocco", "ethiopia", "ghana", "iran", "iraq", "taiwan", "hong kong"];
const REGION_NAMES = ["north america", "south and central america", "central america", "south america", "latin america",
  "asia pacific", "middle east", "europe", "european", "asia", "apac", "africa", "mea", "emea", "gcc", "asean", "nordic"];
const EXTRA_OK = new Set(["industry", "companies", "company", "manufacturers", "manufacturer", "leading", "top", "major", "list",
  "pdf", "statistics", "stats", "strategic", "insights", "outlook", "future", "overview", "estimated", "estimate", "projected",
  "expected", "worth", "value", "rate", "country", "countries", "region", "regions", "world", "worldwide", "revenue", "sales",
  "current", "latest", "example", "examples", "definition", "meaning", "sector", "business", "user", "users", "end", "yearly",
  "annual", "global", "share", "size", "growth", "forecast", "trends", "analysis", "report", "research", "players", "key", "demand"]
  .map(stem));

function stripPlaces(text, list) {
  let t = " " + normPhrase(text) + " ";
  for (const p of [...list].sort((a, b) => b.length - a.length)) t = t.split(" " + p + " ").join(" ");
  return t.replace(/\s+/g, " ").trim();
}

export function onTopicPhrase(keyword, phrase) {
  const p = normPhrase(phrase);
  if (!p) return false;
  const kwN = " " + normPhrase(keyword) + " ";
  const noRegions = " " + stripPlaces(p, REGION_NAMES) + " ";
  if (COUNTRY_NAMES.some((c) => noRegions.includes(" " + c + " ") && !kwN.includes(" " + c + " "))) return false;
  if (!/\bmarkets?\b/i.test(keyword)) return true; // strict topic check only for market (report) keywords
  const kwS = new Set(stemTokens(keyword));
  const left = stripPlaces(stripPlaces(p, REGION_NAMES), COUNTRY_NAMES).split(" ").filter(Boolean).map(stem)
    .filter((w) => !/^\d+$/.test(w) && !kwS.has(w) && !MOD_STEM.has(w) && !STOP_STEM.has(w) && !EXTRA_OK.has(w));
  return left.length === 0;
}

function normPhrase(s) {
  return String(s || "").toLowerCase().replace(/([a-z0-9])-([a-z0-9])/g, "$1 $2").replace(/[^a-z0-9& ]/g, " ").replace(/\s+/g, " ").trim();
}

function phrasesOf(text, brandTok) {
  const out = new Set();
  const clean = String(text || "").toLowerCase().replace(/&amp;/g, "&").replace(/([a-z0-9])[-\u2010\u2011]([a-z0-9])/g, "$1 $2");
  for (const seg of clean.split(/[|:;,()[\]{}"“”?!.\u2013\u2014/]+|\s-\s/)) {
    const w = seg.replace(/[^a-z0-9& ]/g, " ").split(/\s+/)
      .filter((t) => t && !/^(19|20)\d{2}$/.test(t) && !/^\d+(\.\d+)?$/.test(t));
    for (let n = 2; n <= MAX_GRAM; n++) {
      for (let i = 0; i + n <= w.length; i++) {
        const g = w.slice(i, i + n);
        if (KW_STOP.has(g[0]) || KW_STOP.has(g[n - 1])) continue;
        if (g.some((t) => brandTok.has(t))) continue;
        out.add(g.join(" "));
      }
    }
  }
  return out;
}

function ownPhrases(keyword, domain, x) {
  const kwStem = keywordTokens(keyword).map(stem);
  const kwNorm = normPhrase(keyword);
  const brandTok = new Set(
    [...normPhrase(displayName(domain)).split(" "), String(domain).split(".")[0]]
      .filter((t) => t.length > 2 && !MODIFIERS.has(t) && !BRAND_SAFE.has(t) && !kwStem.includes(stem(t))));
  const set = new Set();
  [x.title, ...(x.h1List || []).slice(0, 1), x.metaDesc || ""].forEach((t) => phrasesOf(t, brandTok).forEach((ph) => set.add(ph)));
  const list = [...set]
    .filter((ph) => ph !== kwNorm && !BAD_PHRASE_RE.test(ph) && ph.split(" ").length <= 5)
    .filter((ph) => kwStem.length && kwStem.every((k) => ph.split(" ").map(stem).includes(k)))
    .sort((a, b) => b.length - a.length);
  const kept = [];
  for (const ph of list) {
    if (kept.some((k) => (" " + k + " ").includes(" " + ph + " "))) continue;
    kept.push(ph);
    if (kept.length >= 5) break;
  }
  return kept;
}

function whereToUse(r, N) {
  if (r.inTitle >= Math.max(2, Math.ceil(N * 0.4))) return "Title tag + H1";
  if (r.inTitle >= 1 && r.inMeta >= 1) return "Title or meta description";
  if (r.inMeta >= 2) return "Meta description + opening paragraph";
  if (r.inHeading >= 1) return "H2 / H3 heading";
  return "Body text";
}

function whereFromPhrase(phrase, kwStem) {
  const full = " " + phrase + " ";
  const rest = " " + phrase.split(" ").filter((t) => !kwStem.includes(stem(t))).join(" ") + " ";
  if (/^ (what|how|why|which|who|is|are|does|can|will) /.test(full)) return "FAQ question";
  if (/ (size|value|worth|revenue|forecast|cagr|projection|valuation|statistics?) /.test(rest)) return "Overview / Key Market Highlights";
  if (/ (share|company|companies|players?|manufacturers?|vendors?|leaders?|competitors?|competitive) /.test(rest)) return "Competitive Landscape";
  if (/ (by|segments?|segmentation|types?|applications?|end users?|end use|products?) /.test(rest)) return "Segmental Analysis";
  if (/ (regions?|regional|country|countries|states?|north america|europe|asia|africa|latin america|middle east) /.test(rest)) return "Regional Analysis";
  if (/ (trends?|innovations?|future|outlook) /.test(rest)) return "Market Dynamics";
  if (/ (drivers?|challenges?|opportunity|opportunities|restraints?|growth) /.test(rest)) return "Market Dynamics";
  if (/ (reports?|analysis|research|study|pdf|overview) /.test(rest)) return "Title, H1 or meta";
  return "Title, H1 or opening";
}

function buildKeywords(keyword, pages, serp) {
  const kwTok = keywordTokens(keyword);
  const kwStem = kwTok.map(stem);
  const kwNorm = normPhrase(keyword);
  const hasAllKw = (toks) => kwStem.length > 0 && kwStem.every((t) => toks.map(stem).includes(t));
  const onTopic = (ph) => onTopicPhrase(keyword, ph);
  const brandTok = new Set();
  pages.forEach((p) => {
    const words = [...normPhrase(displayName(p.domain)).split(" "), String(p.domain).split(".")[0]];
    words.forEach((t) => { if (t.length > 2 && !MODIFIERS.has(t) && !BRAND_SAFE.has(t) && !kwTok.includes(t)) brandTok.add(t); });
  });

  const agg = new Map();
  const perSite = new Map();
  for (const p of pages) {
    const x = p.xray;
    const fields = [
      ["title", [x.title, ...(x.h1List || []).slice(0, 1)]],
      ["meta", [x.metaDesc || ""]],
      ["heading", sectionHeadingsAll(x.headingTree)],
    ];
    const mine = perSite.get(p.domain) || new Set();
    for (const [field, texts] of fields) {
      for (const t of texts) {
        for (const ph of phrasesOf(t, brandTok)) {
          let r = agg.get(ph);
          if (!r) { r = { phrase: ph, sites: new Set(), title: new Set(), meta: new Set(), heading: new Set() }; agg.set(ph, r); }
          r.sites.add(p.domain);
          r[field].add(p.domain);
          mine.add(ph);
        }
      }
    }
    perSite.set(p.domain, mine);
  }

  const N = pages.length || 1;
  const minRelated = Math.max(2, Math.ceil(N * 0.34));
  const isSubOfKw = (ph) => (" " + kwNorm + " ").includes(" " + ph + " ");
  const genericOnly = (toks) => toks.every((t) => MODIFIERS.has(t) || KW_STOP.has(t));

  let hidden = 0;
  const cands = [...agg.values()]
    .map((r) => ({ phrase: r.phrase, count: r.sites.size, sites: [...r.sites], inTitle: r.title.size, inMeta: r.meta.size, inHeading: r.heading.size }))
    .filter((r) => {
      if (r.phrase === kwNorm || isSubOfKw(r.phrase) || BAD_PHRASE_RE.test(r.phrase)) return false;
      const toks = r.phrase.split(" ");
      if (genericOnly(toks)) return false;
      r.variant = hasAllKw(toks);
      return r.variant ? r.count >= 1 : r.count >= minRelated;
    })
    .filter((r) => { const ok = onTopic(r.phrase); if (!ok) hidden++; return ok; })
    .sort((a, b) => b.count - a.count || b.phrase.length - a.phrase.length);

  const kept = [];
  for (const c of cands) {
    if (kept.some((k) => (" " + k.phrase + " ").includes(" " + c.phrase + " ") && k.count >= c.count)) continue;
    kept.push(c);
    if (kept.length >= 60) break;
  }
  kept.sort((a, b) => (Number(b.variant) - Number(a.variant)) || b.count - a.count);
  const fromCompetitors = kept.slice(0, 20).map((r) => ({
    phrase: r.phrase, source: "Competitors", count: r.count, of: N, sites: r.sites, names: r.sites.map(displayName),
    where: whereToUse(r, N), variant: r.variant,
  }));

  const needMarket = /\bmarkets?\b/i.test(keyword);
  const seen = new Set([kwNorm, ...fromCompetitors.map((k) => k.phrase)]);
  const fromAutocomplete = [];
  for (const s of serp.suggestions || []) {
    const p = normPhrase(s);
    if (!p || seen.has(p) || BAD_PHRASE_RE.test(p)) continue;
    if (needMarket && !/\bmarkets?\b/.test(p)) continue;
    if (!hasAllKw(p.split(" "))) continue;
    if (!onTopic(p)) { hidden++; continue; }
    seen.add(p);
    fromAutocomplete.push({ phrase: p, source: "Google autocomplete", count: null, of: null, sites: [], names: [], where: whereFromPhrase(p, kwStem), variant: true });
    if (fromAutocomplete.length >= 15) break;
  }

  const secondary = [...fromAutocomplete, ...fromCompetitors].slice(0, 30);
  const google = [
    ...(serp.relatedSearches || []).slice(0, 8).map((q) => ({ phrase: q, source: "Google related search", where: "Body text or an H2" })),
    ...(serp.peopleAlsoAsk || []).slice(0, 6).map((p) => ({ phrase: p.question, source: "People Also Ask", where: "FAQ question (use this wording)" })),
  ];
  const perSiteTop = {};
  for (const [domain, set] of perSite) perSiteTop[domain] = kept.filter((k) => set.has(k.phrase)).slice(0, 6).map((k) => k.phrase);

  const pct = (fn) => Math.round((pages.filter(fn).length / N) * 100);
  return {
    primary: {
      phrase: keyword,
      where: "Title tag, H1, URL, first sentence and meta description",
      inTitlePct: pct((p) => kwMatch(keyword, p.xray.title)),
      inH1Pct: pct((p) => (p.xray.h1List || []).some((h) => kwMatch(keyword, h))),
      inMetaPct: pct((p) => kwMatch(keyword, p.xray.metaDesc || "")),
    },
    secondary,
    hidden,
    google,
    perSite: perSiteTop,
  };
}

/* ===================== 6. Benchmarks, targets, gaps ===================== */

function stats(nums) {
  const a = nums.filter(Number.isFinite).sort((x, y) => x - y);
  if (!a.length) return null;
  const q = (p) => a[Math.min(a.length - 1, Math.round(p * (a.length - 1)))];
  return { n: a.length, min: a[0], median: q(0.5), p75: q(0.75), max: a[a.length - 1] };
}

function buildBenchmarks(pages) {
  const pick = (fn) => stats(pages.map(fn));
  const pct = (fn) => (pages.length ? Math.round((pages.filter(fn).length / pages.length) * 100) : 0);
  return {
    words: pick((p) => p.xray.contentWords),
    top3Words: stats(pages.filter((p) => p.position && p.position <= 3).map((p) => p.xray.contentWords)),
    sections: pick((p) => sectionHeadings(p.xray.headingTree).length),
    tables: pick((p) => p.xray.tables),
    faq: pick((p) => p.xray.faqCount),
    internalPer1k: pick((p) => (p.xray.contentWords ? +((p.xray.inContentInternal.length / p.xray.contentWords) * 1000).toFixed(2) : 0)),
    eeat: {
      author: pct((p) => p.xray.hasAuthor),
      reviewer: pct((p) => p.xray.hasReviewer),
      dates: pct((p) => p.xray.hasDates),
      methodology: pct((p) => p.signals && p.signals.hasMethodology),
    },
  };
}

function buildTargets(b, matrix, contentType) {
  const isBlog = contentType === "blog";
  const r100 = (x) => Math.max(100, Math.round(x / 100) * 100);
  const med = b.words && b.words.median;
  const lo = med ? r100(Math.max(med, (b.top3Words && b.top3Words.median) || 0)) : isBlog ? 1500 : 2500;
  const hi = med ? r100(Math.max(lo * 1.15, (b.words && b.words.p75) || 0)) : lo + 800;
  const must = matrix.topics.filter((t) => t.tier === "must").length;
  const should = matrix.topics.filter((t) => t.tier === "should").length;
  const ratio = (b.internalPer1k && b.internalPer1k.median) || (isBlog ? 3.5 : 4.5);
  return {
    coverageWords: [lo, hi],
    sections: Math.min(16, Math.max((b.sections && b.sections.median) || 8, must + Math.min(4, should))),
    tables: isBlog ? Math.max(1, (b.tables && b.tables.median) || 0) : Math.max(3, (b.tables && b.tables.median) || 0),
    faqs: Math.min(8, Math.max(5, (b.faq && b.faq.median) || 0)),
    internalLinks: Math.min(8, Math.max(isBlog ? 3 : 4, Math.round(((ratio * lo) / 1000) * 1.15))),
  };
}

function summariseOurPage(p) {
  const x = p.xray;
  return {
    url: p.link, position: p.position || null, words: x.contentWords, sections: sectionHeadings(x.headingTree).length,
    tables: x.tables, faq: x.faqCount, author: x.hasAuthor, dates: x.hasDates, title: x.title, titleLen: x.titleLen,
    headings: x.headingTree.filter(([l]) => l === 2 || l === 3).map(([l, t]) => `H${l}: ${t}`).slice(0, 60),
  };
}

function buildGaps(our, matrix, b, t) {
  const items = [];
  const missingTopics = matrix.topics.filter((x) => x.tier !== "differentiator" && x.ours === false).map((x) => x.label);
  if (b.words && b.words.median && our.words < b.words.median * 0.7) {
    items.push(`Your page has about ${fmtN(our.words)} words vs a competitor median of ${fmtN(b.words.median)}.`);
  }
  if (our.tables < t.tables) items.push(`${our.tables} data table(s) vs ${t.tables} recommended.`);
  if (our.faq < 3) items.push(`Only ${our.faq} FAQ(s) found.`);
  if (!our.author) items.push("No analyst byline found.");
  if (!our.dates) items.push("No last-updated date found.");
  return { missingTopics, items };
}

/* ===================== 7. Actions, outline, titles ===================== */

const RULES = [
  "Lead with our own estimates and methodology — never reuse a competitor's numbers.",
  "Write for buyers: every section must answer something they need. No filler to hit a word count.",
  "Answer related questions on this page; don't create thin pages for each keyword variation.",
  "No templated text that could be pasted onto another report by swapping the market name.",
  "Use each keyword once where it fits naturally — repeating keywords is spam under Google's policies.",
  "Only add schema (FAQ, author, dates) for things visible on the page. No fake ratings.",
];

function buildActions(c) {
  const A = [];
  const add = (priority, what, why, where) => A.push({ priority, what, why, where });
  const N = c.topics.pagesCompared || 1;
  const namesOf = (sites) => sites.map(displayName).slice(0, 4).join(", ");
  const isReport = c.contentType !== "blog";
  const F = c.figures;
  if (isReport) {
    add("must", "Opening summary with OUR numbers: base-year size, forecast value, CAGR and forecast period (3–4 sentences).",
      F.cagrMin != null
        ? `Competitors lead with these figures (their CAGRs range ${F.cagrMin}%–${F.cagrMax}%). Buyers look for the headline numbers first.`
        : "Buyers look for the headline numbers first; ranking report pages state them at the top.",
      "First paragraph, directly under the H1.");
  } else {
    add("must", "Answer the search question in the first two sentences.", "Readers and Google's AI Overviews look for a direct answer first.", "First paragraph, under the H1.");
  }
  if (c.serp.listingCount >= 2) {
    add("should", "Consider a hub page for this broad topic that summarises the market and links to every related Kings Research report.",
      `${c.serp.listingCount} of the top 10 results are category pages (${c.serp.listingSites.slice(0, 3).join(", ")}), so Google treats this keyword as a broad topic rather than one market.`,
      "A category / hub page on our site, linked from the main navigation and from each related report.");
  }
  c.topics.topics
    .filter((t) => t.tier !== "differentiator" && t.ours !== true && !["FAQs", "Report scope & methodology"].includes(t.label))
    .slice(0, 7)
    .forEach((t) => add(t.tier === "must" ? "must" : "should",
      `A section on ${t.label.toLowerCase()}. ${PLACEMENT[t.label] ? PLACEMENT[t.label].write : ""}`.trim(),
      `${t.count} of ${N} competitors cover it (${namesOf(t.sites)}).`,
      PLACEMENT[t.label] ? PLACEMENT[t.label].where : "Middle of the page"));
  add("must", `${c.targets.tables}+ data tables: ${isReport ? "market size by year, share by segment, share by region" : "the key numbers in the article"}.`,
    `Tables make figures easy to scan and quote. Competitors average ${fmtN((c.benchmarks.tables && c.benchmarks.tables.median) || 0)} tables.`,
    "Inside the size, segmentation and regional sections — as real HTML tables, not images.");
  const e = c.benchmarks.eeat || {};
  add("must", "Analyst byline, a “reviewed by” line, a short methodology box and a visible last-updated date.",
    `${e.author || 0}% of competitors show an author and ${e.methodology || 0}% a methodology. Google's people-first guidance asks who wrote it and how.`,
    "Byline under the H1; methodology box near the bottom.");
  const rank = { must: 0, should: 1, nice: 2 };
  return A.sort((a, b) => rank[a.priority] - rank[b.priority]);
}

function buildOutline(matrix, contentType, keyword) {
  const K = titleCase(keyword);
  const core = contentType === "blog"
    ? ["Market overview & definition", "Market trends & innovation", "FAQs"]
    : ["Market overview & definition", "Market size & forecast", "Market dynamics & growth drivers", "Segmentation overview",
       "Regional & country analysis", "Competitive landscape & key players", "Report scope & methodology", "FAQs"];
  const fromData = matrix.topics.filter((t) => t.tier !== "differentiator").map((t) => t.label);
  const labels = [...new Set([...core, ...fromData])].filter((l) => PLACEMENT[l]).sort((a, b) => ORDER(a) - ORDER(b)).slice(0, 14);
  return labels.map((l) => {
    const t = matrix.topics.find((x) => x.label === l);
    return { h2: PLACEMENT[l].h2(K), write: PLACEMENT[l].write, evidence: t ? `${t.count}/${matrix.pagesCompared} competitors` : "core section" };
  });
}

export function placeholderLen(t) {
  return String(t || "")
    .replace(/\[USD X\.X billion\]/gi, "USD 12.3 billion")
    .replace(/\[20XX[–-]20XX\]/g, "2026–2033")
    .replace(/\[20XX\]/g, "2033")
    .replace(/\[X\.X%\]/g, "9.5%").length;
}

function titleTemplates(keyword, contentType) {
  const K = titleCase(keyword);
  const list = contentType === "blog"
    ? [`${K}: Key Trends, Data & Outlook`, `${K} Explained: Drivers, Data & Outlook`, `${K}: What's Changing and Why`]
    : [`${K} Size, Share & Forecast [20XX–20XX]`, `${K} Size, Share & Trends [20XX–20XX]`,
       `${K} Report: Size & Growth [20XX–20XX]`, `${K} Size & Growth Forecast [20XX–20XX]`];
  return list.map((text) => ({ text, len: placeholderLen(text) }))
    .sort((a, b) => Math.abs(55 - a.len) - Math.abs(55 - b.len));
}

function metaTemplate(keyword, contentType) {
  const K = titleCase(keyword);
  const text = contentType === "blog"
    ? `${K}: what's driving growth, the key numbers, and what to watch next — explained with our latest research and analyst insight.`
    : `${K} valued at [USD X.X billion] in [20XX], set to reach [USD X.X billion] by [20XX] at a [X.X%] CAGR. See segments, regions and key players.`;
  return { text, len: placeholderLen(text) };
}

/* ===================== 8. Assemble ===================== */

const isListingPage = (p) => !!(p && p.signals && p.signals.isListing);

export function analyseSerp({ keyword, contentType, serp, pages, ourDomain, ourPage, ourUrl }) {
  const kw = keywordTokens(keyword);
  const warnings = [];
  if (serp.warning) warnings.push(serp.warning);

  const page1 = pages.filter((p) => p.page1);
  const offTracked = pages.filter((p) => !p.page1 && p.type === "tracked" && !p.manualExtra);
  const extraPages = pages.filter((p) => p.manualExtra);
  const ourRow = pages.find((p) => p.type === "ours" && p.position) || null;

  const comparable = (p) => p.fetched && p.xray && !isListingPage(p) && p.type !== "ours" && p.type !== "ugc" && p.xray.contentWords >= 250;
  let rankingSet = page1.filter(comparable);
  if (contentType === "report") {
    const mr = rankingSet.filter((p) => p.type === "tracked" || p.type === "publisher");
    if (mr.length >= 2) rankingSet = mr;
  }
  const analysisSet = uniqBy([...rankingSet, ...offTracked.filter(comparable), ...extraPages.filter(comparable)], (p) => p.link);
  // Length / table targets come only from pages we read in full (not ChatGPT summaries).
  const fullRead = (p) => p.via !== "ai-reader";
  const benchBase = rankingSet.filter(fullRead).length >= 2 ? rankingSet.filter(fullRead) : rankingSet;
  const benchSet = benchBase.length >= 2 ? benchBase : analysisSet.filter(fullRead).length ? analysisSet.filter(fullRead) : analysisSet;

  const unreadable = page1.filter((p) => !p.fetched && !p.skipped).length;
  if (unreadable) warnings.push(`${unreadable} of the top-10 pages couldn't be read, even through the fallback routes. Use “Paste page” on those rows to add them yourself.`);
  pages.filter((p) => p.fetched && p.via).forEach((p) => {
    if (p.via === "pasted") { warnings.push(`${displayName(p.domain)}: analysed from the page you pasted.`); return; }
    if (p.via === "ai-reader") {
      warnings.push(`${displayName(p.domain)} blocks every normal route, so ChatGPT read it through web search. Its headings and figures are AI-extracted — check them before relying on them; it's left out of the length targets.`);
      return;
    }
    const how = p.via === "archive" ? `an archive.org copy from ${p.archivedAt}` : p.via === "reader" ? "a reader service" : "your scraping service";
    warnings.push(`${displayName(p.domain)} blocks normal requests, so we read it through ${how}.${p.via === "archive" ? " Its figures may be older than the live page." : ""}`);
  });
  const listingPages = page1.filter(isListingPage);

  const topics = buildTopicMatrix(analysisSet, kw);
  topics.columns = orderColumns(analysisSet);

  const ourData =
    (ourPage && ourPage.fetched ? ourPage : null) ||
    (ourUrl ? pages.find((p) => p.fetched && sameUrl(p.link, ourUrl)) : null) ||
    pages.find((p) => p.type === "ours" && p.fetched) || null;
  if (ourData) markOurTopics(topics, ourData, kw);
  if (ourPage && !ourPage.fetched) warnings.push("We couldn't read your page, so the comparison with it is skipped.");

  const benchmarks = buildBenchmarks(benchSet);
  const targets = buildTargets(benchmarks, topics, contentType);
  const keywords = buildKeywords(keyword, analysisSet, serp);
  const competitors = buildCompetitorRows(keyword, page1, offTracked, extraPages, keywords);
  const cagrs = competitors.filter((x) => x.stats).map((x) => x.stats.cagr).filter(Number.isFinite);
  const ourSummary = ourData ? summariseOurPage(ourData) : null;

  const c = {
    version: 6,
    keyword, contentType, gl: serp.gl, hl: serp.hl, provider: serp.provider,
    generatedAt: new Date().toISOString(), policyBaseline: POLICY_BASELINE, ourDomain: ourDomain || null,
    serp: {
      organic: page1.map((p) => {
        const listing = isListingPage(p);
        return {
          position: p.position, title: p.title, link: p.link, domain: p.domain, name: displayName(p.domain), type: p.type,
          kind: listing ? "category" : "page",
          words: p.fetched && p.xray && !listing ? p.xray.contentWords : null,
          note: listing ? "category page" : p.fetched ? null : (p.skipped || (p.blocked ? "blocked" : "not read")),
          via: p.fetched ? p.via || null : null,
        };
      }),
      peopleAlsoAsk: serp.peopleAlsoAsk || [],
      relatedSearches: serp.relatedSearches || [],
      aiOverview: serp.aiOverview || null,
      listingCount: listingPages.length,
      listingSites: listingPages.map((p) => displayName(p.domain)),
    },
    ourRank: ourRow ? { position: ourRow.position, url: ourRow.link } : null,
    competitors,
    figures: {
      cagrMin: cagrs.length ? Math.min(...cagrs) : null,
      cagrMax: cagrs.length ? Math.max(...cagrs) : null,
      periods: consensus(analysisSet, (p) => (p.signals && p.signals.figures && p.signals.figures.period ? [p.signals.figures.period] : [])),
    },
    topics, keywords, benchmarks, targets,
    segments: consensus(analysisSet, (p) => p.signals && p.signals.segments),
    regions: consensus(analysisSet, (p) => p.signals && p.signals.regions),
    countries: consensus(analysisSet, (p) => p.signals && p.signals.countries, 15),
    regionClaims: {
      largest: consensus(analysisSet, (p) => (p.signals && p.signals.largestRegion ? [p.signals.largestRegion] : [])),
      fastest: consensus(analysisSet, (p) => (p.signals && p.signals.fastestRegion ? [p.signals.fastestRegion] : [])),
    },
    companies: companyConsensus(analysisSet),
    questions: buildQuestions(serp, analysisSet, kw),
    ourPage: ourSummary,
    gaps: ourSummary ? buildGaps(ourSummary, topics, benchmarks, targets) : null,
    rules: RULES,
    warnings,
  };
  c.actions = buildActions(c);
  c.outline = buildOutline(topics, contentType, keyword);
  c.titleTemplates = titleTemplates(keyword, contentType);
  c.metaTemplate = metaTemplate(keyword, contentType);
  return c;
}

function buildCompetitorRows(keyword, page1, offTracked, extraPages, keywords) {
  const rows = [];
  for (const t of BRIEF_TRACKED) {
    const p = page1.filter((r) => matchesDomain(r.domain, t.domain)).sort((a, b) => a.position - b.position)[0] ||
      offTracked.find((r) => matchesDomain(r.domain, t.domain)) ||
      { domain: t.domain, type: "tracked", page1: false, link: null, fetched: false, discovery: "No report found for this keyword" };
    rows.push(compRow(keyword, p, t.name, true, keywords));
  }
  page1
    .filter((p) => p.type === "publisher" || (p.type === "tracked" && !BRIEF_TRACKED.some((t) => matchesDomain(p.domain, t.domain))))
    .slice(0, 5)
    .forEach((p) => rows.push(compRow(keyword, p, displayName(p.domain), false, keywords)));
  extraPages.forEach((p) => rows.push(compRow(keyword, p, `${displayName(p.domain)} (added by you)`, false, keywords)));
  return rows;
}

function compRow(keyword, p, name, tracked, keywords) {
  const x = p.xray, s = p.signals || {};
  const listing = isListingPage(p) || p.kind === "category";
  const read = !!(p.fetched && x);
  const ok = read && !listing;
  const title = read ? (x.title || (x.h1List || [])[0] || "") : p.title || "";
  let note = null;
  if (listing) note = p.discovery || "Ranks with a category page (a list of reports), not a single report — not compared";
  else if (!ok) note = p.discovery || p.skipped || (p.blocked ? "Site blocked our reader and every fallback route" : p.link ? "Couldn't load the page" : "No report found for this keyword");
  return {
    domain: p.domain, name, tracked, onPage1: !!p.page1, position: p.position || null, link: p.link || null,
    title, fetched: ok, kind: listing ? "category" : "page", note, manual: !!p.manual,
    blocked: !ok && !!p.blocked,
    via: ok ? p.via || null : null, archivedAt: ok ? p.archivedAt || null : null,
    stats: ok ? {
      words: x.contentWords, sections: sectionHeadings(x.headingTree).length, tables: x.tables, faq: x.faqCount,
      cagr: s.figures && s.figures.cagr != null ? s.figures.cagr : null,
      values: (s.figures && s.figures.values) || [], period: (s.figures && s.figures.period) || null,
      lastUpdated: lastUpdatedOf(x, s), approx: p.via === "ai-reader",
    } : null,
    kwUse: read ? {
      title: kwMatch(keyword, x.title || ""),
      h1: (x.h1List || []).some((h) => kwMatch(keyword, h)),
      meta: kwMatch(keyword, x.metaDesc || ""),
    } : null,
    mainKeyword: read ? mainKeywordOf(title) : null,
    secondary: ok ? (keywords.perSite[p.domain] || []) : read ? ownPhrases(keyword, p.domain, x) : [],
  };
}

function mainKeywordOf(title) {
  let t = String(title || "").split(/\s[|–—]\s|\s-\s|\s\|\s?/)[0] || "";
  t = t.replace(/[,:]?\s*(?:\(?20\d{2}\s?(?:[-–]\s?20\d{2})?\)?)\s*$/, "").trim();
  return t.slice(0, 90);
}

function consensus(pages, getList, limit = 30) {
  const m = new Map();
  pages.forEach((p) => new Set(getList(p) || []).forEach((v) => m.set(v, (m.get(v) || 0) + 1)));
  return [...m.entries()].map(([label, count]) => ({ label, count })).sort((a, b) => b.count - a.count).slice(0, limit);
}

function companyConsensus(pages) {
  const m = new Map();
  pages.forEach((p) => {
    const seen = new Set();
    ((p.signals && p.signals.companies) || []).forEach((name) => {
      const k = companyKey(name);
      if (!k || seen.has(k)) return;
      seen.add(k);
      const r = m.get(k) || { name, count: 0, sites: [] };
      r.count++;
      r.sites.push(p.domain);
      m.set(k, r);
    });
  });
  return [...m.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)).slice(0, 30);
}

function buildQuestions(serp, pages, kw) {
  const out = [];
  const keys = [];
  const add = (question, source, snippet = "") => {
    const q = String(question || "").replace(/\s+/g, " ").replace(/^question\s*\d+\s*:\s*/i, "").trim();
    if (q.length < 8 || q.length > 200) return;
    const k = tokensOf(stripKeyword(q, kw)).sort().join(" ");
    if (!k || keys.some((x) => x === k || jaccard(x, k) >= 0.7)) return;
    keys.push(k);
    out.push({ question: q, source, snippet: String(snippet || "").slice(0, 280) });
  };
  (serp.peopleAlsoAsk || []).forEach((p) => add(p.question, "People Also Ask", p.snippet));
  const onTopic = (q) => !kw.length || kw.some((t) => q.toLowerCase().includes(stem(t)));
  pages.forEach((p) => {
    ((p.xray && p.xray.faqQuestions) || []).filter(onTopic).forEach((q) => add(q, `FAQ · ${displayName(p.domain)}`));
    ((p.signals && p.signals.questionHeadings) || []).filter(onTopic).forEach((q) => add(q, `Heading · ${displayName(p.domain)}`));
  });
  return out.slice(0, 20);
}

/* ===================== utils ===================== */

function stripKeyword(text, kw) {
  let t = " " + String(text || "").toLowerCase().replace(/&amp;/g, "&").replace(/[^a-z0-9.&?\s-]/g, " ") + " ";
  for (const k of kw) t = t.replace(new RegExp(`\\b${escapeRe(stem(k))}\\w*\\b`, "g"), " ");
  return t.replace(/\b(19|20)\d{2}\b/g, " ").replace(/\s+/g, " ").trim();
}
const tokensOf = (s) =>
  String(s || "").replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((w) => w.length > 2 && !HEAD_STOP.has(w) && !/^\d+$/.test(w));
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const titleCase = (s) => String(s || "").replace(/\b([a-z])/g, (m) => m.toUpperCase());
const fmtN = (n) => Number(n || 0).toLocaleString("en-US");
const truncate = (s, n) => { const t = String(s || ""); return t.length > n ? t.slice(0, n - 1) + "…" : t; };
const uniqBy = (arr, fn) => { const s = new Set(); return arr.filter((x) => { const k = fn(x); if (s.has(k)) return false; s.add(k); return true; }); };

function jaccard(a, b) {
  const A = new Set(String(a).split(" ").filter(Boolean));
  const B = new Set(String(b).split(" ").filter(Boolean));
  if (!A.size || !B.size) return 0;
  let inter = 0;
  A.forEach((x) => { if (B.has(x)) inter++; });
  return inter / (A.size + B.size - inter);
}

function lastUpdatedOf(x, s) {
  const d = ((x && x.schemaDetail) || []).map((b) => b.dateModified || b.datePublished).find(Boolean);
  if (d) return String(d).slice(0, 10);
  return (s && s.lastUpdated) || null;
}

function pathOf(u) {
  try { const x = new URL(u); return x.pathname + x.search; }
  catch { return String(u || ""); }
}

function normUrl(u) {
  try {
    const x = new URL(u);
    return (x.hostname.replace(/^www\./, "") + x.pathname.replace(/\/+$/, "")).toLowerCase();
  } catch { return String(u || "").toLowerCase(); }
}
export const sameUrl = (a, b) => !!a && !!b && normUrl(a) === normUrl(b);

function domainOf(u) {
  try { return new URL(u).hostname.replace(/^www\./, "").toLowerCase(); }
  catch { return ""; }
}
