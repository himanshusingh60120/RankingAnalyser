// lib/brief-ai.js
// AI writer for the Content Brief. Takes the deterministic analysis from lib/brief.js and
// asks the LLM only for what an analyst needs written out: titles/meta, an H2/H3 outline with
// per-section instructions, information-gain angles, FAQs, tables, link plan, E-E-A-T checklist
// and a "don't" list. It is told never to invent figures — numbers stay as [placeholders].
//
// Env: OPENAI_API_KEY (required) · OPENAI_BRIEF_MODEL (optional, else OPENAI_MODEL, else gpt-4o-mini)

import { POLICY_BASELINE, policyPromptText } from "./google-policy.js";

export async function writeBriefWithAi(c) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return { skipped: true, reason: "OPENAI_API_KEY not set" };
  const model = process.env.OPENAI_BRIEF_MODEL || process.env.OPENAI_MODEL || "gpt-4o-mini";
  const isBlog = c.contentType === "blog";

  const system =
    "You are the head of content at a B2B market-research publisher and an expert in Google Search. " +
    "You write content briefs that research analysts (not SEO specialists) follow to produce pages that out-rank the current Google page 1. " +
    "Your briefs are specific to the keyword, grounded only in the supplied page-1 data, written in plain direct English, " +
    "and never invent statistics, dates, quotes or URLs. Respond with strict JSON only.";

  const messages = [
    { role: "system", content: system },
    { role: "user", content: JSON.stringify({ task: taskText(isBlog), data: compact(c) }) },
  ];

  let res = await callOpenAi(key, { model, temperature: 0.35, response_format: { type: "json_object" }, messages });
  // Some newer models only accept the default temperature — retry without it.
  if (res.retryWithoutTemperature) res = await callOpenAi(key, { model, response_format: { type: "json_object" }, messages });
  if (res.error) return { error: res.error };

  let parsed;
  try { parsed = JSON.parse(res.content || "{}"); }
  catch { return { error: "AI returned non-JSON output." }; }
  return sanitise(parsed, model);
}

async function callOpenAi(key, payload) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 52000);
  try {
    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      signal: ctrl.signal,
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!r.ok) {
      const t = await r.text();
      if (r.status === 400 && /temperature/i.test(t) && "temperature" in payload) return { retryWithoutTemperature: true };
      return { error: `OpenAI API ${r.status}: ${t.slice(0, 300)}` };
    }
    const d = await r.json();
    return { content: d.choices?.[0]?.message?.content || "{}" };
  } catch (e) {
    return { error: e.name === "AbortError" ? "AI step timed out. Try again, or set OPENAI_BRIEF_MODEL to a faster model." : String(e.message || e) };
  } finally {
    clearTimeout(timer);
  }
}

function taskText(isBlog) {
  const kind = isBlog ? "B2B blog article" : "market-research report page";
  return [
    `Write a content brief for a ${kind} that must out-rank the current Google page 1 for data.keyword.`,
    "Ground every instruction in the supplied data: page1, topicCoverage (tier must/should/differentiator = how many competitors cover it), peopleAlsoAsk, relatedSearches, segmentation, regions, competitorFigures, companies, benchmarks and ourPage.",
    "NEVER invent statistics, market sizes, CAGRs, years, quotes or URLs. Where a number belongs, write a placeholder such as [USD X.X billion], [X.X%] or [20XX–20XX].",
    "Plain, direct English for research analysts. Every line must be specific to this keyword — no generic SEO advice.",
    `Follow these Google Search rules (baseline ${POLICY_BASELINE}):\n${policyPromptText()}`,
    "Return JSON with exactly these keys:",
    "searchIntent: 2 sentences — who searches this and what they must find on the page.",
    "winningFormula: 2–3 sentences — what page 1 has in common and specifically how our page will be more useful.",
    "h1: one H1 using the keyword naturally.",
    `titleOptions: 3 title tags, each 50–60 characters, keyword near the start${isBlog ? "" : ", with a forecast-period placeholder like [20XX–20XX] if most page-1 titles carry a year"}.`,
    `metaDescriptionOptions: 2 meta descriptions, each 140–155 characters${isBlog ? "" : ", leading with market-size and CAGR placeholders"}.`,
    "urlSlug: short lowercase hyphenated slug.",
    "openingSummary: {guidance: 1–2 sentences on how to write the first ~100 words, mustInclude: 4–7 specific facts to state, as placeholders}.",
    "outline: ordered array of 9–16 H2 sections. Each {heading, priority: 'must'|'should'|'differentiator', purpose: one sentence, analystNotes: 2–4 strings on exactly what to write, dataNeeded: 1–4 strings, sources: 1–3 source TYPES, estWords: integer, h3: array of 0–6 heading strings}. Include every 'must' topic and most 'should' topics; add 1–3 differentiator sections page 1 lacks. Answer peopleAlsoAsk and relatedSearches sub-questions inside these sections — never propose separate pages. No CTA, sample-request or table-of-contents sections. Keep segmentation consistent with what page 1 uses.",
    "informationGain: 3–5 objects {angle, whyItWins (what page 1 lacks), howToExecute} — original, non-commodity value a research firm can genuinely deliver (proprietary estimates, primary interviews, methodology transparency, price or trade data, scenarios).",
    "faqs: 6–8 objects {question, answerGuidance (how to answer in 2–3 sentences, with placeholders), source: 'PAA'|'competitor'|'gap'} — no two alike.",
    "tablesAndCharts: 3–6 objects {title, columnsOrAxes, why}.",
    "companies: {mustProfile: names from data.companies covered by 2+ competitors, consider: other relevant names from data.companies, note: one sentence}.",
    "internalLinkAnchors: 4–8 objects {anchor, linkTo (type of our page, e.g. 'parent industry report', 'segment report', 'related blog'), section}.",
    "externalSources: 3–6 objects {sourceType, useFor} — government statistics, regulators, industry associations, company filings; name a body only if certain it exists.",
    "eeatChecklist: 4–7 strings specific to this page.",
    "doNot: 4–7 strings — concrete mistakes to avoid for this keyword.",
  ].join("\n");
}

// Compact, token-cheap view of the analysis for the model.
function compact(c) {
  const s = c.serp;
  return {
    keyword: c.keyword,
    contentType: c.contentType,
    market: `${c.gl}/${c.hl}`,
    intent: s.intent,
    ourPosition: s.ourPosition,
    page1: s.organic.map((r) => ({
      pos: r.position, domain: r.domain, type: r.type, title: r.title,
      snippet: (r.snippet || "").slice(0, 180),
      words: r.stats?.words ?? null, sections: r.stats?.sections ?? null,
    })),
    aiOverview: s.aiOverview?.present
      ? { text: (s.aiOverview.text || "").slice(0, 800), citedDomains: (s.aiOverview.sources || []).map((x) => x.domain).slice(0, 10) }
      : null,
    peopleAlsoAsk: (s.peopleAlsoAsk || []).map((p) => p.question).slice(0, 10),
    relatedSearches: (s.relatedSearches || []).slice(0, 10),
    topicCoverage: c.topics.topics.slice(0, 45).map((t) => ({
      topic: t.label, tier: t.tier, coveredBy: t.count, of: c.topics.pagesCompared,
      exampleHeadings: t.examples.slice(0, 3), weCover: t.ours ?? null,
    })),
    segmentation: c.segments.slice(0, 10),
    regions: c.regions,
    countries: c.countries.slice(0, 12),
    regionClaims: c.regionClaims,
    competitorFigures: c.figures.rows.slice(0, 10),
    companies: c.companies.slice(0, 25).map((x) => `${x.name} (${x.count})`),
    competitorFaqs: c.questions.filter((q) => q.source !== "People Also Ask").slice(0, 15).map((q) => q.question),
    benchmarks: {
      words: c.benchmarks.words, sections: c.benchmarks.sections, tables: c.benchmarks.tables, faq: c.benchmarks.faq,
      schema: c.benchmarks.schema.slice(0, 8), eeat: c.benchmarks.eeat, titles: c.benchmarks.titles,
    },
    targets: { ...c.targets, schema: undefined },
    ourPage: c.ourPage
      ? { url: c.ourPage.url, words: c.ourPage.words, headings: c.ourPage.headings.slice(0, 40), missingTopics: c.gaps?.missingTopics?.slice(0, 15) || [] }
      : null,
  };
}

const arr = (v) => (Array.isArray(v) ? v : []);
const str = (v) =>
  typeof v === "string" ? v.trim() : v && typeof v === "object" ? String(v.heading || v.text || v.title || "").trim() : "";
const strs = (v, max = 12) => arr(v).map(str).filter(Boolean).slice(0, max);
const withLen = (v, max) => strs(v, max).map((text) => ({ text, len: text.length }));

function sanitise(p, model) {
  return {
    model,
    searchIntent: str(p.searchIntent),
    winningFormula: str(p.winningFormula),
    h1: str(p.h1),
    titleOptions: withLen(p.titleOptions, 3),
    metaDescriptionOptions: withLen(p.metaDescriptionOptions, 3),
    urlSlug: str(p.urlSlug).toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, ""),
    openingSummary: { guidance: str(p.openingSummary?.guidance), mustInclude: strs(p.openingSummary?.mustInclude, 8) },
    outline: arr(p.outline).slice(0, 18).map((o) => ({
      heading: str(o?.heading),
      priority: ["must", "should", "differentiator"].includes(o?.priority) ? o.priority : "should",
      purpose: str(o?.purpose),
      analystNotes: strs(o?.analystNotes, 6),
      dataNeeded: strs(o?.dataNeeded, 5),
      sources: strs(o?.sources, 4),
      estWords: Number.isFinite(+o?.estWords) && +o.estWords > 0 ? Math.round(+o.estWords) : null,
      h3: strs(o?.h3, 8),
    })).filter((o) => o.heading),
    informationGain: arr(p.informationGain).slice(0, 6)
      .map((g) => ({ angle: str(g?.angle), whyItWins: str(g?.whyItWins), howToExecute: str(g?.howToExecute) }))
      .filter((g) => g.angle),
    faqs: arr(p.faqs).slice(0, 10)
      .map((f) => ({ question: str(f?.question), answerGuidance: str(f?.answerGuidance), source: str(f?.source) }))
      .filter((f) => f.question),
    tablesAndCharts: arr(p.tablesAndCharts).slice(0, 8)
      .map((t) => ({
        title: str(t?.title),
        columnsOrAxes: Array.isArray(t?.columnsOrAxes) ? t.columnsOrAxes.map(str).join(", ") : str(t?.columnsOrAxes),
        why: str(t?.why),
      }))
      .filter((t) => t.title),
    companies: { mustProfile: strs(p.companies?.mustProfile, 30), consider: strs(p.companies?.consider, 20), note: str(p.companies?.note) },
    internalLinkAnchors: arr(p.internalLinkAnchors).slice(0, 10)
      .map((x) => ({ anchor: str(x?.anchor), linkTo: str(x?.linkTo), section: str(x?.section) }))
      .filter((x) => x.anchor),
    externalSources: arr(p.externalSources).slice(0, 8)
      .map((x) => ({ sourceType: str(x?.sourceType), useFor: str(x?.useFor) }))
      .filter((x) => x.sourceType),
    eeatChecklist: strs(p.eeatChecklist, 8),
    doNot: strs(p.doNot, 8),
  };
}
