// lib/competitor-gaps.js
// WHAT COMPETITORS MISS — things most of the compared competitor pages don't have, which our page can add
// to beat them. Used by the Writer's skeleton (a note in each section + a new H2 when the section isn't in
// our format), the brief summary, the SEO details tab (a has / missing grid per competitor, plus "You")
// and the tracking sheet ("Misses to work on").
//
// competitorGaps(c, pages, { ourPage })
//   c        the brief's collected data — run after annotateBrief so freshness and figureCheck are there
//   pages    the pages read by collectSerpPages. With them we also check bylines, dates, sources, key-player
//            lists, country detail, FAQ markup and which People Also Ask questions each page answers.
//            Without them (briefs saved earlier) only sections, tables, FAQs, freshness and figures are checked.
//   ourPage  our own page as read (optional) — fills the "You" column
// Returns { version, mode, N, compared, items, questions, unanswered, hasOurs, ourUrl }
//   item  = { id, area, label, add, where, cells: { domain: true | false | null }, has, lacks, n, of, most, ours }
//   where = the skeleton section the fix belongs in (overview, dynamics, segmental, regional, regulatory,
//           competitive, methodology, faqs, trends, macro, pricing, valuechain)
//   most  = missing on at least half of the pages we could check — an opportunity
//   ours  = true / false / null — does our current page have it?

import { displayName, topicLabels } from "./brief.js";

const stem = (w) => (w.length > 4 && w.endsWith("ies") ? w.slice(0, -3) + "y" : w.length > 3 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w);
const STOP = new Set(["the", "of", "and", "in", "for", "to", "by", "a", "an", "on", "with", "is", "are", "was", "were", "what",
  "how", "which", "who", "why", "when", "where", "will", "does", "do", "can", "at", "as", "or", "from", "this", "that", "its",
  "it", "be", "market", "markets", "global", "industry", "report"]);
const sig = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/)
  .filter((w) => w.length > 2 && !STOP.has(w)).map(stem);
function overlap(q, text) {
  const A = new Set(sig(q));
  if (!A.size) return 0;
  const B = new Set(sig(text));
  let n = 0;
  A.forEach((x) => { if (B.has(x)) n++; });
  return n / A.size;
}

// Report sections (same labels as the topic grid in lib/brief.js) and where each belongs in our skeleton.
// needsOne: a segmentation split is only a gap when at least one competitor uses it — if none of them
// split this market by application, the split probably doesn't apply (e.g. pharmaceuticals).
const SECTIONS = [
  { label: "Market size & forecast", where: "overview", add: "State our base-year size, forecast value and CAGR, with a year-by-year table." },
  { label: "Market dynamics & growth drivers", where: "dynamics", add: "Name the main drivers, each backed by a figure or a cited source." },
  { label: "Restraints & challenges", where: "dynamics", add: "Explain what slows growth, and by how much." },
  { label: "Opportunities", where: "dynamics", add: "Show where new revenue will come from during the forecast period." },
  { label: "Market trends & innovation", where: "trends", add: "Cover 3–4 current trends, each with a dated example." },
  { label: "Macro impact (tariffs, geopolitics, AI…)", where: "macro", add: "Explain how tariffs, policy or AI change the outlook, with specifics." },
  { label: "Segmentation by type / product", where: "segmental", add: "Give share and growth by type, with a table.", needsOne: true },
  { label: "Segmentation by application", where: "segmental", add: "Give share and growth by application, with a table.", needsOne: true },
  { label: "Segmentation by end use / industry", where: "segmental", add: "Give share and growth by end user, with a table.", needsOne: true },
  { label: "Regional & country analysis", where: "regional", add: "Give size and growth by region, and name the leading countries." },
  { label: "Pricing analysis", where: "pricing", add: "Add price ranges by type or region, and how they are changing." },
  { label: "Value chain & industry analysis", where: "valuechain", add: "Map who does what, from supplier to end user." },
  { label: "Regulatory landscape", where: "regulatory", add: "Cover the rules, approvals or reimbursement that shape demand, country by country." },
  { label: "Investment & funding", where: "competitive", add: "List notable funding rounds and investors, with dates." },
  { label: "Competitive landscape & key players", where: "competitive", add: "Name the leading companies, their strategies and share." },
  { label: "Recent developments", where: "competitive", add: "List dated launches, deals and partnerships from the last 12 months." },
  { label: "Analyst view & conclusion", where: "overview", add: "Close with our analyst's take on what buyers should watch next." },
  { label: "Report scope & methodology", where: "methodology", add: "State the base year, forecast period, units, what's included and how we estimated." },
];

// Content checks. page(p) needs the page as read; stat(s) works from a saved competitor row (older briefs);
// own(o) works from the saved summary of our page (c.ourPage).
const CHECKS = [
  { id: "tables", area: "Data", label: "2+ data tables", where: "overview",
    add: "Put market size by year, share by segment and share by region in real tables (not images).",
    page: (p) => (p.xray.tables || 0) >= 2, stat: (s) => (s.tables || 0) >= 2, own: (o) => (o.tables || 0) >= 2 },
  { id: "faq", area: "Questions", label: "An FAQ with 3+ answered questions", where: "faqs",
    add: "Answer real buyer questions in a visible FAQ, 2–3 sentences each, with our numbers.",
    page: (p) => (p.xray.faqCount || 0) >= 3, stat: (s) => (s.faq || 0) >= 3, own: (o) => (o.faq || 0) >= 3 },
  { id: "byline", area: "Trust", label: "A named analyst byline", where: "overview",
    add: "Show the analyst's name (linked to a bio) under the H1, plus who reviewed it.",
    page: (p) => !!p.xray.hasAuthor, own: (o) => !!o.author },
  { id: "dated", area: "Trust", label: "A visible last-updated date", where: "overview",
    add: "Show the last-updated month and year near the top of the page.",
    page: (p) => !!p.xray.hasDates, own: (o) => !!o.dates },
  { id: "cites", area: "Trust", label: "Links to outside sources (2+)", where: "dynamics",
    add: "Link the government, association or company sources behind key facts.",
    page: (p) => ((p.xray.inContentExternal || []).length) >= 2 },
  { id: "players", area: "Data", label: "A list of 5+ key players", where: "competitive",
    add: "List 15–20 key companies, grouped by type.",
    page: (p) => ((p.signals && p.signals.companies) || []).length >= 5 },
  { id: "countries", area: "Data", label: "Country-level detail (3+ countries)", where: "regional",
    add: "Give the leading countries in each region their own figures.",
    page: (p) => ((p.signals && p.signals.countries) || []).length >= 3 },
  { id: "faqschema", area: "Markup", label: "FAQ rich-result markup", where: "faqs",
    add: "Add FAQPage schema for the visible FAQ.",
    page: (p) => (p.xray.schemaBlocks || []).some((t) => /faq/i.test(String(t))) },
];

const AREA_ORDER = { Section: 0, Data: 1, Freshness: 2, Figures: 3, Trust: 4, Questions: 5, Markup: 6, "Buyer question": 7 };

export function competitorGaps(c, pages = null, { ourPage = null } = {}) {
  const compared = comparedPages(c);
  const N = compared.length;
  const out = { version: 2, mode: pages ? "full" : "basic", N, compared, items: [], questions: [], unanswered: [], hasOurs: false, ourUrl: null };
  if (N < 2) return out;

  const pageFor = (domain) => (pages || [])
    .filter((p) => p && p.domain === domain && p.fetched && p.xray && !(p.signals && p.signals.isListing))
    .sort((a, b) => (a.position || 99) - (b.position || 99))[0] || null;
  const compFor = (domain) => (c.competitors || []).find((x) => x && x.domain === domain) || null;
  const push = (base, cells, ours = null, needsOne = false) => {
    const it = makeItem(base, cells, compared);
    it.ours = ours;
    if (needsOne && !it.has.length) return it;
    if (it.of >= 2 && it.n >= 1) out.items.push(it);
    return it;
  };

  // Our page: as read when we have it, else the saved summary (c.ourPage)
  const ourRaw = (ourPage && ourPage.fetched && ourPage.xray ? ourPage : null) ||
    (pages || []).find((p) => p && p.type === "ours" && p.fetched && p.xray) || null;
  const ourSum = c.ourPage || null;
  const ourLabels = ourSum && Array.isArray(ourSum.headings) ? new Set(topicLabels(ourSum.headings, c.keyword)) : null;
  out.hasOurs = !!(ourRaw || ourSum);
  out.ourUrl = (ourSum && ourSum.url) || (ourRaw && ourRaw.link) || null;

  // 1. Sections — from the topic grid (which pages have a heading for it)
  const topics = (c.topics && c.topics.topics) || [];
  SECTIONS.forEach((s, i) => {
    const t = topics.find((x) => x.label === s.label);
    const sites = new Set((t && t.sites) || []);
    const cells = {};
    compared.forEach((k) => { cells[k.domain] = sites.has(k.domain); });
    push({ id: `s${i}`, area: "Section", label: s.label, where: s.where, add: s.add }, cells,
      ourLabels ? ourLabels.has(s.label) : null, !!s.needsOne);
  });

  // 2. Content checks
  CHECKS.forEach((chk) => {
    if (!pages && !chk.stat) return;
    const cells = {};
    compared.forEach((k) => {
      const p = pages ? pageFor(k.domain) : null;
      if (p) { cells[k.domain] = !!chk.page(p); return; }
      const row = compFor(k.domain);
      cells[k.domain] = chk.stat && row && row.stats ? !!chk.stat(row.stats) : null;
    });
    const ours = ourRaw ? !!chk.page(ourRaw) : ourSum && chk.own ? !!chk.own(ourSum) : null;
    push({ id: chk.id, area: chk.area, label: chk.label, where: chk.where, add: chk.add }, cells, ours);
  });

  // 3. Freshness (lib/brief-checks.js) — current forecast and recent update
  const fr = c.freshness && !c.freshness.error && Array.isArray(c.freshness.items) ? c.freshness.items : [];
  if (fr.length) {
    const cells = {};
    compared.forEach((k) => {
      const f = fr.find((i) => i.domain === k.domain && i.type !== "ours");
      cells[k.domain] = f ? !f.stale : null;
    });
    const mine = fr.find((i) => i.type === "ours");
    push({ id: "fresh", area: "Freshness", label: "Current data (recent forecast, updated in the last 12 months)", where: "overview",
      add: "Publish our current base year, a forecast that starts this year or next, and the update date." }, cells, mine ? !mine.stale : null);
  }

  // 4. Figures that add up (lib/brief-checks.js figure check)
  const fc = c.figureCheck && !c.figureCheck.error && Array.isArray(c.figureCheck.rows) ? c.figureCheck : null;
  if (fc) {
    const cells = {};
    compared.forEach((k) => {
      const comp = compFor(k.domain);
      const row = comp ? fc.rows.find((r) => (r.link && comp.link && r.link === comp.link) || r.name === comp.name) : null;
      cells[k.domain] = row && (row.cagr != null || row.implied != null) ? !row.bad : null;
    });
    push({ id: "figures", area: "Figures", label: "Figures that add up (base → forecast matches the CAGR)", where: "overview",
      add: "Show a base value, forecast value and CAGR that agree, and say what the number includes." }, cells);
  }

  // 5. People Also Ask — which pages answer each question in a heading or their FAQ
  const paa = ((c.serp && c.serp.peopleAlsoAsk) || []).map((p) => p && p.question).filter(Boolean).slice(0, 8);
  if (pages && paa.length) {
    const textsOf = (p) => (p ? [
      ...((p.xray.headingTree || []).filter(([l]) => l >= 2 && l <= 4).map(([, t]) => String(t))),
      ...(p.xray.faqQuestions || []),
      ...((p.signals && p.signals.questionHeadings) || []),
    ] : null);
    const textsFor = {};
    compared.forEach((k) => { textsFor[k.domain] = textsOf(pageFor(k.domain)); });
    const ourTexts = textsOf(ourRaw);
    paa.forEach((q, i) => {
      const cells = {};
      compared.forEach((k) => {
        const texts = textsFor[k.domain];
        cells[k.domain] = texts ? texts.some((t) => overlap(q, t) >= 0.6) : null;
      });
      const ours = ourTexts ? ourTexts.some((t) => overlap(q, t) >= 0.6) : null;
      const it = push({ id: `q${i}`, area: "Buyer question", label: q, where: "faqs", add: "Answer it in our FAQ (2–3 sentences, with our numbers)." }, cells, ours);
      out.questions.push({ question: q, answeredBy: it.has, of: it.of, ours });
      if (it.of >= 1 && !it.has.length) out.unanswered.push(q);
    });
  }

  out.items.sort((a, b) =>
    (Number(b.most) - Number(a.most)) ||
    (b.n / b.of - a.n / a.of) ||
    ((AREA_ORDER[a.area] ?? 9) - (AREA_ORDER[b.area] ?? 9)));
  return out;
}

function makeItem(base, cells, compared) {
  const has = [];
  const lacks = [];
  compared.forEach((k) => {
    const v = cells[k.domain];
    if (v === true) has.push(k.name);
    else if (v === false) lacks.push(k.name);
  });
  const of = has.length + lacks.length;
  return { ...base, cells, has, lacks, n: lacks.length, of, most: of >= 2 && lacks.length >= Math.ceil(of / 2) };
}

// The pages in the topic grid (the competitors we read in full), with their Google position.
function comparedPages(c) {
  const organic = (c.serp && c.serp.organic) || [];
  const comps = c.competitors || [];
  const posOf = (d) => {
    const o = organic.find((r) => r.domain === d);
    if (o) return o.position;
    const x = comps.find((r) => r.domain === d);
    return x && x.position ? x.position : null;
  };
  let cols = (c.topics && Array.isArray(c.topics.columns) ? c.topics.columns : [])
    .map((k) => ({ domain: k.domain, name: k.name || displayName(k.domain), short: k.short || k.name || displayName(k.domain) }));
  if (!cols.length) {
    cols = comps.filter((x) => x && x.fetched && x.domain)
      .map((x) => ({ domain: x.domain, name: displayName(x.domain), short: displayName(x.domain).slice(0, 14) }));
  }
  return cols.map((k) => ({ ...k, position: posOf(k.domain) }));
}
