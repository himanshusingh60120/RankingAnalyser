// lib/brief.js
// CONTENT BRIEF engine: a keyword's live Google page 1 -> data-backed brief inputs.
//   1. classify each page-1 result (you / tracked competitor / other publisher / authority / press / news)
//   2. fetch + X-ray each result with the same pipeline /api/analyze uses
//   3. pull market-research signals per page (figures, segmentation, regions, companies, dates)
//   4. cluster section headings into a topic-coverage matrix (must / should / differentiator)
//   5. compute benchmarks, targets and gaps vs your page
// All deterministic, so the brief still works when the AI step is off.

import * as cheerio from "cheerio";
import { fetchPage } from "./fetcher.js";
import { xray } from "./xray.js";
import { COMPETITOR_SITES, keywordTokens } from "./competitors.js";
import { GOOGLE_POLICY, POLICY_BASELINE } from "./google-policy.js";

/* ===================== 1. Domain classification ===================== */

const PUBLISHERS = [
  "kingsresearch.com", "grandviewresearch.com", "fortunebusinessinsights.com", "mordorintelligence.com",
  "imarcgroup.com", "alliedmarketresearch.com", "researchandmarkets.com", "marketresearch.com",
  "gminsights.com", "straitsresearch.com", "verifiedmarketresearch.com", "verifiedmarketreports.com",
  "databridgemarketresearch.com", "coherentmarketinsights.com", "transparencymarketresearch.com",
  "factmr.com", "technavio.com", "expertmarketresearch.com", "businessresearchinsights.com",
  "thebusinessresearchcompany.com", "snsinsider.com", "skyquestt.com", "zionmarketresearch.com",
  "emergenresearch.com", "polarismarketresearch.com", "reportsanddata.com", "kbvresearch.com",
  "marketdataforecast.com", "credenceresearch.com", "maximizemarketresearch.com",
  "cognitivemarketresearch.com", "sphericalinsights.com", "towardshealthcare.com", "novaoneadvisor.com",
  "custommarketinsights.com", "marketresearchintellect.com", "globalgrowthinsights.com",
  "statista.com", "ibisworld.com", "mintel.com", "euromonitor.com", "frost.com", "idc.com", "gartner.com",
];
const PRESS = ["globenewswire.com", "prnewswire.com", "businesswire.com", "einpresswire.com", "openpr.com",
  "newswire.com", "accesswire.com", "prweb.com", "issuewire.com", "whatech.com"];
const NEWS = ["reuters.com", "bloomberg.com", "forbes.com", "cnbc.com", "ft.com", "wsj.com", "marketwatch.com",
  "finance.yahoo.com", "economictimes.indiatimes.com", "business-standard.com", "livemint.com", "thehindubusinessline.com"];
const UGC = ["linkedin.com", "medium.com", "reddit.com", "quora.com", "youtube.com", "scribd.com", "slideshare.net", "issuu.com"];
const AUTHORITY_RE =
  /(\.gov|\.gov\.[a-z]{2}|\.gouv\.[a-z]{2}|\.edu|\.edu\.[a-z]{2}|\.ac\.[a-z]{2}|\.int|\.mil)$|^gov\.[a-z]{2}$|(^|\.)(europa\.eu|worldbank\.org|oecd\.org|iea\.org|un\.org|imf\.org|wto\.org|irena\.org)$/;

export const TYPE_LABEL = {
  ours: "You", tracked: "Tracked competitor", publisher: "Research publisher", authority: "Gov / authority",
  press: "Press release", news: "News / media", ugc: "UGC / social", other: "Other",
};

const inList = (d, list) => list.some((x) => d === x || d.endsWith("." + x));

export function classifyDomain(domain, ourDomain) {
  const d = String(domain || "").toLowerCase();
  if (!d) return "other";
  if (ourDomain && (d === ourDomain || d.endsWith("." + ourDomain))) return "ours";
  if (inList(d, COMPETITOR_SITES)) return "tracked";
  if (inList(d, PUBLISHERS)) return "publisher";
  if (inList(d, PRESS)) return "press";
  if (AUTHORITY_RE.test(d)) return "authority";
  if (inList(d, NEWS)) return "news";
  if (inList(d, UGC)) return "ugc";
  return "other";
}

/* ===================== 2. Fetch + X-ray page 1 ===================== */

export async function collectSerpPages(serp, { ourDomain = null, maxPages = 10 } = {}) {
  const rows = (serp.organic || []).slice(0, maxPages).map((r) => ({ ...r, type: classifyDomain(r.domain, ourDomain) }));
  return Promise.all(
    rows.map(async (r) => {
      if (!/^https?:\/\//i.test(r.link)) return { ...r, fetched: false, skipped: "Not a web page" };
      if (/\.(pdf|docx?|xlsx?|pptx?)(\?|$)/i.test(r.link)) return { ...r, fetched: false, skipped: "Document file (PDF/Office) — not analysed" };
      if (/(^|\.)youtube\.com$/.test(r.domain)) return { ...r, fetched: false, skipped: "Video result — not analysed" };
      return { ...r, ...(await loadPage(r.link)) };
    })
  );
}

export async function fetchOurPage(url) {
  return { link: url, domain: domainOf(url), position: null, type: "ours", ...(await loadPage(url)) };
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
  if (/^end use|end user/.test(l)) return "End use / end user";
  if (/vertical|industry/.test(l)) return "Industry / vertical";
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
    // Heading wrapped in its own div (common on report templates): look past the wrapper.
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
  if (/^[a-z]/.test(t) && words > 3) return ""; // a sentence/description, not a company name
  return t;
}

function companyKey(name) {
  return String(name || "")
    .toLowerCase()
    .replace(/\b(inc|incorporated|ltd|limited|llc|plc|corp|corporation|co|company|gmbh|ag|s\.?a|n\.?v|b\.?v|s\.?p\.?a|holdings?|group|international|industries)\b\.?/g, "")
    .replace(/[^a-z0-9]/g, "");
}

/* ===================== 4. Topic coverage matrix ===================== */

const SKIP_HEAD_RE =
  /related (?:reports?|articles?|posts?|news)|request (?:a |for )?(?:free )?sample|why choose|our clients|testimonial|contact us|buy now|licen[cs]e|subscribe|newsletter|need help|get in touch|download|enquir|inquir|customi[sz]ation|share this|follow us|trusted by|you may also|recently viewed|popular reports?|latest reports?|our (?:services|offerings)|cookie|table of contents|report description|speak to|talk to|ask an analyst|payment|checkout/i;

const HEAD_STOP = new Set(["market", "markets", "global", "report", "reports", "the", "of", "and", "in", "for", "to", "by",
  "a", "an", "on", "with", "its", "what", "is", "are", "how", "does", "do", "which", "who", "why", "will", "key",
  "analysis", "industry", "share", "size", "outlook", "vs"]);

// Order matters: first match wins (specific before generic).
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

// The level each page uses for its main sections (H2 if it has enough, else H3).
function sectionHeadings(tree = []) {
  const h2 = tree.filter(([l]) => l === 2).map(([, t]) => t);
  const h3 = tree.filter(([l]) => l === 3).map(([, t]) => t);
  const list = h2.length >= 4 ? h2 : h3.length >= 4 ? h3 : [...h2, ...h3];
  return list
    .map((t) => String(t).replace(/\s+/g, " ").trim())
    .filter((t) => t && t.length <= 160 && !SKIP_HEAD_RE.test(t));
}

function topicOf(heading, kw) {
  const stripped = stripKeyword(heading, kw);
  for (const [label, re] of TOPIC_RULES) if (re.test(stripped)) return { label, canonical: true, key: "" };
  const key = tokensOf(stripped).join(" ");
  if (!key) return null;
  return { label: titleCase(key), canonical: false, key };
}

function buildTopicMatrix(pages, kw) {
  const topics = new Map();
  for (const p of pages) {
    const heads = sectionHeadings(p.xray.headingTree);
    const seen = new Set();
    heads.forEach((h, idx) => {
      const t = topicOf(h, kw);
      if (!t) return;
      let label = t.label;
      if (!t.canonical) {
        const near = [...topics.values()].find((x) => !x.canonical && jaccard(x.key, t.key) >= 0.5);
        if (near) label = near.label;
      }
      if (!topics.has(label)) {
        topics.set(label, { label, canonical: t.canonical, key: t.key, links: new Set(), sites: new Set(), examples: [], posSum: 0, posN: 0 });
      }
      const rec = topics.get(label);
      if (!seen.has(label)) {
        seen.add(label);
        rec.links.add(p.link);
        rec.sites.add(p.domain);
        rec.posSum += heads.length > 1 ? idx / (heads.length - 1) : 0;
        rec.posN++;
      }
      if (rec.examples.length < 4 && !rec.examples.includes(h)) rec.examples.push(h);
    });
  }
  const n = pages.length;
  const mustMin = Math.max(2, Math.ceil(n * 0.5));
  const tierRank = { must: 0, should: 1, differentiator: 2 };
  const list = [...topics.values()].map((t) => {
    const count = t.links.size;
    return {
      label: t.label, canonical: t.canonical, key: t.key, count,
      sites: [...t.sites], examples: t.examples,
      avgPos: t.posN ? +(t.posSum / t.posN).toFixed(2) : 1,
      tier: count >= mustMin ? "must" : count >= 2 ? "should" : "differentiator",
    };
  });
  list.sort((a, b) => tierRank[a.tier] - tierRank[b.tier] || b.count - a.count || a.avgPos - b.avgPos);
  return {
    pagesCompared: n,
    mustMin,
    topics: [...list.filter((t) => t.tier !== "differentiator"), ...list.filter((t) => t.tier === "differentiator").slice(0, 25)],
  };
}

function markOurTopics(matrix, ourPage, kw) {
  const heads = (ourPage.xray.headingTree || []).filter(([l]) => l === 2 || l === 3).map(([, t]) => t);
  const labels = new Set();
  const keys = [];
  for (const h of heads) {
    const t = topicOf(h, kw);
    if (!t) continue;
    if (t.canonical) labels.add(t.label);
    else keys.push(t.key);
  }
  matrix.topics.forEach((t) => {
    t.ours = t.canonical ? labels.has(t.label) : keys.some((k) => jaccard(k, t.key) >= 0.5);
  });
}

/* ===================== 5. Benchmarks, targets, gaps ===================== */

function stats(nums) {
  const a = nums.filter(Number.isFinite).sort((x, y) => x - y);
  if (!a.length) return null;
  const q = (p) => a[Math.min(a.length - 1, Math.round(p * (a.length - 1)))];
  return { n: a.length, min: a[0], median: q(0.5), p75: q(0.75), max: a[a.length - 1] };
}

function buildBenchmarks(pages) {
  const pick = (fn) => stats(pages.map(fn));
  const pct = (fn) => (pages.length ? Math.round((pages.filter(fn).length / pages.length) * 100) : 0);
  const schemaCount = {};
  pages.forEach((p) => new Set(p.xray.schemaBlocks.map(String)).forEach((t) => (schemaCount[t] = (schemaCount[t] || 0) + 1)));
  return {
    words: pick((p) => p.xray.contentWords),
    top3Words: stats(pages.filter((p) => p.position && p.position <= 3).map((p) => p.xray.contentWords)),
    sections: pick((p) => sectionHeadings(p.xray.headingTree).length),
    tables: pick((p) => p.xray.tables),
    faq: pick((p) => p.xray.faqCount),
    internalPer1k: pick((p) => (p.xray.contentWords ? +((p.xray.inContentInternal.length / p.xray.contentWords) * 1000).toFixed(2) : 0)),
    externalLinks: pick((p) => p.xray.inContentExternal.length),
    titleLen: pick((p) => p.xray.titleLen),
    schema: Object.entries(schemaCount)
      .map(([type, count]) => ({ type, count, pct: Math.round((count / pages.length) * 100) }))
      .sort((a, b) => b.count - a.count),
    eeat: {
      author: pct((p) => p.xray.hasAuthor),
      reviewer: pct((p) => p.xray.hasReviewer),
      dates: pct((p) => p.xray.hasDates),
      methodology: pct((p) => p.signals?.hasMethodology),
    },
    titles: {
      yearPct: pct((p) => /20\d{2}/.test(p.xray.title)),
      sizeSharePct: pct((p) => /size|share/i.test(p.xray.title)),
      figureInMetaPct: pct((p) => /(usd|us\$|\$|€|£)\s?\d/i.test(p.xray.metaDesc || "")),
      cagrInMetaPct: pct((p) => /cagr/i.test(p.xray.metaDesc || "")),
    },
  };
}

function schemaTargets(b, contentType) {
  const pct = (t) => b.schema.find((s) => s.type.toLowerCase() === t.toLowerCase())?.pct || 0;
  const list = [
    { type: "Organization", why: "Publisher identity (name, logo, sameAs). Usually set once site-wide." },
    { type: "BreadcrumbList", why: `Clear hierarchy (Home › Industry › Report). ${pct("BreadcrumbList")}% of page 1 uses it.` },
    contentType === "blog"
      ? { type: "Article / BlogPosting", why: "Named author (Person), datePublished and dateModified that match the visible byline and date." }
      : { type: "WebPage (or Article / Report)", why: "Name, description, author/publisher and datePublished/dateModified matching what is visible." },
  ];
  if (contentType !== "blog") {
    list.push({ type: "Dataset (optional)", why: `Only if the page shows a real data table with a clear description. ${pct("Dataset")}% of page 1 uses it.` });
  }
  list.push({
    type: "FAQPage (optional)",
    why: `Valid if the Q&A is visible, but since 2023 Google shows FAQ rich results mainly for well-known government and health sites — don't expect a rich result. ${pct("FAQPage")}% of page 1 uses it.`,
  });
  return list;
}

function buildTargets(b, matrix, contentType) {
  const isBlog = contentType === "blog";
  const r100 = (x) => Math.max(100, Math.round(x / 100) * 100);
  const med = b.words?.median;
  const lo = med ? r100(Math.max(med, b.top3Words?.median || 0)) : isBlog ? 1500 : 2500;
  const hi = med ? r100(Math.max(lo * 1.15, b.words?.p75 || 0)) : lo + 800;
  const must = matrix.topics.filter((t) => t.tier === "must").length;
  const should = matrix.topics.filter((t) => t.tier === "should").length;
  const ratio = b.internalPer1k?.median || (isBlog ? 3.5 : 4.5);
  return {
    coverageWords: [lo, hi],
    sections: Math.min(20, Math.max(b.sections?.median || 8, must + Math.min(3, should))),
    tables: isBlog ? Math.max(1, b.tables?.median || 0) : Math.max(2, b.tables?.median || 0),
    faqs: Math.min(10, Math.max(5, b.faq?.median || 0)),
    internalLinks: Math.min(25, Math.max(isBlog ? 3 : 4, Math.round(((ratio * lo) / 1000) * 1.15))),
    externalCitations: Math.max(3, Math.round(((isBlog ? 2.5 : 2.0) * lo) / 1000)),
    schema: schemaTargets(b, contentType),
  };
}

function summariseOurPage(p) {
  const x = p.xray;
  return {
    url: p.link,
    position: p.position || null,
    words: x.contentWords,
    sections: sectionHeadings(x.headingTree).length,
    tables: x.tables,
    faq: x.faqCount,
    schema: [...new Set(x.schemaBlocks)],
    author: x.hasAuthor,
    reviewer: x.hasReviewer,
    dates: x.hasDates,
    title: x.title,
    titleLen: x.titleLen,
    metaDesc: x.metaDesc,
    metaDescLen: x.metaDescLen,
    internalLinks: x.inContentInternal.length,
    externalLinks: x.inContentExternal.length,
    headings: x.headingTree.filter(([l]) => l === 2 || l === 3).map(([l, t]) => `H${l}: ${t}`).slice(0, 60),
    figures: p.signals?.figures || null,
  };
}

function buildGaps(our, matrix, b, t) {
  const items = [];
  const missingTopics = matrix.topics.filter((x) => x.tier !== "differentiator" && x.ours === false).map((x) => x.label);
  if (missingTopics.length) {
    items.push({ severity: "critical", text: `Missing ${missingTopics.length} topic(s) that page 1 covers: ${missingTopics.slice(0, 10).join(", ")}.` });
  }
  if (b.words?.median && our.words < b.words.median * 0.7) {
    items.push({ severity: "warning", text: `About ${our.words.toLocaleString("en-US")} content words vs a page-1 median of ${b.words.median.toLocaleString("en-US")}. Close the gap by covering the missing topics in depth, not with filler.` });
  }
  if (our.tables < t.tables) items.push({ severity: "warning", text: `${our.tables} data table(s) vs ${t.tables} recommended.` });
  if (our.faq < Math.min(t.faqs, 5)) items.push({ severity: "warning", text: `${our.faq} FAQ(s) detected — answer the People Also Ask questions in this brief.` });
  if (!our.author) items.push({ severity: "warning", text: "No visible author / analyst byline detected." });
  if (!our.dates) items.push({ severity: "warning", text: "No published or last-updated date detected." });
  const ourSchema = our.schema.map((s) => String(s).toLowerCase());
  b.schema
    .filter((s) => s.pct >= 50 && !ourSchema.includes(String(s.type).toLowerCase()))
    .forEach((s) => items.push({ severity: "info", text: `${s.pct}% of page 1 uses ${s.type} markup; your page doesn't.` }));
  if (b.titles.yearPct >= 50 && !/20\d{2}/.test(our.title || "")) {
    items.push({ severity: "info", text: `${b.titles.yearPct}% of page-1 titles include a year or forecast period; yours doesn't.` });
  }
  if (our.titleLen > 65) items.push({ severity: "info", text: `Title is ${our.titleLen} characters — likely truncated in results (aim for 50–60).` });
  return { missingTopics, items };
}

function pickComparable(pages, contentType) {
  const ok = pages.filter((p) => p.fetched && p.type !== "ours" && p.type !== "ugc" && p.xray.contentWords >= 250);
  if (contentType === "report") {
    const mr = ok.filter((p) => p.type === "tracked" || p.type === "publisher");
    if (mr.length >= 2) return mr;
  }
  return ok;
}

function inferIntent(rows) {
  const c = countBy(rows, (r) => r.type);
  const research = (c.tracked || 0) + (c.publisher || 0) + (c.ours || 0);
  if (research >= 5) {
    return { label: "Commercial research", detail: `${research} of ${rows.length} page-1 results are research-report pages. Searchers expect market size, forecast, segmentation, regional split and key players — a report-style page is needed to compete.` };
  }
  if ((c.authority || 0) + (c.news || 0) >= 4) {
    return { label: "Informational / news-led", detail: "Page 1 leans on government, association and news sources. A data-led explainer with clear sourcing fits better than a sales-style report page." };
  }
  const mix = Object.entries(c).map(([k, v]) => `${v} ${(TYPE_LABEL[k] || k).toLowerCase()}`).join(", ");
  return { label: "Mixed intent", detail: `Page 1 mixes ${mix}. Lead with the core numbers, then give the explanatory depth the informational results provide.` };
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
    (p.signals?.companies || []).forEach((name) => {
      const k = companyKey(name);
      if (!k || seen.has(k)) return;
      seen.add(k);
      const r = m.get(k) || { name, count: 0, sites: [] };
      r.count++;
      r.sites.push(p.domain);
      m.set(k, r);
    });
  });
  return [...m.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)).slice(0, 40);
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
  pages.forEach((p) => {
    (p.xray?.faqQuestions || []).forEach((q) => add(q, `FAQ · ${p.domain}`));
    (p.signals?.questionHeadings || []).forEach((q) => add(q, `Heading · ${p.domain}`));
  });
  return out.slice(0, 30);
}

function slimRow(p) {
  const base = {
    position: p.position, title: p.title, link: p.link, domain: p.domain, snippet: p.snippet, date: p.date,
    type: p.type, fetched: !!p.fetched, blocked: !!p.blocked, skipped: p.skipped || null, status: p.status ?? null,
  };
  if (!p.fetched) return { ...base, stats: null };
  const x = p.xray, s = p.signals || {};
  return {
    ...base,
    stats: {
      words: x.contentWords, sections: sectionHeadings(x.headingTree).length, tables: x.tables, faq: x.faqCount,
      schema: [...new Set(x.schemaBlocks)], author: x.hasAuthor, reviewer: x.hasReviewer, dates: x.hasDates,
      internalLinks: x.inContentInternal.length, externalLinks: x.inContentExternal.length,
      pageTitle: x.title, titleLen: x.titleLen, metaDesc: x.metaDesc, metaDescLen: x.metaDescLen,
      lastUpdated: lastUpdatedOf(x, s), cagr: s.figures?.cagr ?? null, values: s.figures?.values || [],
      period: s.figures?.period || null, companies: (s.companies || []).length,
    },
  };
}

/* ===================== 6. Assemble ===================== */

export function analyseSerp({ keyword, contentType, serp, pages, ourDomain, ourPage, ourUrl }) {
  const kw = keywordTokens(keyword);
  const warnings = [];
  if (serp.warning) warnings.push(serp.warning);

  const rows = pages.map(slimRow);
  const ourRows = pages.filter((p) => p.type === "ours");
  const comparable = pickComparable(pages, contentType);
  const unreadable = pages.filter((p) => !p.fetched && !p.skipped).length;
  if (unreadable) warnings.push(`${unreadable} page-1 result(s) could not be fetched (bot protection or timeout). They are listed but not benchmarked.`);
  if (comparable.length < 2) warnings.push("Fewer than 2 comparable page-1 pages could be analysed, so benchmarks are thin — treat targets as indicative.");

  const topics = buildTopicMatrix(comparable, kw);
  const ourData =
    (ourPage && ourPage.fetched ? ourPage : null) ||
    (ourUrl ? pages.find((p) => p.fetched && sameUrl(p.link, ourUrl)) : null) ||
    ourRows.find((p) => p.fetched) ||
    null;
  if (ourData) markOurTopics(topics, ourData, kw);
  if (ourPage && !ourPage.fetched) {
    warnings.push(`Could not fetch your page (${ourPage.blocked ? "bot-blocked" : "HTTP " + ourPage.status}) — gap analysis skipped.`);
  }

  const benchmarks = buildBenchmarks(comparable);
  const targets = buildTargets(benchmarks, topics, contentType);
  const ourSummary = ourData ? summariseOurPage(ourData) : null;
  const cagrs = comparable.map((p) => p.signals?.figures?.cagr).filter(Number.isFinite);

  return {
    keyword, contentType, gl: serp.gl, hl: serp.hl, provider: serp.provider,
    generatedAt: new Date().toISOString(), policyBaseline: POLICY_BASELINE, policy: GOOGLE_POLICY,
    ourDomain: ourDomain || null,
    serp: {
      organic: rows,
      peopleAlsoAsk: serp.peopleAlsoAsk || [],
      relatedSearches: serp.relatedSearches || [],
      aiOverview: serp.aiOverview || null,
      answerBox: serp.answerBox || null,
      ourPosition: ourRows[0]?.position ?? null,
      ourRankingUrl: ourRows[0]?.link ?? null,
      composition: countBy(rows, (r) => r.type),
      intent: inferIntent(rows),
    },
    pagesCompared: comparable.length,
    comparedDomains: comparable.map((p) => p.domain),
    topics, benchmarks, targets,
    segments: consensus(comparable, (p) => p.signals?.segments),
    regions: consensus(comparable, (p) => p.signals?.regions),
    countries: consensus(comparable, (p) => p.signals?.countries, 15),
    regionClaims: {
      largest: consensus(comparable, (p) => (p.signals?.largestRegion ? [p.signals.largestRegion] : [])),
      fastest: consensus(comparable, (p) => (p.signals?.fastestRegion ? [p.signals.fastestRegion] : [])),
    },
    figures: {
      rows: comparable.map((p) => ({
        position: p.position, domain: p.domain,
        values: p.signals?.figures?.values || [], cagr: p.signals?.figures?.cagr ?? null,
        period: p.signals?.figures?.period || null, lastUpdated: lastUpdatedOf(p.xray, p.signals),
      })),
      cagrMin: cagrs.length ? Math.min(...cagrs) : null,
      cagrMax: cagrs.length ? Math.max(...cagrs) : null,
      periods: consensus(comparable, (p) => (p.signals?.figures?.period ? [p.signals.figures.period] : [])),
    },
    companies: companyConsensus(comparable),
    questions: buildQuestions(serp, comparable, kw),
    ourPage: ourSummary,
    gaps: ourSummary ? buildGaps(ourSummary, topics, benchmarks, targets) : null,
    warnings,
  };
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

function jaccard(a, b) {
  const A = new Set(String(a).split(" ").filter(Boolean));
  const B = new Set(String(b).split(" ").filter(Boolean));
  if (!A.size || !B.size) return 0;
  let inter = 0;
  A.forEach((x) => { if (B.has(x)) inter++; });
  return inter / (A.size + B.size - inter);
}

function countBy(arr, fn) {
  return arr.reduce((m, x) => { const k = fn(x); m[k] = (m[k] || 0) + 1; return m; }, {});
}

function lastUpdatedOf(x, s) {
  const d = (x?.schemaDetail || []).map((b) => b.dateModified || b.datePublished).find(Boolean);
  if (d) return String(d).slice(0, 10);
  return s?.lastUpdated || null;
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
