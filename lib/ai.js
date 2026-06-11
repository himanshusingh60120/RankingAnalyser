// lib/ai.js
// AI layer: after the cross-site comparison, ask an LLM to synthesize
// (1) concrete additions for your page and (2) a short ready-to-use content
// draft that closes the biggest gaps vs competitors.
//
// Env vars:
//   OPENAI_API_KEY   (required to enable this feature)
//   OPENAI_MODEL     (optional, default "gpt-4o-mini")
//
// If OPENAI_API_KEY is absent, analyze.js simply skips AI and the response
// carries ai: { skipped: true } — the rest of the tool works unchanged.

export async function aiRecommendations({ keyword, target, competitors }) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return { skipped: true, reason: "OPENAI_API_KEY not set" };

  const model = process.env.OPENAI_MODEL || "gpt-4o-mini";

  // ---- Build a compact, factual brief (keep tokens low) ----
  const tgt = {
    url: target.url,
    contentWords: target.xray.contentWords,
    headings: target.xray.headingTree.map(([l, t]) => `H${l}:${t}`).slice(0, 40),
    faqCount: target.xray.faqCount,
    schema: [...new Set(target.xray.schemaBlocks)],
    inContentInternalLinks: target.xray.inContentInternalCount,
    inContentExternalLinks: target.xray.inContentExternalCount,
    hasAuthor: target.xray.hasAuthor,
    hasDates: target.xray.hasDates,
    topIssues: target.findings
      .filter((f) => f.severity === "critical" || f.severity === "warning")
      .slice(0, 10)
      .map((f) => `${f.category}: ${f.message}`),
  };

  const comps = competitors
    .filter((c) => c.fetched && c.xray && c.keywordMatch !== false)
    .map((c) => ({
      site: c.site,
      contentWords: c.xray.contentWords,
      headings: (c.xray.headingTree || []).map(([l, t]) => `H${l}:${t}`).slice(0, 35),
      faqCount: c.xray.faqCount,
      schema: [...new Set(c.xray.schemaBlocks || [])],
      tables: c.xray.tables,
      internalLinkAnchors: (c.xray.inContentInternal || [])
        .slice(0, 10)
        .map((l) => l.anchor),
      externalCitations: (c.xray.inContentExternal || [])
        .slice(0, 6)
        .map((l) => l.href),
      topVerdicts: (c.verdict?.reasons || []).slice(0, 5).map((r) => r.factor),
    }));

  if (!comps.length) {
    return { skipped: true, reason: "No keyword-matched competitor pages fetched to compare." };
  }

  const sys =
    "You are a senior SEO content strategist for market-research report pages. " +
    "Recommendations must align with Google's current core-update priorities: " +
    "original people-first depth, E-E-A-T (author/reviewer/dates), topical authority " +
    "via contextual internal links, structured data (FAQPage/Article/Dataset/Breadcrumb), " +
    "data tables, and AI-Overview/People-Also-Ask question coverage. " +
    "Be concrete and specific to THIS keyword and THIS page. Respond in strict JSON only.";

  const user = JSON.stringify({
    task:
      "Compare OUR page against the competitor pages for the keyword. Mix their strengths with ours. " +
      "Return JSON with exactly these keys: " +
      "'additions' = array of 5-9 objects {what, why, how} — concrete things to ADD to our page " +
      "(missing sections/sub-topics competitors cover, schema to add, internal-link anchors to place, " +
      "FAQ questions to add, tables/data to include, E-E-A-T elements). " +
      "'contentDraft' = a 250-400 word ready-to-publish content block in US English for our page that " +
      "fills the biggest content gaps vs competitors (new sections with H2/H3 markdown headings, " +
      "keyword used naturally, no fluff, no invented statistics — use placeholders like [X.X%] where a " +
      "real figure is needed). " +
      "'faqSuggestions' = array of 4-6 question strings worth adding to our FAQ.",
    keyword,
    ourPage: tgt,
    competitors: comps,
  });

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      temperature: 0.4,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: sys },
        { role: "user", content: user },
      ],
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    return { error: `OpenAI API ${res.status}: ${errText.slice(0, 300)}` };
  }
  const data = await res.json();
  const raw = data.choices?.[0]?.message?.content || "{}";
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { error: "AI returned non-JSON output.", raw: raw.slice(0, 500) };
  }
  return {
    model,
    additions: Array.isArray(parsed.additions) ? parsed.additions : [],
    contentDraft: typeof parsed.contentDraft === "string" ? parsed.contentDraft : "",
    faqSuggestions: Array.isArray(parsed.faqSuggestions) ? parsed.faqSuggestions : [],
  };
}
