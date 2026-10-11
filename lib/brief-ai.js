// lib/brief-ai.js
// AI layer for the Content Brief (v2). The data sections and the what/why/where action list
// are built without AI in lib/brief.js. This step only adds what needs writing:
// a "how we win" line, title/meta/H1 options, an H2 outline, 2–4 extra original-value
// actions, and FAQ questions. The schema is small on purpose so models fill it reliably.
//
// Env: OPENAI_API_KEY (required) · OPENAI_BRIEF_MODEL (optional, else OPENAI_MODEL, else gpt-4o-mini)

export async function writeBriefWithAi(c) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return { skipped: true, reason: "OPENAI_API_KEY not set" };
  const model = process.env.OPENAI_BRIEF_MODEL || process.env.OPENAI_MODEL || "gpt-4o-mini";

  const system =
    "You are the head of research content at a B2B market-research publisher and an expert in Google Search. " +
    "You write short, specific briefs that research analysts can act on immediately. " +
    "Never invent statistics, dates or URLs. Respond with strict JSON only.";
  const messages = [
    { role: "system", content: system },
    { role: "user", content: JSON.stringify({ task: taskText(c), data: compact(c) }) },
  ];

  let res = await callOpenAi(key, { model, temperature: 0.3, response_format: { type: "json_object" }, messages });
  if (res.retryWithoutTemperature) res = await callOpenAi(key, { model, response_format: { type: "json_object" }, messages });
  if (res.error) return { error: res.error };

  let parsed;
  try { parsed = JSON.parse(res.content || "{}"); }
  catch { return { error: "AI returned non-JSON output." }; }
  return sanitise(parsed, model);
}

async function callOpenAi(key, payload) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 50000);
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

function taskText(c) {
  const kind = c.contentType === "blog" ? "blog article" : "market research report page";
  const example = {
    howToWin: "Two short sentences: what the top pages have in common, and exactly how our page will be more useful.",
    h1: "One H1 that contains the keyword",
    titles: ["Title 1", "Title 2", "Title 3"],
    metas: ["Meta description 1", "Meta description 2"],
    outline: [{ h2: "H2 heading", write: "One short line: what to write and which data to use" }],
    extraActions: [{ what: "One specific thing to add", why: "Why it beats these competitors", where: "Exactly where on the page" }],
    faqs: ["Question 1", "Question 2"],
  };
  return [
    `Write the AI parts of a content brief for a ${kind} targeting data.keyword in country "${c.gl}".`,
    "Use ONLY the supplied data: Google top 10, tracked competitors, their keywords, topics and People Also Ask. Name competitors where it helps.",
    "Never invent numbers. Use placeholders such as [USD X.X billion], [X.X%] and [20XX–20XX].",
    "Plain, short English for research analysts. No SEO jargon.",
    "Rules: " + (c.rules || []).join(" "),
    "Return JSON in exactly this shape: " + JSON.stringify(example),
    "titles: exactly 3, each 50–60 characters (count [20XX–20XX] as 9 characters), keyword near the start.",
    "metas: exactly 2, each 140–155 characters.",
    "outline: 8–12 H2s in page order. Include every 'must' topic and most 'should' topics from data.topics.",
    "extraActions: 2–4 items NOT already in data.alreadyPlanned — original value only a research firm can add (primary interviews, pricing, scenarios, proprietary data).",
    "faqs: 5–6 questions; start from data.peopleAlsoAsk.",
  ].join("\n");
}

function compact(c) {
  return {
    keyword: c.keyword,
    contentType: c.contentType,
    country: c.gl,
    top10: (c.serp.organic || []).map((r) => ({ rank: r.position, site: r.name, type: r.type, title: r.title })),
    competitors: (c.competitors || []).filter((x) => x.fetched).map((x) => ({
      name: x.name, rank: x.position, words: x.stats.words, tables: x.stats.tables, faqs: x.stats.faq,
      cagr: x.stats.cagr, period: x.stats.period, mainKeyword: x.mainKeyword, secondaryKeywords: x.secondary,
    })),
    topics: (c.topics.topics || []).filter((t) => t.tier !== "differentiator")
      .map((t) => ({ topic: t.label, tier: t.tier, coveredBy: `${t.count}/${c.topics.pagesCompared}`, weCover: t.ours ?? null })),
    secondaryKeywords: (c.keywords.secondary || []).map((k) => k.phrase),
    peopleAlsoAsk: (c.serp.peopleAlsoAsk || []).map((p) => p.question),
    relatedSearches: c.serp.relatedSearches || [],
    segments: (c.segments || []).map((s) => s.label),
    regions: (c.regions || []).map((r) => r.label),
    companies: (c.companies || []).slice(0, 12).map((x) => x.name),
    targets: { words: c.targets.coverageWords, sections: c.targets.sections, tables: c.targets.tables, faqs: c.targets.faqs },
    alreadyPlanned: (c.actions || []).map((a) => a.what),
    ourPage: c.ourPage ? { words: c.ourPage.words, headings: c.ourPage.headings.slice(0, 30) } : null,
  };
}

const arr = (v) => (Array.isArray(v) ? v : []);
const str = (v) =>
  typeof v === "string" ? v.trim() : v && typeof v === "object" ? String(v.text || v.heading || v.title || v.question || "").trim() : "";
const strs = (v, max) => arr(v).map(str).filter(Boolean).slice(0, max);

function placeholderLen(t) {
  return String(t || "")
    .replace(/\[USD X\.X billion\]/gi, "USD 12.3 billion")
    .replace(/\[20XX[–-]20XX\]/g, "2026–2033")
    .replace(/\[20XX\]/g, "2033")
    .replace(/\[X\.X%\]/g, "9.5%").length;
}

function sanitise(p, model) {
  return {
    model,
    howToWin: str(p.howToWin),
    h1: str(p.h1),
    titles: strs(p.titles, 4).map((text) => ({ text, len: placeholderLen(text) })),
    metas: strs(p.metas, 3).map((text) => ({ text, len: placeholderLen(text) })),
    outline: arr(p.outline).map((o) => ({
      h2: typeof o === "string" ? o.trim() : str(o && (o.h2 || o.heading || o.title)),
      write: typeof o === "string" ? "" : str(o && (o.write || o.notes || o.purpose || o.description)),
    })).filter((o) => o.h2).slice(0, 14),
    extraActions: arr(p.extraActions).map((a) => ({ what: str(a && a.what), why: str(a && a.why), where: str(a && a.where) }))
      .filter((a) => a.what).slice(0, 5),
    faqs: strs(p.faqs, 8),
  };
}
