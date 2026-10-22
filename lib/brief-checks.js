// lib/brief-checks.js
// Four checks for every Content Brief, run in api/brief.js right after analyseSerp():
//
//   intentMix     What KIND of pages Google ranks in the top 10 — research reports vs statistics
//                 pages, explainers and trend pieces — so the writer's skeleton can match it.
//   keywordCheck  Does the top 10 use the keyword as typed? If Google ranks a different wording
//                 (e.g. "e-commerce market" for "commerce market"), say so and suggest it.
//   freshness     Flags pages with old data (last update > 12 months ago, or a forecast period
//                 starting 2+ years ago). FLAG ONLY — stale pages stay in every comparison and
//                 benchmark, because Google still ranks them.
//   figureCheck   GAP — competitor figures that don't add up (base → forecast vs the stated CAGR, or a
//                 size 10× away from every other page). Flagged and left OUT of the CAGR range the writer
//                 benchmarks against. Also used for the gap analysis's benchmark table (lib/gap-analysis.js).
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

/* ---------------- 4. GAP — competitor figures that don't add up ---------------- */
// For each competitor: does base value → forecast value over the forecast period work out to the CAGR
// it states? Rows that don't add up, or sit 10× away from every other page, are flagged and left out of
// the CAGR range. Often our first-mention extraction picked the wrong number rather than the page being
// wrong — either way the figure shouldn't be a benchmark.

const MONEY_RE = /(USD|US\$|\$|EUR|€|GBP|£|INR|₹)?\s?(\d[\d,]*(?:\.\d+)?)\s?(trillion|billion|million|tn|bn|mn|t|b|m)(?![a-z])\.?(?:\s*\((\d{4})\))?/gi;
const UNIT = { trillion: 1e12, tn: 1e12, t: 1e12, billion: 1e9, bn: 1e9, b: 1e9, million: 1e6, mn: 1e6, m: 1e6 };
const curOf = (s) => (!s || /^(usd|us\$|\$)$/i.test(s) ? "USD" : /eur|€/i.test(s) ? "EUR" : /gbp|£/i.test(s) ? "GBP" : "INR");
const money = (s) => [...String(s || "").replace(/\\/g, "").matchAll(MONEY_RE)].map((m) => ({
  usd: parseFloat(m[2].replace(/,/g, "")) * UNIT[m[3].toLowerCase()],
  cur: curOf(m[1]),
  year: m[4] ? +m[4] : null,
  raw: m[0].trim().replace(/\s*\(\d{4}\)$/, ""),
}));
const median = (a) => { const s = [...a].sort((x, y) => x - y), n = s.length; return n ? (n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2) : 0; };
const fmtMoney = (v, cur) => `${cur} ${v >= 1e12 ? (v / 1e12).toFixed(1) + " trillion" : v >= 1e9 ? (v / 1e9).toFixed(1) + " billion" : (v / 1e6).toFixed(0) + " million"}`;
const NUM_ISSUE_RE = /reconcile|doesn'?t match|don'?t match|add up|mislabel|mixe[sd]|conflict|two different|implies|\bnot \d|\bsays\b.*\bsays\b/i;

// rows: [{ name, link, values?: ["USD 1.88 trillion", …], cagr?, period?: "2026–2035", text?: "$657.9M (2025) → $5,882.7M (2033), 31.5%", scope?, weaknesses? }]
export function checkFigureRows(rows = [], { byScope = false } = {}) {
  const out = rows.map((r) => {
    const vals = r.text != null ? money(r.text) : (r.values || []).flatMap((v) => money(v).slice(0, 1));
    const per = String(r.period || "").match(/((?:19|20)\d{2})\s*[–—-]\s*((?:19|20)\d{2})/);
    let cagr = Number.isFinite(r.cagr) ? r.cagr : null;
    if (cagr == null && r.text != null) { const m = String(r.text).match(/(\d{1,2}(?:\.\d{1,2})?)\s?%/); if (m) cagr = parseFloat(m[1]); }
    const base = vals[0] || null;
    const end = vals[1] || null;
    const y0 = base && base.year ? base.year : per ? +per[1] : null;
    const y1 = end && end.year ? end.year : per ? +per[2] : null;
    const flags = [];
    let implied = null;
    if (base && end && base.cur === end.cur) {
      if (end.usd < base.usd) {
        flags.push({ level: "major", msg: `Forecast ${end.raw} is lower than the base ${base.raw}${cagr != null ? `, yet the page states ${cagr}% growth` : ""} — a unit, scope or extraction mix-up.` });
      } else if (y0 && y1 && y1 > y0 && cagr != null) {
        implied = +((Math.pow(end.usd / base.usd, 1 / (y1 - y0)) - 1) * 100).toFixed(1);
        const off = Math.abs(implied - cagr);
        if (off > 3) flags.push({ level: "major", msg: `${base.raw} → ${end.raw} over ${y0}–${y1} works out to ${implied}% a year, not the stated ${cagr}%.` });
        else if (off > 1) flags.push({ level: "minor", msg: `Works out to ${implied}% a year vs the stated ${cagr}% — check the period before quoting it.` });
      }
    }
    return { name: r.name, link: r.link || null, scope: r.scope || "", cagr, base, implied, weaknesses: r.weaknesses || "", flags };
  });

  if (!byScope) {
    const pool = out.filter((r) => r.base && r.base.cur === "USD");
    if (pool.length >= 3) {
      const med = median(pool.map((r) => r.base.usd));
      pool.forEach((r) => {
        if (r.base.usd < med / 10 || r.base.usd > med * 10) {
          r.flags.push({ level: "major", msg: `${r.base.raw} is more than 10× away from the other pages (median about ${fmtMoney(med, "USD")}) — a different scope or a unit error.` });
        }
      });
    }
  }
  out.forEach((r) => {
    if (r.flags.length || !r.weaknesses) return;
    const hits = String(r.weaknesses).split(/;\s*/).filter((s) => NUM_ISSUE_RE.test(s));
    if (hits.length) r.flags.push({ level: "reported", msg: `Noted by the research team: ${hits.join("; ")}` });
  });
  out.forEach((r) => { r.bad = r.flags.some((f) => f.level === "major"); });

  const groups = new Map();
  out.filter((r) => r.cagr != null).forEach((r) => {
    const key = byScope ? (r.scope.toLowerCase().split(/\s+/)[0] || "all") : "all";
    if (!groups.has(key)) groups.set(key, { label: byScope ? r.scope : "", good: [], left: [] });
    groups.get(key)[r.bad ? "left" : "good"].push(r);
  });
  const ranges = [...groups.values()].filter((g) => g.good.length).map((g) => {
    const v = g.good.map((r) => r.cagr);
    return { label: g.label, min: Math.min(...v), max: Math.max(...v), n: v.length, names: g.good.map((r) => r.name) };
  });
  const leftOut = [...groups.values()].flatMap((g) => g.left.map((r) => r.name));
  const span = (g) => (g.min === g.max ? `${g.min}%` : `${g.min}%–${g.max}%`);
  const line = ranges.length
    ? `Competitors quote CAGRs of ${ranges.map((g) => `${g.label ? g.label + ": " : ""}${span(g)}`).join("; ")} — if ours is outside that range, explain why in one line.` +
      (leftOut.length ? ` Left out of the range because their figures don't add up: ${leftOut.join(", ")} (see the SEO tab).` : "")
    : "";

  const ok = out.filter((r) => r.base && !r.bad && r.base.cur === "USD");
  let spread = null;
  if (ok.length >= 2) {
    const lo = ok.reduce((a, b) => (b.base.usd < a.base.usd ? b : a));
    const hi = ok.reduce((a, b) => (b.base.usd > a.base.usd ? b : a));
    spread = { minRaw: lo.base.raw, maxRaw: hi.base.raw, ratio: +(hi.base.usd / lo.base.usd).toFixed(1) };
  }

  return {
    rows: out.map(({ name, link, scope, cagr, implied, flags, bad }) => ({ name, link, scope, cagr, implied, flags, bad })),
    flags: out.flatMap((r) => r.flags.map((f) => ({ name: r.name, link: r.link, ...f }))),
    ranges, leftOut, line, spread,
  };
}

export function figureCheck(collected) {
  const rows = (collected.competitors || []).filter((x) => x.fetched && x.stats)
    .map((x) => ({ name: x.name, link: x.link, values: (x.stats.values || []).slice(0, 2), cagr: x.stats.cagr, period: x.stats.period }));
  return rows.length ? checkFigureRows(rows) : null;
}

/* ---------------- entry point used by api/brief.js ---------------- */

export function annotateBrief(collected, { keyword, serp, pages = [], ourPage = null, ourDomain = null, dupes = null } = {}) {
  const run = (fn) => { try { return fn(); } catch (e) { return { error: String((e && e.message) || e) }; } };
  collected.intentMix = run(() => analyseIntent({ serp, pages, ourDomain }));
  collected.keywordCheck = run(() => checkKeyword({ keyword, serp, pages, dupes }));
  collected.freshness = run(() => freshnessCheck({ pages, ourPage }));
  collected.figureCheck = run(() => figureCheck(collected)); // GAP
  return collected;
}
