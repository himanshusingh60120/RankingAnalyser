// lib/brief.js
// CONTENT BRIEF engine (v2) — built for research analysts, not SEO specialists.
//   1. Google top 10 for the keyword in the chosen country, plus ranks 11–20
//   2. ALWAYS analyses the tracked competitors (MarketsandMarkets, MRFR, Precedence Research,
//      Future Market Insights, Fortune Business Insights) — even when they're not on page 1
//   3. Reads every page: length, sections, tables, FAQs, market figures, keyword usage
//   4. Pulls out the primary + secondary keywords competitors target, and where they use them
//   5. Turns it into a short "what · why · where" action list, an outline and title templates
// Deterministic: the brief still works when the AI step is off.

import * as cheerio from "cheerio";
import { fetchPage } from "./fetcher.js";
import { xray } from "./xray.js";
import { COMPETITOR_SITES, keywordTokens, keywordMatches } from "./competitors.js";
import { searchGoogle } from "./serp.js";
import { POLICY_BASELINE } from "./google-policy.js";

/* ===================== 1. Competitors & site types ===================== */

// Always analysed, even when they're outside Google's top 10.
// "Future business insights" could mean either of the last two, so both are tracked.
export const BRIEF_TRACKED = [
  { domain: "marketsandmarkets.com", name: "MarketsandMarkets", short: "M&M" },
  { domain: "marketresearchfuture.com", name: "MRFR", short: "MRFR" },
  { domain: "precedenceresearch.com", name: "Precedence Research", short: "Precedence" },
  { domain: "futuremarketinsights.com", name: "Future Market Insights", short: "FMI" },
  { domain: "fortunebusinessinsights.com", name: "Fortune Business Insights", short: "Fortune BI" },
];

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
  "theinsightpartners.com", "insightaceanalytic.com",
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

const TRACKED_DOMAINS = [...new Set([...BRIEF_TRACKED.map((t) => t.domain), ...COMPETITOR_SITES])];
const matchesDomain = (d, base) => !!d && !!base && (d === base || d.endsWith("." + base));
const inList = (d, list) => list.some((x) => matchesDomain(d, x));

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

export async function collectSerpPages(serp, { ourDomain = null, maxPages = 10 } = {}) {
  const keyword = serp.query || "";
  const contentType = REPORT_KW_RE.test(keyword) ? "report" : "blog";
  const rows = (serp.organic || []).slice(0, maxPages)
    .map((r) => ({ ...r, type: classifyDomain(r.domain, ourDomain), page1: true }));

  // Start reading the top 10 immediately.
  const page1Job = Promise.all(rows.map(loadRow));

  // Ranks 11–20 (one extra SERP call): tells us where tracked sites and you rank.
  const page2 = await withDeadline(
    searchGoogle(keyword, { gl: serp.gl, hl: serp.hl, num: 10, page: 2 }).catch(() => null), 8000, null);
  const ranks11to20 = (page2?.organic || []).map((r) => ({ ...r, type: classifyDomain(r.domain, ourDomain) }));

  // Tracked competitors that aren't in the top 10 — find and read their page anyway.
  const missing = BRIEF_TRACKED.filter((t) => !rows.some((r) => matchesDomain(r.domain, t.domain)));
  const trackedJob = Promise.all(missing.map((t) =>
    withDeadline(discoverTracked(t, keyword, contentType, serp, ranks11to20), 30000, {
      domain: t.domain, type: "tracked", page1: false, position: null, link: null, fetched: false,
      discovery: "Search timed out",
    })));

  // Your own page if it ranks 11–20.
  const ourP2 = ourDomain && !rows.some((r) => r.type === "ours") ? ranks11to20.find((r) => r.type === "ours") : null;
  const ourJob = ourP2 ? loadRow({ ...ourP2, page1: false }) : Promise.resolve(null);

  const [page1, tracked, our] = await Promise.all([page1Job, trackedJob, ourJob]);
  return [...page1, ...tracked, ...(our ? [our] : [])];
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
    24000,
    { status: 0, html: "", blocked: false, error: "timeout" }
  );
  const x = xray(url, f.status, f.html);
  if (!x.fetched) return { fetched: false, blocked: !!f.blocked, status: f.status || 0 };
  let signals = {};
  try { signals = extractSignals(f.html); } catch { /* best effort */ }
  return { fetched: true, status: f.status, xray: x, signals };
}

function withDeadline(promise, ms, fallback) {
  let t;
  return Promise.race([
    promise.finally(() => clearTimeout(t)),
    new Promise((resolve) => { t = setTimeout(() => resolve(fallback), ms); }),
  ]);
}

async function discoverTracked(t, keyword, contentType, serp, ranks11to20) {
  const base = { domain: t.domain, type: "tracked", page1: false, position: null, title: "", snippet: "", link: null };
  try {
    let link = null, position = null, title = "", method = null, page = null;

    // 1. Already ranking 11–20?
    const inTop20 = ranks11to20.find((r) => matchesDomain(r.domain, t.domain));
    if (inTop20) { link = inTop20.link; position = inTop20.position; title = inTop20.title; method = "google"; }

    // 2. Search their site for the keyword (prefer report pages over blogs / press releases).
    if (!link) {
      const s = await searchGoogle(`${keyword} site:${t.domain}`, { gl: serp.gl, hl: serp.hl, num: 10 }).catch(() => null);
      const hits = (s?.organic || []).filter((r) => matchesDomain(r.domain, t.domain) && keywordMatches(keyword, r.link, r.title));
      const best = contentType === "report" ? (hits.find((r) => !NON_REPORT_PATH_RE.test(r.link)) || hits[0]) : hits[0];
      if (best) { link = best.link; title = best.title; method = "site-search"; }
    }

    // 3. Predictable report URL patterns.
    if (!link && contentType === "report") {
      const probe = await slugProbe(keyword, t.domain);
      if (probe) { link = probe.link; page = probe.page; method = "slug-probe"; }
    }

    if (!link) return { ...base, fetched: false, discovery: "No page found for this keyword" };
    if (!page) page = await loadPage(link);
    if (page.fetched && method !== "google" &&
        !keywordMatches(keyword, "", page.xray.title) && !keywordMatches(keyword, link, "")) {
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
};

async function slugProbe(keyword, domain) {
  const make = SLUG_URL[domain];
  const slug = String(keyword || "").toLowerCase().replace(/[^a-z0-9\s-]/g, " ").split(/[\s-]+/)
    .filter((w) => w && !["market", "markets", "report", "size", "share", "industry", "global", "analysis", "forecast"].includes(w))
    .join("-");
  if (!make || !slug) return null;
  const link = make(slug);
  const page = await loadPage(link);
  if (!page.fetched || !keywordMatches(keyword, "", page.xray.title)) return null;
  return { link, page };
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
  /\bby\s+(product\s+type|type|product|application|end[\s-]?use(?:rs?)?|end[\s-]?users?|industry\s+vertical|vertical|industry|component|technology|deployment(?:\s+mode)?|distribution\s+channel|sales\s+channel|channel|material|form|source|grade|capacity|organi[sz]ation\s+size|enterprise\s+size|offering|service|solution|platform|vehicle\s+type|packaging|category|function|indication|route\s+of\s+administration|modality|region|geography)\b/gi;

const MONTH = "(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\\.?";
const DATE_TXT_RE = new RegExp(
  `(?:last updated|updated on|updated|published on|published)\\s*:?\\s*(${MONTH}\\s+\\d{1,2},?\\s+20\\d{2}|\\d{1,2}\\s+${MONTH},?\\s+20\\d{2}|20\\d{2}-\\d{2}-\\d{2}|${MONTH}\\s+20\\d{2})`,
  "i"
);

const PLAYER_HEAD_RE =
  /\b(key|major|leading|prominent|top|prime|notable)\s+(?:market\s+)?(?:players|companies|vendors|manufacturers|participants|suppliers)\b|competitive landscape|company profiles|companies (?:covered|profiled)|list of (?:key )?companies/i;

export function extractSignals(html) {
  const $ = cheerio.load(html);
  $("script, style, noscript, svg").remove();
  const heads = [];
  $("h1, h2, h3, h4").each((_, el) => {
    const t = $(el).text().replace(/\s+/g, " ").trim();
    if (t && t.length < 200) heads.push(t);
  });
  const headText = heads.join(" | ");
  const body = $("body").text().replace(/\s+/g, " ").slice(0, 80000);
  return {
    figures: extractFigures(body),
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
  const values = [...new Set((text.match(VAL_RE) || []).map((s) => s.replace(/\s+/g, " ").trim()))].slice(0, 4);
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
  return { values, cagr, period };
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

function cleanCompany(raw) {
  let t = String(raw || "").replace(/\s+/g, " ").trim();
  t = t.replace(/\([^)]*\)/g, "").replace(/\s[–—-]\s.*$/, "").replace(/:.*$/, "").replace(/[.,;]+$/, "").trim();
  if (t.length < 2 || t.length > 60) return "";
  const words = t.split(" ").length;
  if (words > 7) return "";
  if (!/[A-Za-z]/.test(t) || /https?:|www\.|^(and|others?|etc\.?|more|other key players)$/i.test(t)) return "";
  if (/^[a-z]/.test(t) && words > 3) return "";
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
  /related (?:reports?|articles?|posts?|news)|request (?:a |for )?(?:free )?sample|why choose|our clients|testimonial|contact us|buy now|licen[cs]e|subscribe|newsletter|need help|get in touch|download|enquir|inquir|customi[sz]ation|share this|follow us|trusted by|you may also|recently viewed|popular reports?|latest reports?|our (?:services|offerings)|cookie|table of contents|report description|speak to|talk to|ask an analyst|payment|checkout/i;

const HEAD_STOP = new Set(["market", "markets", "global", "report", "reports", "the", "of", "and", "in", "for", "to", "by",
  "a", "an", "on", "with", "its", "what", "is", "are", "how", "does", "do", "which", "who", "why", "will", "key",
  "analysis", "industry", "share", "size", "outlook", "vs"]);

// First match wins (specific before generic).
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

// Where each section goes, its H2 wording, and what to write in it.
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
  return cols.slice(0, 8);
}

/* ===================== 5. Keywords ===================== */

const KW_STOP = new Set(["the", "of", "and", "in", "for", "to", "by", "a", "an", "on", "with", "its", "is", "are", "what",
  "how", "which", "who", "why", "will", "from", "at", "as", "or", "vs", "into", "&", "your", "our", "their", "this", "that",
  "these", "those", "be", "can", "do", "does", "per", "more", "most", "new", "top", "best", "get", "all", "you", "we", "it"]);
const MODIFIERS = new Set(["market", "markets", "size", "share", "growth", "trends", "trend", "forecast", "analysis", "outlook",
  "demand", "revenue", "cagr", "players", "companies", "segmentation", "segment", "segments", "regional", "region", "opportunities",
  "opportunity", "drivers", "driver", "industry", "report", "statistics", "value", "volume", "insights", "research", "landscape",
  "competitive", "applications", "application", "types", "type", "overview", "scope", "global", "key", "future", "latest"]);
const BRAND_SAFE = new Set(["future", "business", "global", "group", "market", "markets", "the"]);
const MAX_GRAM = 6;

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

function whereToUse(r, N) {
  if (r.inTitle >= Math.max(2, Math.ceil(N * 0.4))) return "Title tag + H1";
  if (r.inTitle >= 1 && r.inMeta >= 1) return "Title or meta description";
  if (r.inMeta >= 2) return "Meta description + opening paragraph";
  if (r.inHeading >= 2) return "H2 / H3 heading";
  return "Body text";
}

function buildKeywords(keyword, pages, serp) {
  const kwTok = keywordTokens(keyword);
  const kwNorm = normPhrase(keyword);
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
  const minRelated = Math.max(2, Math.ceil(N * 0.4));
  const isSubOfKw = (ph) => (" " + kwNorm + " ").includes(" " + ph + " ");
  const genericOnly = (toks) => toks.every((t) => MODIFIERS.has(t) || KW_STOP.has(t));

  const cands = [...agg.values()]
    .map((r) => ({ phrase: r.phrase, count: r.sites.size, sites: [...r.sites], inTitle: r.title.size, inMeta: r.meta.size, inHeading: r.heading.size }))
    .filter((r) => {
      if (r.phrase === kwNorm || isSubOfKw(r.phrase)) return false;
      const toks = r.phrase.split(" ");
      if (genericOnly(toks)) return false;
      r.variant = kwTok.length > 0 && kwTok.every((t) => toks.includes(t));
      return r.variant ? r.count >= Math.min(2, N) : r.count >= minRelated;
    })
    .sort((a, b) => b.count - a.count || b.phrase.length - a.phrase.length);

  // Drop fragments of longer phrases that are used just as often.
  const kept = [];
  for (const c of cands) {
    if (kept.some((k) => (" " + k.phrase + " ").includes(" " + c.phrase + " ") && k.count >= c.count)) continue;
    kept.push(c);
    if (kept.length >= 40) break;
  }
  kept.sort((a, b) => (Number(b.variant) - Number(a.variant)) || b.count - a.count);

  const secondary = kept.slice(0, 12).map((r) => ({
    phrase: r.phrase, count: r.count, of: N, sites: r.sites, names: r.sites.map(displayName),
    where: whereToUse(r, N), variant: r.variant,
  }));
  const google = [
    ...(serp.relatedSearches || []).slice(0, 8).map((q) => ({ phrase: q, source: "Google related search", where: "Body text or an H2" })),
    ...(serp.peopleAlsoAsk || []).slice(0, 6).map((p) => ({ phrase: p.question, source: "People Also Ask", where: "FAQ question (use this wording)" })),
  ];
  const perSiteTop = {};
  for (const [domain, set] of perSite) perSiteTop[domain] = kept.filter((k) => set.has(k.phrase)).slice(0, 5).map((k) => k.phrase);

  const pct = (fn) => Math.round((pages.filter(fn).length / N) * 100);
  return {
    primary: {
      phrase: keyword,
      where: "Title tag, H1, URL, first sentence and meta description",
      inTitlePct: pct((p) => keywordMatches(keyword, "", p.xray.title)),
      inH1Pct: pct((p) => (p.xray.h1List || []).some((h) => keywordMatches(keyword, "", h))),
      inMetaPct: pct((p) => keywordMatches(keyword, "", p.xray.metaDesc || "")),
    },
    secondary,
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
    internalLinks: Math.min(20, Math.max(isBlog ? 3 : 4, Math.round(((ratio * lo) / 1000) * 1.15))),
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

  c.topics.topics
    .filter((t) => t.tier !== "differentiator" && t.ours !== true && !["FAQs", "Report scope & methodology"].includes(t.label))
    .slice(0, 7)
    .forEach((t) => add(t.tier === "must" ? "must" : "should",
      `A section on ${t.label.toLowerCase()}. ${PLACEMENT[t.label] ? PLACEMENT[t.label].write : ""}`.trim(),
      `${t.count} of ${N} competitors cover it (${namesOf(t.sites)}).`,
      PLACEMENT[t.label] ? PLACEMENT[t.label].where : "Middle of the page"));

  if (c.segments.length) {
    add("should", `Split the market by ${c.segments.slice(0, 4).map((s) => s.label.toLowerCase()).join(", ")}.`,
      `These are the splits competitors use (${c.segments.slice(0, 4).map((s) => `${s.label} ${s.count}/${N}`).join(", ")}).`,
      "Segmentation section — one H3 per split, each with a share table.");
  }
  if (c.regions.length) {
    add("should", `Regional breakdown: ${c.regions.map((r) => r.label).join(", ")}${c.countries.length ? `, plus key countries (${c.countries.slice(0, 4).map((x) => x.label).join(", ")})` : ""}.`,
      `${c.regions[0].count} of ${N} competitors have regional sections${c.regionClaims.largest[0] ? `; ${c.regionClaims.largest[0].label} is most often called the largest region` : ""}.`,
      "After the segmentation section.");
  }
  add("must", `${c.targets.tables}+ data tables: ${isReport ? "market size by year, share by segment, share by region" : "the key numbers in the article"}.`,
    `Tables make figures easy to scan and quote. Competitors average ${fmtN((c.benchmarks.tables && c.benchmarks.tables.median) || 0)} tables.`,
    "Inside the size, segmentation and regional sections — as real HTML tables, not images.");
  if (c.companies.length) {
    add("should", `Profile these companies: ${c.companies.slice(0, 8).map((x) => x.name).join(", ")}.`,
      "They appear in competitors' key-player lists, so buyers expect to see them.",
      "Competitive landscape section — 2–3 lines each: offering and latest move.");
  }
  const paa = c.questions.filter((q) => q.source === "People Also Ask").map((q) => q.question);
  const compQ = c.questions.filter((q) => q.source !== "People Also Ask").map((q) => q.question);
  const faqQs = [...paa, ...compQ].slice(0, 5);
  if (faqQs.length) {
    add("must", `FAQs answering: ${faqQs.map((q) => `“${q}”`).join(" · ")}`,
      paa.length ? `Google shows ${paa.length} of these in "People Also Ask" for this search.` : "Competitors answer these questions on their pages.",
      "FAQ section at the end — visible on the page, 2–3 sentence answers.");
  }
  const sk = c.keywords.secondary.slice(0, 5).map((k) => k.phrase);
  if (sk.length) {
    add("should", `Use these secondary keywords naturally: ${sk.map((s) => `“${s}”`).join(", ")}.`,
      `Competitors use them in their titles and headings (top phrase on ${c.keywords.secondary[0].count} of ${c.keywords.secondary[0].of} sites).`,
      "Title/meta, H2 headings and body — see the Keywords table for exact placement.");
  }
  const e = c.benchmarks.eeat || {};
  add("must", "Analyst byline, a “reviewed by” line, a short methodology box and a visible last-updated date.",
    `${e.author || 0}% of competitors show an author and ${e.methodology || 0}% a methodology. Google's people-first guidance asks who wrote it and how.`,
    "Byline under the H1; methodology box near the bottom.");
  add("should", "One thing no competitor has: primary-interview quotes, a pricing analysis, or a best/worst-case forecast.",
    "Google's 2026 guidance rewards original, non-commodity content over pages that repeat what others say.",
    "Its own H2, after market dynamics.");
  if (c.ourPage && c.gaps && c.gaps.items.length) {
    add("must", `Fix your current page: ${c.gaps.items.slice(0, 3).join(" ")}`, "These are the biggest gaps between your page and the competitors.", "Your existing page — update it rather than publishing a new one.");
  }
  add("nice", `${c.targets.internalLinks} links to related Kings Research reports and blogs.`,
    "Helps readers explore and helps Google understand how your reports connect.",
    "Inside sentences in the relevant sections (not as a link list).");

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

export function analyseSerp({ keyword, contentType, serp, pages, ourDomain, ourPage, ourUrl }) {
  const kw = keywordTokens(keyword);
  const warnings = [];
  if (serp.warning) warnings.push(serp.warning);

  const page1 = pages.filter((p) => p.page1);
  const offTracked = pages.filter((p) => !p.page1 && p.type === "tracked");
  const ourRow = pages.find((p) => p.type === "ours" && p.position) || null;

  const comparable = (p) => p.fetched && p.xray && p.type !== "ours" && p.type !== "ugc" && p.xray.contentWords >= 250;
  let rankingSet = page1.filter(comparable);
  if (contentType === "report") {
    const mr = rankingSet.filter((p) => p.type === "tracked" || p.type === "publisher");
    if (mr.length >= 2) rankingSet = mr;
  }
  const analysisSet = uniqBy([...rankingSet, ...offTracked.filter(comparable)], (p) => p.link);
  const benchSet = rankingSet.length >= 2 ? rankingSet : analysisSet;

  const unreadable = page1.filter((p) => !p.fetched && !p.skipped).length;
  if (unreadable) warnings.push(`${unreadable} of the top-10 pages blocked our reader, so they're listed but not analysed.`);

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
  const competitors = buildCompetitorRows(keyword, page1, offTracked, keywords);
  const cagrs = competitors.filter((x) => x.stats).map((x) => x.stats.cagr).filter(Number.isFinite);
  const ourSummary = ourData ? summariseOurPage(ourData) : null;

  const c = {
    version: 2,
    keyword, contentType, gl: serp.gl, hl: serp.hl, provider: serp.provider,
    generatedAt: new Date().toISOString(), policyBaseline: POLICY_BASELINE, ourDomain: ourDomain || null,
    serp: {
      organic: page1.map((p) => ({
        position: p.position, title: p.title, link: p.link, domain: p.domain, name: displayName(p.domain), type: p.type,
        words: p.fetched && p.xray ? p.xray.contentWords : null,
        note: p.fetched ? null : (p.skipped || (p.blocked ? "blocked" : "not read")),
      })),
      peopleAlsoAsk: serp.peopleAlsoAsk || [],
      relatedSearches: serp.relatedSearches || [],
      aiOverview: serp.aiOverview || null,
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

function buildCompetitorRows(keyword, page1, offTracked, keywords) {
  const rows = [];
  for (const t of BRIEF_TRACKED) {
    const p = page1.filter((r) => matchesDomain(r.domain, t.domain)).sort((a, b) => a.position - b.position)[0] ||
      offTracked.find((r) => matchesDomain(r.domain, t.domain)) ||
      { domain: t.domain, type: "tracked", page1: false, link: null, fetched: false, discovery: "No page found for this keyword" };
    rows.push(compRow(keyword, p, t.name, true, keywords));
  }
  page1
    .filter((p) => p.type === "publisher" || (p.type === "tracked" && !BRIEF_TRACKED.some((t) => matchesDomain(p.domain, t.domain))))
    .slice(0, 5)
    .forEach((p) => rows.push(compRow(keyword, p, displayName(p.domain), false, keywords)));
  return rows;
}

function compRow(keyword, p, name, tracked, keywords) {
  const x = p.xray, s = p.signals || {};
  const ok = !!(p.fetched && x);
  return {
    domain: p.domain, name, tracked, onPage1: !!p.page1, position: p.position || null, link: p.link || null,
    title: (ok && x.title) || p.title || "", fetched: ok,
    note: ok ? null : (p.discovery || p.skipped || (p.blocked ? "Site blocked our reader" : p.link ? "Couldn't load the page" : "No page found for this keyword")),
    stats: ok ? {
      words: x.contentWords, sections: sectionHeadings(x.headingTree).length, tables: x.tables, faq: x.faqCount,
      cagr: s.figures && s.figures.cagr != null ? s.figures.cagr : null,
      values: (s.figures && s.figures.values) || [], period: (s.figures && s.figures.period) || null,
      lastUpdated: lastUpdatedOf(x, s),
    } : null,
    kwUse: ok ? {
      title: keywordMatches(keyword, "", x.title),
      h1: (x.h1List || []).some((h) => keywordMatches(keyword, "", h)),
      meta: keywordMatches(keyword, "", x.metaDesc || ""),
    } : null,
    mainKeyword: ok ? mainKeywordOf(x.title) : null,
    secondary: ok ? (keywords.perSite[p.domain] || []) : [],
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
    const q = String(question || "").replace(/\s+/g, " ").trim();
    if (q.length < 8 || q.length > 200) return;
    const k = tokensOf(stripKeyword(q, kw)).sort().join(" ");
    if (!k || keys.some((x) => x === k || jaccard(x, k) >= 0.7)) return;
    keys.push(k);
    out.push({ question: q, source, snippet: String(snippet || "").slice(0, 280) });
  };
  (serp.peopleAlsoAsk || []).forEach((p) => add(p.question, "People Also Ask", p.snippet));
  const onTopic = (q) => !kw.length || kw.some((t) => q.toLowerCase().includes(t));
  pages.forEach((p) => {
    ((p.xray && p.xray.faqQuestions) || []).filter(onTopic).forEach((q) => add(q, `FAQ · ${displayName(p.domain)}`));
    ((p.signals && p.signals.questionHeadings) || []).filter(onTopic).forEach((q) => add(q, `Heading · ${displayName(p.domain)}`));
  });
  return out.slice(0, 20);
}

/* ===================== utils ===================== */

function stripKeyword(text, kw) {
  let t = " " + String(text || "").toLowerCase().replace(/&amp;/g, "&").replace(/[^a-z0-9.&?\s-]/g, " ") + " ";
  for (const k of kw) t = t.replace(new RegExp(`\\b${escapeRe(k)}s?\\b`, "g"), " ");
  return t.replace(/\b(19|20)\d{2}\b/g, " ").replace(/\s+/g, " ").trim();
}
const tokensOf = (s) =>
  String(s || "").replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((w) => w.length > 2 && !HEAD_STOP.has(w) && !/^\d+$/.test(w));
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const titleCase = (s) => String(s || "").replace(/\b([a-z])/g, (m) => m.toUpperCase());
const fmtN = (n) => Number(n || 0).toLocaleString("en-US");
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
