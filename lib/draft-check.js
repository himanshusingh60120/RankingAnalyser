// lib/draft-check.js
// Draft checker: scores an analyst's draft against the brief before publishing.
// Input: the brief's 'collected' data, the draft (pasting from Google Docs / Word keeps headings and
// tables; plain text also works), the planned title tag and meta description.
// Output: pass / warn / fail checks, each with what to fix.
// GAP — also checks the fixed M&A / Latest Developments slots and, when a gap analysis is attached,
// its new H2s, Regulatory slot and questions.

import * as cheerio from "cheerio";

const GENERIC = new Set(["market", "markets", "report", "reports", "size", "share", "growth", "industry",
  "analysis", "global", "forecast", "trends", "outlook", "and", "the", "for"]);
const STOP = new Set(["the", "of", "and", "in", "for", "to", "by", "a", "an", "on", "with", "is", "are", "what",
  "how", "which", "who", "why", "will", "does", "do", "can", "at", "as", "or", "from", "this", "that"]);

// Same section tests the brief uses for its competitor topic grid.
const TOPIC_TESTS = {
  "FAQs": /\bfaqs?\b|frequently asked/,
  "Report scope & methodology": /\bscope\b|methodolog|research approach|assumption|data source|report coverage|report attribute|report highlights/,
  "Macro impact (tariffs, geopolitics, AI…)": /impact|tariff|covid|geopolit|inflation|recession|trade war/,
  "Competitive landscape & key players": /competit|key (?:market )?players|\bcompan(?:y|ies)\b|vendor|manufacturer|market share analysis|leading players|market leaders/,
  "Recent developments": /recent development|\bnews\b|merger|acquisition|partnership|\blaunch|expansion|strategic|collaboration/,
  "Regional & country analysis": /region|geograph|north america|europe|asia|latin america|middle east|africa|\bcountr|\bu\.s\.|\bunited states|china|india|japan|germany/,
  "Segmentation by application": /application|use case/,
  "Segmentation by end use / industry": /end[\s-]?use|end[\s-]?user|vertical|by industry|\bindustries\b|\bsector/,
  "Segmentation by type / product": /\btypes?\b|\bproducts?\b|\bcategor|\bgrade/,
  "Other segmentation (component, technology, channel…)": /component|technolog|deployment|distribution|channel|material|\bforms?\b|\bsources?\b|offering|solution|platform|\bservices?\b/,
  "Segmentation overview": /segment/,
  "Market dynamics & growth drivers": /dynamic|driver|driving|growth factor|propel|\bfuel/,
  "Restraints & challenges": /restrain|challenge|barrier|hinder|limitation|pitfall/,
  "Opportunities": /opportunit/,
  "Market trends & innovation": /trend|innovation|emerging|advancement/,
  "Pricing analysis": /\bpric|cost analysis/,
  "Value chain & industry analysis": /value chain|supply chain|ecosystem|porter|pest[le]{2}|\bswot/,
  "Regulatory landscape": /regulat|\bpolic(?:y|ies)\b|\bstandards?\b|compliance|reimbursement/,
  "Investment & funding": /invest|funding|venture/,
  "Market size & forecast": /\bsize\b|forecast|valuation|revenue|volume|projection|\bcagr\b|growth rate/,
  "Market overview & definition": /overview|introduction|definition|\bwhat is\b|summary|snapshot|at a glance|highlights|key (?:insights|findings|takeaways)/,
  "Analyst view & conclusion": /analyst|conclusion|recommendation|verdict/,
};

export function checkDraft(c, { html = "", title = "", meta = "" } = {}) {
  if (!c || !c.keyword || !c.targets || !c.topics) return { error: "Generate or open a brief first." };
  const raw = String(html || "");
  const plain = raw.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  if (plain.length < 300) return { error: "Paste the full draft — at least a few paragraphs." };

  const isHtml = /<(p|h[1-6]|div|table|ul|ol|li|span|br)\b/i.test(raw);
  const $ = cheerio.load(isHtml ? raw : textToHtml(raw));
  $("script, style").remove();
  const text = $.root().text().replace(/\s+/g, " ").trim();
  const words = text ? text.split(" ").length : 0;

  let heads = [];
  $("h1, h2, h3, h4").each((_, el) => {
    const t = $(el).text().replace(/\s+/g, " ").trim();
    if (t) heads.push({ level: Number(String(el.name || el.tagName || "h2").slice(1)) || 2, text: t });
  });
  if (heads.length < 3) heads = heads.concat(guessHeadings($));

  const kwTok = tokens(c.keyword);
  const hasKw = (s) => !kwTok.length || kwTok.every((t) => String(s || "").toLowerCase().includes(t));
  const t = c.targets;
  const isReport = c.contentType !== "blog";
  const out = [];
  const add = (status, check, detail, fix) => out.push({ status, check, detail, fix: status === "pass" ? "" : fix });

  // Title & meta
  const ti = String(title || "").trim();
  if (!ti) add("warn", "Title tag", "No title entered.", "Type the planned title tag in the Title box.");
  else add(ti.length >= 50 && ti.length <= 60 && hasKw(ti) ? "pass" : "fail", "Title tag",
    `${ti.length} characters${hasKw(ti) ? ", keyword included" : ", keyword missing"}.`,
    "Keep it 50–60 characters with the keyword near the start.");
  const me = String(meta || "").trim();
  if (!me) add("warn", "Meta description", "No meta description entered.", "Type the planned meta description in the Meta box.");
  else add(me.length >= 140 && me.length <= 155 && hasKw(me) ? "pass" : "warn", "Meta description",
    `${me.length} characters${hasKw(me) ? ", keyword included" : ", keyword missing"}.`,
    "Aim for 140–155 characters, with the keyword and our headline numbers.");

  // H1 & opening
  const h1 = (heads.find((h) => h.level === 1) || heads[0] || { text: "" }).text;
  add(h1 && hasKw(h1) ? "pass" : "fail", "H1",
    h1 ? `“${h1.slice(0, 90)}”${hasKw(h1) ? "" : " — keyword missing"}` : "No H1 found.",
    "Start with one H1 that contains the keyword (Heading 1 in Google Docs).");
  const first100 = text.split(" ").slice(0, 100).join(" ");
  add(hasKw(first100) ? "pass" : "warn", "Keyword in opening",
    hasKw(first100) ? "Keyword appears in the first 100 words." : "Keyword not found in the first 100 words.",
    "Use the exact keyword in the first sentence.");
  if (isReport) {
    const first = text.split(" ").slice(0, 140).join(" ");
    const hasSize = /(usd|us\$|\$|€|£|inr|₹)\s?\d|\d\s?(billion|million|bn|mn)\b/i.test(first);
    const hasCagr = /cagr|compound annual/i.test(first) && /\d+(\.\d+)?\s?%/.test(first);
    const hasYears = /20\d{2}/.test(first);
    const miss = [!hasSize && "market size", !hasCagr && "CAGR", !hasYears && "forecast years"].filter(Boolean);
    add(miss.length ? "fail" : "pass", "Opening summary",
      miss.length ? `Missing from the first paragraph: ${miss.join(", ")}.` : "Size, CAGR and years appear up top.",
      "State our market size, forecast value, CAGR and period in the first paragraph.");
  }

  // Length
  const [lo, hi] = t.coverageWords;
  add(words >= lo * 0.85 ? "pass" : words >= lo * 0.6 ? "warn" : "fail", "Length",
    `${words.toLocaleString("en-US")} words (competitors cover ${lo.toLocaleString("en-US")}–${hi.toLocaleString("en-US")}).`,
    "Cover the missing topics in more depth — don't pad.");

  // Topics
  const topicList = (c.topics.topics || []).filter((x) => x.tier === "must" || x.tier === "should");
  const headTexts = heads.map((h) => stripKw(h.text, kwTok));
  const covered = (label) => { const re = TOPIC_TESTS[label]; return !re || headTexts.some((h) => re.test(h)); };
  const missMust = topicList.filter((x) => x.tier === "must" && !covered(x.label)).map((x) => x.label);
  const missShould = topicList.filter((x) => x.tier === "should" && !covered(x.label)).map((x) => x.label);
  if (topicList.some((x) => x.tier === "must")) {
    add(missMust.length ? "fail" : "pass", "Must-cover topics",
      missMust.length ? `Missing: ${missMust.join(", ")}.` : "All covered.",
      "Add a heading and a section for each missing topic.");
  }
  if (topicList.some((x) => x.tier === "should")) {
    add(missShould.length > 2 ? "warn" : "pass", "Should-cover topics",
      missShould.length ? `Missing: ${missShould.join(", ")}.` : "All covered.",
      "Add the ones your data supports.");
  }

  // Tables & FAQs
  const tables = $("table").length;
  add(tables >= t.tables ? "pass" : tables ? "warn" : "fail", "Data tables", `${tables} found (target ${t.tables}+).`,
    "Add market size by year, segment share and region share as real tables (Insert → Table), not images.");
  const faqs = countFaqs(heads, text);
  add(faqs >= t.faqs ? "pass" : faqs ? "warn" : "fail", "FAQs", `${faqs} found (target ${t.faqs}+).`,
    "Add an FAQ section with real searcher questions and 2–3 sentence answers.");

  // People Also Ask
  const paa = ((c.serp && c.serp.peopleAlsoAsk) || []).map((p) => p.question);
  const qsAll = heads.map((h) => h.text).concat(text.match(/[A-Z][^?.!]{10,160}\?/g) || []);
  if (paa.length) {
    const answered = paa.filter((q) => qsAll.some((d) => overlap(q, d) >= 0.6));
    const missing = paa.filter((q) => !answered.includes(q));
    add(!missing.length ? "pass" : answered.length ? "warn" : "fail", "People Also Ask",
      `${answered.length}/${paa.length} answered.${missing.length ? " Missing: " + missing.slice(0, 3).map((q) => `“${q}”`).join(", ") : ""}`,
      "Add the missing questions to the FAQ, worded the way people search.");
  }

  // GAP — fixed slots in our report format: M&A / partnerships and latest developments
  if (isReport) {
    const hl = heads.map((h) => h.text.toLowerCase());
    const hasHead = (re) => hl.some((h) => re.test(h));
    const mna = hasHead(/m&a|merger|acqui|partnership|collaborat|alliance|funding|\bdeals?\b/);
    add(mna ? "pass" : "warn", "M&A & partnerships",
      mna ? "Has its own heading." : "No heading on M&A, partnerships or funding.",
      "Add an H3 under Competitive Landscape: one bullet per deal with month, year, companies and value.");
    const devs = hasHead(/recent development|latest development|\bdevelopments\b/);
    add(devs ? "pass" : "warn", "Latest developments",
      devs ? "Has its own heading." : "No heading for recent developments.",
      "Add an H3 with 4–5 dated developments from the last 12–15 months, newest first.");
  }

  // GAP — sections and questions from the research team's gap analysis
  const g = c.gap && Array.isArray(c.gap.pointers) ? c.gap : null;
  if (g) {
    const need = [...(g.regulatory && g.regulatory.required ? [g.regulatory.title] : []), ...(g.newSections || []).map((s) => s.title)];
    if (need.length) {
      const miss = need.filter((n) => !heads.some((h) => overlap(n, h.text) >= 0.5));
      add(miss.length ? "fail" : "pass", "Gap-analysis sections",
        miss.length ? `Missing: ${miss.join(", ")}.` : `All ${need.length} present.`,
        "Add these H2s — they cover what no competitor does, which is our main edge.");
    }
    const gq = (g.faqs || []).slice(0, 10);
    if (gq.length) {
      const missing = gq.filter((q) => !qsAll.some((d) => overlap(q, d) >= 0.6));
      add(missing.length > Math.floor(gq.length / 2) ? "warn" : "pass", "Gap-analysis questions",
        `${gq.length - missing.length}/${gq.length} answered.${missing.length ? " Missing: " + missing.slice(0, 3).map((q) => `“${q}”`).join(", ") : ""}`,
        "Answer them in the FAQ or in the matching section.");
    }
  }

  // Secondary keywords
  const sk = ((c.keywords && c.keywords.secondary) || []).slice(0, 10).map((k) => k.phrase);
  if (sk.length) {
    const ntxt = " " + text.toLowerCase().replace(/([a-z0-9])-([a-z0-9])/g, "$1 $2").replace(/[^a-z0-9& ]/g, " ").replace(/\s+/g, " ") + " ";
    const used = sk.filter((p) => ntxt.includes(" " + p + " "));
    const missing = sk.filter((p) => !used.includes(p));
    add(used.length >= Math.ceil(sk.length / 2) ? "pass" : "warn", "Secondary keywords",
      `${used.length}/${sk.length} used.${missing.length ? " Not used: " + missing.slice(0, 5).join(", ") : ""}`,
      "Work the missing phrases in where they fit naturally.");
  }

  // Trust signals
  const paras = [];
  $("p, div, li").each((_, el) => { const s = $(el).text().replace(/\s+/g, " ").trim(); if (s && s.length < 200) paras.push(s); });
  const byline = paras.some((s) => /^(?:[Bb]y|[Ww]ritten by|[Aa]uthor(?:ed by)?|[Aa]nalyst)\s*[:\-–]?\s+[A-Z][a-z]/.test(s));
  const updated = /last updated|updated on|published on/i.test(text);
  const method = /methodology/i.test(text);
  const yn = (b) => (b ? "✓" : "✗");
  add(byline && updated && method ? "pass" : "warn", "Trust signals",
    `Analyst byline ${yn(byline)} · Last updated ${yn(updated)} · Methodology ${yn(method)}`,
    "Add the analyst byline under the H1, a last-updated date and a short methodology box.");

  // Competitor numbers reused
  const normNum = (s) => String(s || "").toLowerCase().replace(/us\$|\$/g, "usd").replace(/[\s,]/g, "");
  const ntext = normNum(text);
  const reused = [];
  (c.competitors || []).filter((x) => x.stats).forEach((x) => {
    (x.stats.values || []).forEach((v) => { if (v && ntext.includes(normNum(v))) reused.push(`${v} (${x.name})`); });
  });
  add(reused.length ? "fail" : "pass", "Competitor figures",
    reused.length ? `Matches competitor figures: ${reused.slice(0, 3).join(", ")}.` : "No competitor figures found in the draft.",
    "Replace them with our own estimates.");

  const passed = out.filter((r) => r.status === "pass").length;
  return {
    ok: true,
    score: Math.round((passed / out.length) * 100),
    passed,
    total: out.length,
    words,
    headingsFound: heads.length,
    results: out,
    checkedAt: new Date().toISOString(),
  };
}

function countFaqs(heads, text) {
  const idx = heads.findIndex((h) => /faq|frequently asked/i.test(h.text));
  if (idx >= 0) {
    const level = heads[idx].level;
    let n = 0;
    for (let i = idx + 1; i < heads.length && heads[i].level > level; i++) if (/\?\s*$/.test(heads[i].text)) n++;
    if (n) return n;
  }
  const qHeads = heads.filter((h) => /\?\s*$/.test(h.text)).length;
  if (qHeads) return qHeads;
  return (text.match(/[A-Z][^?.!]{10,150}\?/g) || []).length;
}

function guessHeadings($) {
  const out = [];
  $("p").each((_, el) => {
    const $el = $(el);
    const t = $el.text().replace(/\s+/g, " ").trim();
    if (!t || t.length > 110) return;
    const n = t.split(" ").length;
    const bold = $el.find('b, strong, [style*="font-weight:700"], [style*="font-weight: 700"], [style*="font-weight:bold"]').text().trim();
    const looksBold = bold && bold.length >= t.length * 0.8;
    const shortLine = !/[.:;,]$/.test(t) && n <= 12 && /^[A-Z0-9]/.test(t);
    if (n >= 2 && (looksBold || shortLine)) out.push({ level: 2, text: t });
  });
  return out;
}

function textToHtml(raw) {
  return String(raw).split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
    .map((l) => `<p>${l.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</p>`).join("");
}

function tokens(k) {
  return String(k || "").toLowerCase().replace(/[^a-z0-9\s-]/g, " ").split(/[\s-]+/)
    .filter((t) => t.length > 2 && !GENERIC.has(t));
}

function stripKw(s, kwTok) {
  let t = " " + String(s || "").toLowerCase().replace(/[^a-z0-9.&?\s-]/g, " ") + " ";
  for (const k of kwTok) t = t.replace(new RegExp(`\\b${k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}s?\\b`, "g"), " ");
  return t.replace(/\s+/g, " ").trim();
}

const sig = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((w) => w.length > 2 && !STOP.has(w));

function overlap(a, b) {
  const A = new Set(sig(a));
  const B = new Set(sig(b));
  if (!A.size) return 0;
  let n = 0;
  A.forEach((x) => { if (B.has(x)) n++; });
  return n / A.size;
}
