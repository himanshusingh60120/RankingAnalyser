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
    "outline: ordered array of 9–16 H2 sections. Each {heading, priority: 'must'|'should'|'differentiator', purpose: one sentence, analystNotes: 2–4 strings on exact
