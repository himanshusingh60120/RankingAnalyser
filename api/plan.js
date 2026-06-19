// api/plan.js
// CONTENT PLANNER: for NEW content you're about to publish.
// Input:  { keyword, content, contentType?: "blog"|"report" }
// Output: competitor benchmarks + AI-suggested H-tag outline, meta title,
//         meta description, and internal/external link targets derived from
//         the competitors' links-per-1000-words ratios applied to YOUR length.
//
// Uses the same fixed 5 competitors and the same fetch/x-ray pipeline as
// /api/analyze, so the benchmarks are consistent across the tool.

import { fetchPage } from "../lib/fetcher.js";
import { xray } from "../lib/xray.js";
import { findCompetitorUrls, keywordMatches } from "../lib/competitors.js";
import { suggestInternalLinks } from "../lib/internal-links.js";
import { refreshAccessToken, queryManyPageMetrics } from "../lib/gsc.js";

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
  });

export async function OPTIONS() {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    },
  });
}

export async function POST(request) {
  let body;
  try { body = await request.json(); }
  catch { return json({ error: "Invalid JSON body" }, 400); }

  const keyword = (body.keyword || "").trim();
  const content = (body.content || "").trim();
  const contentType = body.contentType === "report" ? "report" : "blog"; // planner default: blog

  if (!keyword) return json({ error: "Provide 'keyword'." }, 400);
  if (!content || content.length < 200)
    return json({ error: "Provide 'content' (your draft text, at least ~200 characters)." }, 400);

  // ---- Our draft stats ----
  const ourWords = content.split(/\s+/).filter(Boolean).length;

  // ---- Find + x-ray competitor pages (same fixed 5, same matching rules) ----
  const compUrls = await findCompetitorUrls(keyword, contentType);
  const comps = [];
  await Promise.all(
    compUrls.map(async (c) => {
      if (!c.url) { comps.push({ site: c.site, found: false }); return; }
      const f = await fetchPage(c.url);
      if (f.status !== 200 || !f.html) {
        comps.push({ site: c.site, url: c.url, found: true, fetched: false });
        return;
      }
      const x = xray(c.url, f.status, f.html);
      // Verify against the page's own <title>; a slug-probed URL is fabricated
      // from the keyword and must not self-validate (real-search/manual URLs may).
      const titleMatch = keywordMatches(keyword, "", x.title);
      const urlTrustworthy = c.method !== "slug-probe";
      if (!(titleMatch || (urlTrustworthy && keywordMatches(keyword, c.url, "")))) {
        comps.push({ site: c.site, url: c.url, found: true, fetched: true, keywordMatch: false });
        return;
      }
      comps.push({
        site: c.site, url: c.url, found: true, fetched: true, keywordMatch: true,
        title: x.title, titleLen: x.titleLen, metaDesc: x.metaDesc, metaDescLen: x.metaDescLen,
        contentWords: x.contentWords,
        headings: x.headingTree,
        internalLinks: x.inContentInternal.length,
        externalLinks: x.inContentExternal.length,
        internalAnchors: x.inContentInternal.slice(0, 10).map((l) => l.anchor),
        externalDomains: [...new Set(x.inContentExternal.map((l) => {
          try { return new URL(l.href).hostname.replace(/^www\./, ""); } catch { return null; }
        }).filter(Boolean))].slice(0, 8),
      });
    })
  );

  const matched = comps.filter((c) => c.keywordMatch);

  // ---- Link-ratio math: competitors' links per 1000 content words, applied
  //      to YOUR word count. This is the "ratio must be handled" core. ----
  let linkTargets = null;
  // Per request: benchmark competitors on the REPORT CONTENT and the INTERNAL
  // links *inside that content* only. Outbound (external-domain) links are NOT
  // counted toward the competitor benchmark — external citations are suggested
  // separately from editorial best practice (E-E-A-T), not from competitor counts.
  const extBestPracticePer1k = contentType === "blog" ? 2.5 : 2.0;
  if (matched.length) {
    const per1k = (n, w) => (w > 0 ? (n / w) * 1000 : 0);
    const avg = (arr) => arr.reduce((a, b) => a + b, 0) / arr.length;
    const internalPer1k = avg(matched.map((c) => per1k(c.internalLinks, c.contentWords)));
    const avgCompWords = Math.round(avg(matched.map((c) => c.contentWords)));
    // Recommend slightly above the competitor average (to win, not tie),
    // with sane floors/ceilings for the content type.
    const rec = (ratio, floorMin, cap) =>
      Math.min(cap, Math.max(floorMin, Math.round((ratio * ourWords) / 1000 * 1.15)));
    linkTargets = {
      ourWords,
      avgCompetitorWords: avgCompWords,
      competitorInternalPer1000Words: +internalPer1k.toFixed(2),
      recommendedInternalLinks: rec(internalPer1k, contentType === "blog" ? 3 : 4, 25),
      recommendedExternalLinks: Math.max(contentType === "blog" ? 2 : 1, Math.round((extBestPracticePer1k * ourWords) / 1000)),
      note: "Internal-link target = competitors' INTERNAL links per 1000 content words applied to your draft (+15% to lead). External citations follow editorial best practice; competitors' outbound links are not counted.",
    };
  } else {
    // No matched competitors — fall back to editorial best-practice ratios.
    const ratio = contentType === "blog"
      ? { internal: 3.5, external: 2.5 }
      : { internal: 4.5, external: 2.0 };
    linkTargets = {
      ourWords,
      avgCompetitorWords: null,
      recommendedInternalLinks: Math.max(3, Math.round((ratio.internal * ourWords) / 1000)),
      recommendedExternalLinks: Math.max(2, Math.round((ratio.external * ourWords) / 1000)),
      note: "No keyword-matched competitor pages found; counts use standard editorial ratios per 1000 words.",
    };
  }

  // ---- Sitemap-powered REAL internal links (Kings Research own sitemaps) ----
  // These are actual live URLs from the site, with real anchor text, matched
  // to the draft topic — then enriched with GSC position + impressions so the
  // writer links to pages that are actually ranking / getting impressions.
  let internalLinkBlock = { suggestions: [], gscEnriched: false };
  try {
    const selfUrl = (body.url || "").trim() || null;
    const { suggestions } = await suggestInternalLinks(
      keyword, content, selfUrl,
      Math.max(linkTargets.recommendedInternalLinks + 4, 10) // a few extra to choose from
    );

    // Enrich with GSC if a token is available (env fallback, same as analyze).
    const gscToken = body.gscRefreshToken || process.env.GSC_REFRESH_TOKEN || null;
    const gscSite = body.gscSiteUrl || process.env.GSC_SITE_URL || null;
    if (suggestions.length && gscToken && gscSite) {
      try {
        const { access_token } = await refreshAccessToken(gscToken);
        const metrics = await queryManyPageMetrics(access_token, gscSite, body.gscDays || 90);
        for (const s of suggestions) {
          const m = metrics.get(s.url);
          if (m) { s.position = m.position; s.impressions = m.impressions; s.clicks = m.clicks; s.ctr = m.ctr; }
        }
        internalLinkBlock.gscEnriched = true;
        // Prefer pages that already get impressions (they pass more authority).
        suggestions.sort((a, b) => (b.impressions || 0) - (a.impressions || 0) || b.score - a.score);
      } catch (e) {
        internalLinkBlock.gscError = String(e.message || e);
      }
    }
    internalLinkBlock.suggestions = suggestions.slice(0, linkTargets.recommendedInternalLinks + 3);
  } catch (e) {
    internalLinkBlock.error = String(e.message || e);
  }

  // ---- AI: H-tag outline + meta title + meta description vs competitors ----
  let ai = null;
  const key = process.env.OPENAI_API_KEY;
  if (key) {
    try {
      ai = await planWithAi({ key, keyword, contentType, content, ourWords, matched, linkTargets });
    } catch (e) { ai = { error: String(e.message || e) }; }
  } else {
    ai = { skipped: true, reason: "OPENAI_API_KEY not set" };
  }

  return json({
    generatedAt: new Date().toISOString(),
    keyword,
    contentType,
    ourWords,
    competitors: comps,
    linkTargets,
    internalLinks: internalLinkBlock,
    ai,
  });
}

// Deterministically pull the report's OWN headline figures out of the draft so
// the meta is built from real data (the way competitors do) and never invented.
// Values are extracted verbatim and handed to the model with a "use ONLY these"
// instruction, so nothing is hallucinated. Returns nulls when nothing is found.
function extractReportFigures(text = "") {
  const t = String(text).replace(/\s+/g, " ");
  const VAL =
    "(?:USD|US\\$|EUR|€|\\$|£|GBP|INR|₹)\\s?\\d[\\d,]*(?:\\.\\d+)?\\s?" +
    "(?:trillion|billion|million|thousand|tn|bn|mn|k)\\b";
  const values = [
    ...new Set(
      (t.match(new RegExp(VAL, "gi")) || []).map((s) => s.replace(/\s+/g, " ").trim())
    ),
  ];

  const cagrs = [];
  let m;
  const r1 = /(\d{1,2}(?:\.\d+)?)\s?%\s*CAGR/gi;
  const r2 = /CAGR\s+(?:of\s+)?(\d{1,2}(?:\.\d+)?)\s?%/gi;
  const r3 = /compound annual growth rate[^%\d]{0,40}?(\d{1,2}(?:\.\d+)?)\s?%/gi;
  while ((m = r1.exec(t))) cagrs.push(m[1] + "%");
  while ((m = r2.exec(t))) cagrs.push(m[1] + "%");
  while ((m = r3.exec(t))) cagrs.push(m[1] + "%");
  const cagr = cagrs.length ? cagrs[0] : null;

  // Canonical "from/valued-at X in YEAR to/reach Z by YEAR" pairs value to year.
  let baseValue = null, forecastValue = null, baseYear = null, forecastYear = null;
  const fromToRe = new RegExp(
    "(?:from|valued at|worth|reach(?:ed|ing)?)\\s+(" + VAL + ")\\s+(?:in\\s+)?(20\\d{2})" +
      "[^.]{0,60}?\\s+(?:to|reach(?:ing)?)\\s+(" + VAL + ")\\s+(?:by\\s+|in\\s+)?(20\\d{2})",
    "i"
  );
  const ft = t.match(fromToRe);
  if (ft) {
    baseValue = ft[1].replace(/\s+/g, " ").trim();
    baseYear = ft[2];
    forecastValue = ft[3].replace(/\s+/g, " ").trim();
    forecastYear = ft[4];
  }

  // Forecast-period range drives the TITLE (e.g. "2026-2034").
  let forecastPeriod = null;
  const rm = t.match(/(20\d{2})\s?(?:-|–|—|to)\s?(20\d{2})/);
  if (rm) forecastPeriod = `${rm[1]}–${rm[2]}`;
  if (!baseYear && rm) baseYear = rm[1];
  if (!forecastYear && rm) forecastYear = rm[2];
  if (!forecastPeriod && baseYear && forecastYear) forecastPeriod = `${baseYear}–${forecastYear}`;

  if (!baseValue && values.length >= 2) { baseValue = values[0]; forecastValue = values[1]; }
  else if (!baseValue && values.length === 1) { forecastValue = values[0]; }

  const hasFigures = !!((baseValue || forecastValue) && cagr) || !!(baseValue && forecastValue);
  return {
    hasFigures, baseValue, baseYear, forecastValue, forecastYear, cagr, forecastPeriod,
    allValues: values, allCagrs: [...new Set(cagrs)],
  };
}

async function planWithAi({ key, keyword, contentType, content, ourWords, matched, linkTargets }) {
  const model = process.env.OPENAI_MODEL || "gpt-4o-mini";
  const isBlog = contentType === "blog";

  // Trim very long drafts to keep tokens sane; structure comes from the
  // full flow of the text, so keep head + tail.
  const MAX = 9000;
  const draft = content.length > MAX
    ? content.slice(0, MAX * 0.7) + "\n[...trimmed...]\n" + content.slice(-MAX * 0.3)
    : content;

  // Pull the report's own size/CAGR/forecast figures from the FULL draft (not the
  // trimmed copy) so the meta can be built from real data instead of generic copy.
  const figures = extractReportFigures(content);

  const compBrief = matched.map((c) => ({
    site: c.site,
    title: c.title,
    metaDescription: c.metaDesc || "",
    contentWords: c.contentWords,
    headings: (c.headings || []).map(([l, t]) => `H${l}:${t}`).slice(0, 30),
    // Only INTERNAL in-content anchors — outbound/external links are excluded
    // from the competitor benchmark (see linkTargets note).
    internalAnchors: c.internalAnchors,
  }));

  const sys = isBlog
    ? "You are a senior SEO editor for B2B blog articles at a market-research publisher. " +
      "You structure draft content for maximum ranking: intent-matching H1, question-style " +
      "H2/H3s that win featured snippets and People-Also-Ask, skimmable hierarchy, E-E-A-T. " +
      "You ONLY structure content that already exists in the supplied draft — you never invent " +
      "sections or recommend headings for topics the draft does not contain. When no competitor " +
      "data is supplied, you apply technical-SEO best practice for the content type. Respond in strict JSON only."
    : "You are a senior SEO editor for market-research report pages. You structure content " +
      "for depth, topical authority, and AI-Overview readiness. You ONLY structure content that " +
      "already exists in the supplied draft — you never invent sections or recommend headings for " +
      "topics the draft does not contain. When no competitor data is supplied, you apply technical-SEO " +
      "best practice for the content type. Respond in strict JSON only.";

  const hasComps = compBrief.length > 0;
  const user = JSON.stringify({
    task:
      "First READ and UNDERSTAND our draft content below; every suggestion must be grounded in what the draft actually says. " +
      (hasComps
        ? "You are also given competitor pages' titles, meta descriptions and heading structures for the same keyword — use them as the benchmark to beat. "
        : "No competitor pages were available for this keyword — fall back to technical-SEO best practice for this content type. ") +
      "Produce: " +
      "'headingOutline' = ordered array of {level:'H1'|'H2'|'H3', text, mapsTo}. CRITICAL CONSTRAINT: build the outline ONLY from " +
      "material that ALREADY EXISTS in our draft. Every heading must label a block of text that is actually present in the draft, and " +
      "'mapsTo' MUST be the first ~8 words of the real draft paragraph where that section begins. Do NOT invent, add, or recommend " +
      "headings for any topic the draft does not already cover, and do NOT output '[ADD]' or placeholder headings. Exactly one H1. " +
      "Cover every major topic shift that is genuinely in the draft. Use the keyword naturally in the H1 and 1-2 H2s where the draft supports it, no stuffing. " +
      // ---- META: built from the report's OWN figures; year required; length enforced ----
      (figures.hasFigures
        ? "The draft contains this report's own market figures (provided below as detectedFigures). Build the meta around THOSE exact values — never alter them, and never introduce a number that is not in detectedFigures. "
        : "No market-size or CAGR figures were detected in the draft. Do NOT invent any; write benefit-led meta from the draft's real content and use figuresNote to tell the user that adding the market size, CAGR and forecast years to the page is the single biggest meta win, because every ranking competitor leads with those numbers. ") +
      "'metaTitle' = ONE title, 50-60 characters, the keyword phrase near the front, compelling, not clickbait. " +
      (figures.forecastPeriod || figures.forecastYear
        ? "The title MUST include the forecast year: use detectedFigures.forecastPeriod (e.g. '2026–2034'), or if absent 'to ' + detectedFigures.forecastYear. "
        : "If the draft states a forecast year, put it in the title; otherwise omit it — do not fabricate a year. ") +
      (hasComps
        ? "Differentiate from the competitor titles provided (cover the value they signal without copying their wording). "
        : "Follow report-page title best practice. ") +
      "'metaTitleAlternates' = 2 alternates, also 50-60 chars, each carrying the forecast year/range when one is available. " +
      "'metaDescription' = ONE description that is 140-155 characters — COUNT the characters and never return fewer than 140. " +
      (figures.hasFigures
        ? "Lead with the market-size trajectory and CAGR using ONLY detectedFigures, e.g. 'Marine collagen market to reach USD <forecastValue> by <forecastYear>, a <cagr> CAGR from USD <baseValue> in <baseYear>, driven by …', then fill to 140-155 with a concrete driver or segment taken from the draft. "
        : "Lead with the keyword and the strongest concrete driver, segment, or player actually in the draft, expanding with real detail until it reaches 140-155 characters. ") +
      (hasComps
        ? "Position it to stand out against the competitor meta descriptions provided (do not copy their phrasing). "
        : "") +
      "'metaDescriptionAlternates' = 2 alternates, EACH 140-155 characters (never under 140), following the same figure rules. " +
      "'figuresNote' = ONE short sentence: if you used detected figures, state them (e.g. 'Used your data: USD 1.37B → USD 2.82B at 9.5% CAGR, 2026–2034'); if figures were missing, tell the user to add market size + CAGR + forecast years to the page so the meta can lead with them. " +
      `'linkPlan' = object {externalSuggestions: array of {anchorText, sourceType, why} ` +
      `(suggest ${linkTargets.recommendedExternalLinks} items from editorial best practice, sourceType like 'government/regulator', ` +
      "'standards body', 'primary research', 'industry association' — name the type, not invented URLs; anchor texts must come from or fit naturally into the draft). " +
      "Do NOT suggest internal links — those are provided separately from the site's own sitemaps. " +
      "'notes' = 2-4 short editorial notes on what to strengthen before publishing.",
    keyword,
    contentType,
    ourWords,
    competitorBenchmarks: compBrief,
    detectedFigures: figures,
    draftContent: draft,
  });

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
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
  let parsed;
  try { parsed = JSON.parse(data.choices?.[0]?.message?.content || "{}"); }
  catch { return { error: "AI returned non-JSON output." }; }

  return {
    model,
    headingOutline: Array.isArray(parsed.headingOutline) ? parsed.headingOutline : [],
    metaTitle: parsed.metaTitle || "",
    metaTitleAlternates: Array.isArray(parsed.metaTitleAlternates) ? parsed.metaTitleAlternates : [],
    metaDescription: parsed.metaDescription || "",
    metaDescriptionAlternates: Array.isArray(parsed.metaDescriptionAlternates) ? parsed.metaDescriptionAlternates : [],
    figuresNote: parsed.figuresNote || "",
    detectedFigures: figures,
    linkPlan: parsed.linkPlan || { internalSuggestions: [], externalSuggestions: [] },
    notes: Array.isArray(parsed.notes) ? parsed.notes : [],
  };
}
