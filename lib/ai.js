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

export async function aiRecommendations({ keyword, contentType = "report", target, competitors }) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return { skipped: true, reason: "OPENAI_API_KEY not set" };

  const model = process.env.OPENAI_MODEL || "gpt-4o-mini";
  const isBlog = contentType === "blog";

  // ---- Build a compact, factual brief (keep tokens low) ----
  const tgt = {
    url: target.url,
    contentWords: target.xray.contentWords,
    headings: target.xray.headingTree.map(([l, t]) => `H${l}:${t}`).slice(0, 40),
    faqCount: target.xray.faqCount,
    existingFaqQuestions: target.xray.faqQuestions || [],
    schema: [...new Set(target.xray.schemaBlocks)],
    schemaDetail: target.xray.schemaDetail || [],
    hasFaqPage: target.xray.hasFaqPage,
    hasArticle: target.xray.hasArticle,
    hasBreadcrumb: target.xray.hasBreadcrumb,
    hasDataset: target.xray.hasDataset,
    hasReviewer: target.xray.hasReviewer,
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
      faqQuestions: (c.xray.faqQuestions || []).slice(0, 15),
      schema: [...new Set(c.xray.schemaBlocks || [])],
      hasFaqPage: c.xray.hasFaqPage,
      hasArticle: c.xray.hasArticle,
      hasBreadcrumb: c.xray.hasBreadcrumb,
      hasDataset: c.xray.hasDataset,
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

  const sys = isBlog
    ? "You are a senior SEO content strategist for B2B BLOG ARTICLES (market-research publisher). " +
      "Blog ranking science differs from report pages. Prioritize: search-intent match in H1/intro, " +
      "comprehensive but skimmable structure (clear H2/H3 question-style headings), original insight and " +
      "first-hand expertise (E-E-A-T: named author, bio, dates), citations to authoritative external sources " +
      "(gov/standards bodies/primary research), contextual internal links to related articles AND one natural " +
      "link to the matching commercial report page, featured-snippet-ready definitions, readability " +
      "(short paragraphs), freshness, and Article/BlogPosting schema. FAQ schema is optional for blogs. " +
      "Be concrete and specific to THIS keyword and THIS article. You are also a structured-data expert who outputs only valid schema.org JSON-LD. Respond in strict JSON only."
    : "You are a senior SEO content strategist for market-research report pages. " +
      "Recommendations must align with Google's current core-update priorities: " +
      "original people-first depth, E-E-A-T (author/reviewer/dates), topical authority " +
      "via contextual internal links, structured data (FAQPage/Article/Dataset/Breadcrumb), " +
      "data tables, and AI-Overview/People-Also-Ask question coverage. " +
      "Be concrete and specific to THIS keyword and THIS page. You are also a structured-data expert who outputs only valid schema.org JSON-LD. Respond in strict JSON only.";

  const user = JSON.stringify({
    task:
      `Compare OUR ${isBlog ? "blog article" : "report page"} against the competitor ${isBlog ? "articles" : "pages"} for the keyword. Mix their strengths with ours. ` +
      "CRITICAL: ourPage.existingFaqQuestions and ourPage.headings list what we ALREADY have. " +
      "Do NOT suggest anything we already cover — only genuinely NEW, non-overlapping additions. " +
      "Return JSON with exactly these keys: " +
      "'additions' = array of 4-8 objects {what, why, how} — concrete things to ADD that we do NOT already have " +
      "(missing sub-topics competitors cover, schema to add, internal-link anchors, tables/data, E-E-A-T elements). " +
      "Skip any addition whose topic already appears in ourPage.headings. " +
      "'contentDraft' = a 250-400 word ready-to-publish content block in US English filling our biggest GENUINE gap " +
      "vs competitors (new H2/H3 sections we lack, keyword used naturally, no invented statistics — use [X.X%] placeholders). " +
      "'faqSuggestions' = array of 3-6 NEW question strings that are NOT semantically equivalent to any in " +
      "ourPage.existingFaqQuestions. If we already cover a topic, do not restate it. If competitors ask questions we " +
      "lack, prioritize those. If we already cover everything important, return fewer or an empty array — do not pad. " +
      "'faqAssessment' = one sentence on whether our existing FAQ coverage is already strong, and what (if anything) is genuinely missing. " +
      "'schemaSuggestions' = array of 1-5 objects {type, status, why, jsonLd} for the structured data THIS page should have to rank better and win AI Overviews, " +
      "decided from ourPage.schemaDetail (what we already have) versus what competitors use and what this page's content supports. " +
      "type = a schema.org type such as 'FAQPage','Article'/'BlogPosting','BreadcrumbList','Dataset','Organization','WebPage'. " +
      "status = 'missing' if ourPage lacks it, or 'improve' if present but incomplete (cite the missing properties in 'why'). " +
      "Recommend ONLY structured data that genuinely helps; do NOT suggest a type ourPage already implements well, and never recommend FAQPage schema unless the page actually has Q&A content. " +
      "jsonLd = a valid, ready-to-paste application/ld+json STRING for that type — populate fields from ourPage where known and use clear [PLACEHOLDER] tokens for page-specific values (invent no facts, no fake statistics). Keep each snippet minimal but valid, with correct @context and @type. " +
      "'schemaAssessment' = one sentence comparing ourPage's structured data to the competitors and naming the single highest-impact schema change.",
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
    faqAssessment: typeof parsed.faqAssessment === "string" ? parsed.faqAssessment : "",
    schemaSuggestions: Array.isArray(parsed.schemaSuggestions) ? parsed.schemaSuggestions : [],
    schemaAssessment: typeof parsed.schemaAssessment === "string" ? parsed.schemaAssessment : "",
  };
}
