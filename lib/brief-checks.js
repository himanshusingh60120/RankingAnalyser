// lib/brief-checks.js
// Three checks for every Content Brief, run in api/brief.js right after analyseSerp():
//
//   intentMix     What KIND of pages Google ranks in the top 10 — research reports vs statistics
//                 pages, explainers and trend pieces — so the writer's skeleton can match it.
//   keywordCheck  Does the top 10 use the keyword as typed? If Google ranks a different wording
//                 (e.g. "e-commerce market" for "commerce market"), say so and suggest it.
//   freshness     Flags pages with old data (last update > 12 months ago, or a forecast period
//                 starting 2+ years ago). FLAG ONLY — stale pages stay in every comparison and
//                 benchmark, because Google still ranks them.
//
// Pure functions over data the brief already collected: no extra network calls, no extra cost.

import { classifyDomain, displayName } from "./brief.js";

/* ---------------- shared helpers ---------------- */

const matchesDomain = (d, base) => !!d && !!base && (d === base || d.endsWith("." + base));

const stem = (w) =>
  w.length > 4 && w.endsWith("ies") ? w.slice(0, -3) + "y"
    : w.length > 3 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1)
      : w;

// "e-commerce", "e commerce" and "eCommerce" all become "ecommerce"; other hyphenated words are
// joined too — so "commerce" is NOT counted as a match for "e-commerce".
const E_PREFIX_RE = /\b(e|m)[\s\u2010\u2011-]+(commerce|learning|books?|mobility|health|sports|wallets?|bikes?|scooters?|waste|cigarettes?|invoicing|procurement|signatures?|pharmacy|fuels?)\b/g;
function joinCompounds(s) {
  let t = String(s || "").toLowerCase().replace(E_PREFIX_RE, "$1$2");
  let prev;
  do { prev = t; t = t.replace(/([a-z0-9])[\u2010\u2011-]([a-z0-9])/g, "$1$2"); } while (t !== prev);
  return t;
}
const tokensOf = (s) => joinCompounds(s).split(/[^a-z0-9&]+/).filter(Boolean);

const TOPIC_STOP = new Set(["the", "of", "and", "for", "in", "by", "to", "on", "at", "a", "an", "&",
  "market", "markets", "global", "worldwide", "size", "share", "report", "reports", "industry",
  "analysis", "forecast", "forecasts", "trend", "trends", "growth", "outlook", "research"]);
const topicTokens = (s) => tokensOf(s).filter((t) => !TOPIC_STOP.has(t) && !/^\d+$/.test(t));

/* ---------------- 1. Search intent ---------------- */

const STATS_DOMAINS = ["statista.com", "ecdb.com", "emarketer.com", "insiderintelligence.com", "oberlo.com",
  "demandsage.com", "backlinko.com", "capitaloneshopping.com", "ourworldindata.org", "tradingeconomics.com"];
const STATS_TITLE = /\b(statistics|stats|facts|figures|numbers|data|forecasts?|sales|size)\b/i;
const GUIDE_TITLE = /\b(what (?:is|are|it is|they are)|guide|how to|explained|explainer|definition|meaning|101|beginners?|types of|vs\.?|versus|tips|benefits|examples?)\b/i;
const TREND_TITLE = /\b(trends?|outlook|future of|predictions?)\b/i;

const KIND_PHRASE = {
  stats: ["statistics/data page", "statistics/data pages"],
  guide: ["explainer", "explainers"],
  trends: ["trend piece", "trend pieces"],
  news: ["news article", "news articles"],
  authority: ["government/authority page", "government/authority pages"],
  category: ["category page", "category pages"],
  press: ["press release", "press releases"],
  ugc: ["forum/social post", "forum/social posts"],
  other: ["other page", "other pages"],
};

export function analyseIntent({ serp, pages = [], ourDomain = null }) {
  const top = (serp && Array.isArray(serp.organic) ? serp.organic : []).slice(0, 10);
  const pageFor = (r) => pages.find((p) => p && p.page1 && p.link === r.link);

  const rows = top.map((r) => {
    const p = pageFor(r);
    const title = String(r.title || (p && p.xray && p.xray.title) || "");
    const type = classifyDomain(r.domain, ourDomain);
    let kind;
    if (p && p.signals && p.signals.isListing) kind = "category";
    else if (STATS_DOMAINS.some((d) => matchesDomain(r.domain, d))) kind = "stats";
    else if (type === "ours" || type === "tracked" || type === "publisher") kind = "report";
    else if (STATS_TITLE.test(title)) kind = "stats";
    else if (GUIDE_TITLE.test(title)) kind = "guide";
    else if (TREND_TITLE.test(title)) kind = "trends";
    else kind = ["news", "authority", "press", "ugc"].includes(type) ? type : "other";
    return { position: r.position, domain: r.domain, name: displayName(r.domain), title, kind };
  });

  const counts = {};
  for (const r of rows) counts[r.kind] = (counts[r.kind] || 0) + 1;
  const cnt = (k) => counts[k] || 0;
  const total = rows.length;
  const n = total || 1;
  const reports = cnt("report");
  const intent = reports >= Math.ceil(n * 0.6) ? "report" : reports >= Math.ceil(n * 0.3) ? "mixed" : "informational";

  const paa = ((serp && serp.peopleAlsoAsk) || []).map((p) => String((p && p.question) || ""));
  const names = (k) => rows.filter((r) => r.kind === k).map((r) => r.name).slice(0, 4);

  const label = intent === "report" ? "Market-report intent"
    : intent === "mixed" ? "Mixed intent — reports and explainers"
      : "Statistics & explainer intent";
  const parts = Object.keys(KIND_PHRASE).filter((k) => cnt(k)).map((k) => `${cnt(k)} ${KIND_PHRASE[k][cnt(k) === 1 ? 0 : 1]}`);
  const detail = `${reports} of the top ${total} results ${reports === 1 ? "is a research report" : "are research reports"}` +
    `${parts.length ? ` — the rest: ${parts.join(", ")}` : ""}.`;

  return {
    intent, label, detail, total, counts,
    wantsDefinition: cnt("guide") >= 2 || (cnt("guide") >= 1 && paa.some((q) => /^what (?:is|are)\b/i.test(q))),
    wantsStats: cnt("stats") >= 2,
    wantsTrends: cnt("trends") >= 2,
    examples: { report: names("report"), stats: names("stats"), guide: names("guide"), trends: names("trends") },
    rows,
  };
}

/* ---------------- 2. Keyword vs what ranks ---------------- */

function displayForm(norm, titles) {
  const counts = new Map();
  for (const t of titles) {
    for (const raw of String(t || "").match(/[A-Za-z0-9&]+(?:[\u2010\u2011-][A-Za-z0-9&]+)*/g) || []) {
      if (joinCompounds(raw).replace(/[^a-z0-9&]/g, "") === norm) counts.set(raw, (counts.get(raw) || 0) + 1);
    }
  }
  if (!counts.size) return norm.charAt(0).toUpperCase() + norm.slice(1);
  const all = [...counts.entries()];
  const total = all.reduce((a, [, k]) => a + k, 0);
  const hyph = all.filter(([r]) => /[\u2010\u2011-]/.test(r));
  const pool = hyph.reduce((a, [, k]) => a + k, 0) * 3 >= total ? hyph : all;
  const raw = pool.sort((a, b) => b[1] - a[1])[0][0];
  return raw.split(/([\u2010\u2011-])/).map((p) =>
    /^[\u2010\u2011-]$/.test(p) ? "-" : /[a-z][A-Z]/.test(p) ? p : p.charAt(0).toUpperCase() + p.slice(1).toLowerCase()
  ).join("");
}

function originalWord(keyword, token) {
  const target = stem(token);
  return String(keyword || "").trim().split(/\s+/)
    .find((w) => stem(joinCompounds(w).replace(/[^a-z0-9&]/g, "")) === target) || null;
}

function suggestKeyword(keyword, token, display) {
  const target = stem(token);
  let done = false;
  const out = String(keyword || "").trim().split(/\s+/).map((w) => {
    if (!done && stem(joinCompounds(w).replace(/[^a-z0-9&]/g, "")) === target) { done = true; return display; }
    return w === w.toLowerCase() ? w.charAt(0).toUpperCase() + w.slice(1) : w;
  });
  return done ? out.join(" ") : `${display} ${keyword}`;
}

export function checkKeyword({ keyword, serp, pages = [], dupes = null }) {
  const kwToks = topicTokens(keyword).filter((t) => t.length >= 2);
  const top = (serp && Array.isArray(serp.organic) ? serp.organic : []).slice(0, 10);
  const n = top.length;
  const base = { keyword, core: kwToks.join(" "), total: n };
  if (!kwToks.length || !n) {
    return { ...base, status: "ok", exactCount: n, variant: null, variantDisplay: null, suggestedKeyword: null, message: "" };
  }

  const kwStems = kwToks.map(stem);
  const exactTitles = [];
  const variants = new Map();
  const scan = (title, isTop) => {
    const toks = tokensOf(title);
    const stems = new Set(toks.map(stem));
    if (kwStems.every((k) => stems.has(k))) { if (isTop) exactTitles.push(title); return; }
    for (const k of kwToks) {
      const sk = stem(k);
      if (stems.has(sk) || k.length < 4) continue;
      // A title word that contains the missing keyword word, e.g. "ecommerce" ⊃ "commerce".
      const v = toks.find((t) => t !== k && t.length > k.length && (t.endsWith(k) || t.endsWith(sk) || t.startsWith(sk)));
      if (!v) continue;
      const key = `${k}>${v}`;
      const e = variants.get(key) || { token: k, norm: v, count: 0, trackedCount: 0, titles: [] };
      if (isTop) { e.count++; if (e.titles.length < 3) e.titles.push(title); } else e.trackedCount++;
      variants.set(key, e);
    }
  };
  top.forEach((r) => scan(r.title || "", true));
  pages.filter((p) => p && !p.page1 && p.fetched && p.xray && p.xray.title).forEach((p) => scan(p.xray.title, false));

  const exactCount = exactTitles.length;
  const best = [...variants.values()].sort((a, b) => b.count - a.count || b.trackedCount - a.trackedCount)[0] || null;
  let status = "ok";
  if (exactCount < Math.ceil(n / 2)) {
    if (best && best.count >= 3 && best.count >= exactCount + 2) status = "variant";
    else if (exactCount <= 2) status = "weak";
  }

  const queries = dupes && Array.isArray(dupes.queries) ? dupes.queries : null;
  const gscImpressions = queries ? queries.reduce((a, q) => a + (Number(q && q.impressions) || 0), 0) : null;
  const gscNote = gscImpressions != null && gscImpressions < 100
    ? ` Your site got ${gscImpressions} Search Console impression${gscImpressions === 1 ? "" : "s"} (last 90 days) for searches with your exact wording.`
    : "";

  let variant = null;
  let suggestedKeyword = null;
  let message;
  if (status === "variant") {
    const allTitles = [...top.map((r) => r.title || ""), ...pages.map((p) => (p && p.xray && p.xray.title) || "")];
    const display = displayForm(best.norm, allTitles);
    const typed = originalWord(keyword, best.token) || best.token;
    suggestedKeyword = suggestKeyword(keyword, best.token, display);
    variant = { token: best.token, norm: best.norm, display, count: best.count, trackedCount: best.trackedCount, titles: best.titles };
    message = `Google ranks pages about “${display}”, not “${typed}”: ${best.count} of the top ${n} results use “${display}”, ` +
      `${exactCount ? `only ${exactCount}` : "none"} use${exactCount === 1 ? "s" : ""} your exact wording.${gscNote}`;
  } else if (status === "weak") {
    message = `Only ${exactCount} of the top ${n} results use your exact wording “${keyword}”. ` +
      `Google may read this search differently — check the top 10 in the SEO tab before writing.${gscNote}`;
  } else {
    message = `${exactCount} of the top ${n} results use your exact wording.`;
  }

  return {
    ...base, status, exactCount, exactTitles: exactTitles.slice(0, 3),
    variant, variantDisplay: variant ? variant.display : null, suggestedKeyword, gscImpressions, message,
  };
}

/* ---------------- 3. Freshness (flag only — nothing is excluded) ---------------- */

const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function parseDate(v, now) {
  if (!v) return null;
  const s = String(v).trim().replace(/(\d)(st|nd|rd|th)\b/gi, "$1").replace(/\bsept\b/gi, "Sep");
  let d = null;
  const iso = s.match(/\b(20\d{2})-(\d{2})(?:-(\d{2}))?\b/);
  if (iso) d = new Date(Date.UTC(+iso[1], +iso[2] - 1, +(iso[3] || 1)));
  if (!d || isNaN(d)) d = new Date(s);
  if (isNaN(d)) {
    const m = s.match(/([A-Za-z]{3,})\.?\s+(20\d{2})/);
    if (m) d = new Date(`${m[1]} 1, ${m[2]}`);
  }
  if (!d || isNaN(d)) return null;
  if (d.getFullYear() < 2000 || d.getTime() > now.getTime() + 31 * 86400000) return null;
  return d;
}
const monthsBetween = (a, b) => Math.max(0, (b.getFullYear() - a.getFullYear()) * 12 + (b.getMonth() - a.getMonth()));
const monthYear = (d) => `${MON[d.getMonth()]} ${d.getFullYear()}`;

export function freshnessCheck({ pages = [], ourPage = null, now = new Date() }) {
  const year = now.getFullYear();
  const list = [...pages, ...(ourPage ? [ourPage] : [])].filter((p) => p && p.fetched);
  const seen = new Set();
  const items = [];

  for (const p of list) {
    const key = p.link || p.domain;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const sig = p.signals || {};
    const x = p.xray || {};
    const updated = parseDate(sig.lastUpdated || x.dateModified || x.lastModified || x.modified || x.datePublished || null, now);
    const period = (sig.figures && sig.figures.period) || null;
    const start = period ? parseInt(String(period).slice(0, 4), 10) : null;
    if (!updated && !start) continue; // nothing to judge

    const ageMonths = updated ? monthsBetween(updated, now) : null;
    const reasons = [];
    if (ageMonths != null && ageMonths > 12) reasons.push(`last updated ${monthYear(updated)} (${ageMonths} months ago)`);
    if (start && start <= year - 2) reasons.push(`forecast period starts ${start} (${period})`);

    items.push({
      domain: p.domain, name: p.type === "ours" ? "Your page" : displayName(p.domain), type: p.type,
      position: p.position || null, page1: !!p.page1, link: p.link || null,
      lastUpdated: updated ? updated.toISOString().slice(0, 10) : null, period, ageMonths,
      stale: reasons.length > 0, reasons,
    });
  }

  const stale = items.filter((i) => i.stale);
  const ranking = stale.filter((i) => i.page1 && i.type !== "ours");
  const others = stale.filter((i) => !i.page1 && i.type !== "ours");
  const ours = stale.filter((i) => i.type === "ours");
  const fmtI = (i) => `${i.name}${i.position ? ` (#${i.position})` : ""} — ${i.reasons.join("; ")}`;

  const parts = [];
  if (ranking.length) {
    parts.push(`${ranking.length} page-1 result${ranking.length === 1 ? " still ranks" : "s still rank"} with old data: ` +
      `${ranking.map(fmtI).join(" · ")}. They stay in every comparison because Google still ranks them — ` +
      "a current base year and forecast is an easy edge over them.");
  }
  if (others.length) parts.push(`Tracked competitors with old data (still compared): ${others.map(fmtI).join(" · ")}.`);
  if (ours.length) parts.push(`Your own page is out of date: ${ours.map((i) => i.reasons.join("; ")).join(" · ")}.`);

  return { checkedAt: now.toISOString(), items, stale, staleRanking: ranking, message: parts.join(" ") };
}

/* ---------------- entry point used by api/brief.js ---------------- */

export function annotateBrief(collected, { keyword, serp, pages = [], ourPage = null, ourDomain = null, dupes = null } = {}) {
  const run = (fn) => { try { return fn(); } catch (e) { return { error: String((e && e.message) || e) }; } };
  collected.intentMix = run(() => analyseIntent({ serp, pages, ourDomain }));
  collected.keywordCheck = run(() => checkKeyword({ keyword, serp, pages, dupes }));
  collected.freshness = run(() => freshnessCheck({ pages, ourPage }));
  return collected;
}
