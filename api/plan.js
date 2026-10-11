// api/plan.js
// CONTENT PLANNER / BRIEF: for NEW content you're about to publish.
// Input:  { keyword, content, contentType?: "blog"|"report", url? }
// Output: competitor benchmarks, topic-gap analysis, draft health checks,
//         word & link targets, AI H-tag outline, meta title/description,
//         PAA-style FAQs, ready-to-paste JSON-LD schema, internal links
//         from the site's own sitemaps (GSC-enriched when available).
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

  // ---- Content type: auto-detected, NOT hard-defaulted to "blog" ----
  const planUrl = (body.url || "").trim();
  const reportKeyword = /\b(market|industry|forecast|outlook|market size|market share|analysis)\b/i.test(keyword);
  const blogUrl = /\/(blog|insights?|articles?|news|resources?)\//i.test(planUrl);
  let contentType;
  if (body.contentType === "report") contentType = "report";
  else if (body.contentType === "blog") {
    contentType = reportKeyword && !blogUrl ? "report" : "blog";
  } else {
    contentType = blogUrl ? "blog" : (reportKeyword ? "report" : "blog");
  }

  if (!keyword) return json({ error: "Provide 'keyword'." }, 400);
  if (!content || content.length < 200)
    return json({ error: "Provide 'content' (your draft text, at least ~200 characters)." }, 400);

  // ---- Our draft stats + deterministic pre-publish health checks ----
  const ourWords = content.split(/\s+/).filter(Boolean).length;
  const draftHealth = draftChecks(keyword, content, ourWords);

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
      // A slug-probed URL is fabricated from the keyword and must not
      // self-validate (real-search/manual URLs may).
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
  // Pages whose body parse yielded almost nothing (blocked / JS-rendered)
  // would drag the per-1000-word ratios toward zero — exclude from the math,
  // but keep them visible in the benchmark table.
  const ratioComps = matched.filter((c) => (c.contentWords || 0) >= 150);

  // ---- Topic-gap analysis: what competitors cover that the draft doesn't ----
  const topicGaps = topicGapAnalysis(keyword, content, matched);

  // ---- Link-ratio math + word target ----
  const extBestPracticePer1k = contentType === "blog" ? 2.5 : 2.0;
  let linkTargets = null;

  if (ratioComps.length) {
    const per1k = (n, w) => (w > 0 ? (n / w) * 1000 : 0);
    const avg = (arr) => arr.reduce((a, b) => a + b, 0) / arr.length;
    const internalPer1k = avg(ratioComps.map((c) => per1k(c.internalLinks, c.contentWords)));
    const avgCompWords = Math.round(avg(ratioComps.map((c) => c.contentWords)));
    const topCompWords = Math.max(...ratioComps.map((c) => c.contentWords));
    // Word target: 10% above the competitor average, never below the deepest
    // competitor's 90% mark — depth is the heaviest ranking-verdict factor.
    const recommendedWords = Math.max(
      Math.round(avgCompWords * 1.1),
      Math.round(topCompWords * 0.9)
    );

    const rec = (ratio, floorMin, cap) =>
      Math.min(cap, Math.max(floorMin, Math.round((ratio * ourWords) / 1000 * 1.15)));

    linkTargets = {
      ourWords,
      avgCompetitorWords: avgCompWords,
      topCompetitorWords: topCompWords,
      recommendedWords,
      wordGap: Math.max(0, recommendedWords - ourWords),
      competitorInternalPer1000Words: +internalPer1k.toFixed(2),
      recommendedInternalLinks: rec(internalPer1k, contentType === "blog" ? 3 : 4, 25),
      recommendedExternalLinks: Math.max(contentType === "blog" ? 2 : 1, Math.round((extBestPracticePer1k * ourWords) / 1000)),
      note: "Internal-link target = competitors' INTERNAL links per 1000 content words applied to your draft (+15% to lead). Word target = 10% above the competitor average (floored at 90% of the deepest competitor). External citations follow editorial best practice; competitors' outbound links are not counted.",
    };
  } else {
    const ratio = contentType === "blog"
      ? { internal: 3.5, external: 2.5 }
      : { internal: 4.5, external: 2.0 };
    linkTargets = {
      ourWords,
      avgCompetitorWords: null,
      recommendedWords: null,
      wordGap: null,
      recommendedInternalLinks: Math.max(3, Math.round((ratio.internal * ourWords) / 1000)),
      recommendedExternalLinks: Math.max(2, Math.round((ratio.external * ourWords) / 1000)),
      note: "No keyword-matched competitor pages found; counts use standard editorial ratios per 1000 words.",
    };
  }

  // ---- Sitemap-powered REAL internal links (own sitemaps, GSC-enriched) ----
  let internalLinkBlock = { suggestions: [], gscEnriched: false };
  try {
    const selfUrl = planUrl || null;
    const { suggestions } = await suggestInternalLinks(
      keyword, content, selfUrl,
      Math.max(linkTargets.recommendedInternalLinks + 4, 10)
    );
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
        suggestions.sort((a, b) => (b.impressions || 0) - (a.impressions || 0) || b.score - a.score);
      } catch (e) {
        internalLinkBlock.gscError = String(e.message || e);
      }
    }
    internalLinkBlock.suggestions = suggestions.slice(0, linkTargets.recommendedInternalLinks + 3);
  } catch (e) {
    internalLinkBlock.error = String(e.message || e);
  }

  // ---- AI: outline + meta + FAQs + secondary keywords + gap advice ----
  let ai = null;
  const key = process.env.OPENAI_API_KEY;
  if (key) {
    try {
      ai = await planWithAi({ key, keyword, contentType, content, ourWords, matched, linkTargets, topicGaps });
      ai.metaChecks = metaChecks(keyword, ai);
    } catch (e) { ai = { error: String(e.message || e) }; }
  } else {
    ai = { skipped: true, reason: "OPENAI_API_KEY not set" };
  }

  // ---- Ready-to-paste JSON-LD (Report/Article + FAQPage) ----
  const schema = buildSchema({ keyword, contentType, ai, pageUrl: planUrl || null });

  return json({
    generatedAt: new Date().toISOString(),
    keyword,
    contentType,
    ourWords,
    draftHealth,
    competitors: comps,
    topicGaps,
    linkTargets,
    internalLinks: internalLinkBlock,
    ai,
    schema,
  });
}

// ---------------------------------------------------------------------------
// Deterministic pre-publish checks on the draft itself (no AI involved).
function draftChecks(keyword, content, ourWords) {
  const lc = content.toLowerCase();
  const kw = keyword.toLowerCase();
  const kwWords = kw.split(/\s+/).filter(Boolean).length || 1;
  const keywordCount = kw ? lc.split(kw).length - 1 : 0;
  const keywordDensityPct = ourWords
    ? +(((keywordCount * kwWords) / ourWords) * 100).toFixed(2) : 0;
  const first100 = content.split(/\s+/).slice(0, 100).join(" ").toLowerCase();
  const keywordInFirst100Words = first100.includes(kw);
  const sentences = content.split(/[.!?]+(?:\s|$)/).filter((s) => s.trim().length > 0);
  const avgSentenceWords = sentences.length ? Math.round(ourWords / sentences.length) : 0;
  const paras = content.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const longParagraphs = paras.filter((p) => p.split(/\s+/).length > 150).length;

  const flags = [];
  if (keywordCount === 0) flags.push("Primary keyword never appears verbatim in the draft — use it at least in the opening and one subheading-level sentence.");
  else if (!keywordInFirst100Words) flags.push("Keyword is missing from the first 100 words — open with it; it anchors relevance for both Google and AI Overviews.");
  if (keywordDensityPct > 2.5) flags.push(`Keyword density is ${keywordDensityPct}% — stuffing risk; replace some occurrences with natural variants.`);
  if (avgSentenceWords > 28) flags.push(`Average sentence runs ${avgSentenceWords} words — shorten; concise sentences are extracted into AI Overviews far more often.`);
  if (longParagraphs > 0) flags.push(`${longParagraphs} paragraph(s) exceed 150 words — split them for skimmability.`);
  if (!/\d/.test(content)) flags.push("The draft contains no figures at all — add data points (market size, CAGR, shares); every ranking competitor leads with numbers.");

  return {
    keywordCount, keywordDensityPct, keywordInFirst100Words,
    avgSentenceWords, paragraphs: paras.length, longParagraphs, flags,
  };
}

// ---------------------------------------------------------------------------
// Topic-gap analysis: competitor H2/H3s whose distinctive terms are absent
// from the draft. Purely lexical and deterministic — the AI never invents
// headings for these; it only advises what to add (gapRecommendations).
function topicGapAnalysis(keyword, content, matched) {
  const draftLc = " " + content.toLowerCase().replace(/\s+/g, " ") + " ";
  const kwTokens = new Set(keyword.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
  const GENERIC = new Set(("the a an and or of in on to for by with at from is are was were be been global market markets industry " +
    "report reports overview key top major analysis insight insights outlook forecast size share growth trend trends scope " +
    "segmentation segment segments dynamics landscape summary introduction conclusion what which who how why will its this that " +
    "faq faqs questions frequently asked year years period region regional regions world").split(/\s+/));
  const BOILER = /request|sample|buy now|download|table of content|related report|about (us|the company)|license|pricing|speak to|contact|disclaimer|why (choose|buy)|get in touch/i;

  const topics = new Map();
  for (const c of matched) {
    for (const h of c.headings || []) {
      const lvl = Array.isArray(h) ? h[0] : h.level;
      const text = Array.isArray(h) ? h[1] : h.text;
      if (!text || lvl < 2 || lvl > 3) continue;
      const t = String(text).trim();
      if (t.length < 4 || BOILER.test(t)) continue;
      const tokens = t.toLowerCase().split(/[^a-z0-9%]+/)
        .filter((w) => w.length > 2 && !GENERIC.has(w) && !kwTokens.has(w) && !/^\d+$/.test(w));
      if (!tokens.length) continue;
      const covered = tokens.filter((w) => draftLc.includes(w)).length;
      const coverage = covered / tokens.length;
      const mapKey = [...new Set(tokens)].sort().join("|");
      const cur = topics.get(mapKey) || { topic: t, coverage, sites: new Set() };
      cur.sites.add(c.site);
      cur.coverage = Math.min(cur.coverage, coverage);
      topics.set(mapKey, cur);
    }
  }

  const missing = [], partial = [];
  for (const v of topics.values()) {
    const item = { topic: v.topic, sites: [...v.sites], coverage: +v.coverage.toFixed(2) };
    if (v.coverage === 0) missing.push(item);
    else if (v.coverage < 0.5) partial.push(item);
  }
  const bySites = (a, b) => b.sites.length - a.sites.length;
  missing.sort(bySites); partial.sort(bySites);
  return {
    missing: missing.slice(0, 15),
    partial: partial.slice(0, 10),
    totalCompetitorTopics: topics.size,
    note: "'Missing' = competitor section topics with zero lexical overlap in your draft. Topics covered by more of the 5 sites matter most — they define the expected scope for this keyword.",
  };
}

// ---------------------------------------------------------------------------
// Server-side meta validation so API consumers get a signal, not just the UI.
function metaChecks(keyword, ai) {
  if (!ai || ai.error || ai.skipped) return [];
  const checks = [];
  const kw = keyword.toLowerCase();
  const t = ai.metaTitle || "", d = ai.metaDescription || "";
  if (t && (t.length < 50 || t.length > 60)) checks.push(`Meta title is ${t.length} chars (target 50–60).`);
  if (t && !t.toLowerCase().includes(kw)) checks.push("Meta title does not contain the exact keyword phrase.");
  if (d && d.length < 140) checks.push(`Meta description is ${d.length} chars — pad with a concrete driver/segment to reach 140–155.`);
  if (d && d.length > 160) checks.push(`Meta description is ${d.length} chars — trim to ≤155 or it will truncate.`);
  return checks;
}

// ---------------------------------------------------------------------------
// Ready-to-paste JSON-LD: Report/Article always; FAQPage when FAQs exist.
function buildSchema({ keyword, contentType, ai, pageUrl }) {
  const today = new Date().toISOString().slice(0, 10);
  const headline = ((ai && ai.metaTitle) || keyword).slice(0, 110);
  const description = (ai && ai.metaDescription) || "";
  const org = { "@type": "Organization", "name": "Kings Research", "url": "https://www.kingsresearch.com" };
  const graph = [{
    "@type": contentType === "report" ? "Report" : "Article",
    "headline": headline,
    "description": description,
    "about": keyword,
    "inLanguage": "en",
    "datePublished": today,
    "dateModified": today,
    "author": org,
    "publisher": org,
    ...(pageUrl ? { "url": pageUrl, "mainEntityOfPage": pageUrl } : {}),
  }];
  const faq = (ai && Array.isArray(ai.faq)) ? ai.faq.filter((f) => f && f.question && f.answer) : [];
  if (faq.length) {
    graph.push({
      "@type": "FAQPage",
      "mainEntity": faq.map((f) => ({
        "@type": "Question", "name": f.question,
        "acceptedAnswer": { "@type": "Answer", "text": f.answer },
      })),
    });
  }
  return { "@context": "https://schema.org", "@graph": graph };
}

// ---------------------------------------------------------------------------
// Deterministically pull the report's OWN headline figures out of the draft so
// the meta is built from real data and never invented.
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

async function planWithAi({ key, keyword, contentType, content, ourWords, matched, linkTargets, topicGaps }) {
  const model = process.env.OPENAI_MODEL || "gpt-4o-mini";
  const isBlog = contentType === "blog";

  const MAX = 9000;
  const draft = content.length > MAX
    ? content.slice(0, MAX * 0.7) + "\n[...trimmed...]\n" + content.slice(-MAX * 0.3)
    : content;

  const figures = extractReportFigures(content);

  const compBrief = matched.map((c) => ({
    site: c.site,
    title: c.title,
    metaDescription: c.metaDesc || "",
    contentWords: c.contentWords,
    headings: (c.headings || []).map(([l, t]) => `H${l}:${t}`).slice(0, 30),
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
  const missingTopics = (topicGaps && topicGaps.missing || []).map((g) => g.topic);

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
      "Prefer QUESTION-phrased H2/H3s (how searchers actually ask) wherever the draft's content answers a question — these win People-Also-Ask and AI Overviews. " +
      (figures.hasFigures
        ? "The draft contains this report's own market figures (provided below as detectedFigures). Build the meta around THOSE exact values — never alter them, and never introduce a number that is not in detectedFigures. "
        : "No market-size or CAGR figures were detected in the draft. Do NOT invent any; write benefit-led meta from the draft's real content and use figuresNote to tell the user that adding the market size, CAGR and forecast years to the page is the single biggest meta win, because every ranking competitor leads with those numbers. ") +
      "'metaTitle' = ONE title, 50-60 characters, the EXACT keyword phrase near the front, compelling, not clickbait. " +
      (figures.forecastPeriod || figures.forecastYear
        ? "The title MUST include the forecast year: use detectedFigures.forecastPeriod (e.g. '2026–2034'), or if absent 'to ' + detectedFigures.forecastYear. "
        : "If the draft states a forecast year, put it in the title; otherwise omit it — do not fabricate a year. ") +
      (hasComps
        ? "Differentiate from the competitor titles provided (cover the value they signal without copying their wording). "
        : "Follow report-page title best practice. ") +
      "'metaTitleAlternates' = 2 alternates, also 50-60 chars, each carrying the forecast year/range when one is available. " +
      "'metaDescription' = ONE description that is 140-155 characters — COUNT the characters and never return fewer than 140. " +
      (figures.hasFigures
        ? "Lead with the market-size trajectory and CAGR using ONLY detectedFigures, then fill to 140-155 with a concrete driver or segment taken from the draft. "
        : "Lead with the keyword and the strongest concrete driver, segment, or player actually in the draft, expanding with real detail until it reaches 140-155 characters. ") +
      (hasComps
        ? "Position it to stand out against the competitor meta descriptions provided (do not copy their phrasing). "
        : "") +
      "'metaDescriptionAlternates' = 2 alternates, EACH 140-155 characters (never under 140), following the same figure rules. " +
      "'figuresNote' = ONE short sentence: if you used detected figures, state them; if figures were missing, tell the user to add market size + CAGR + forecast years to the page so the meta can lead with them. " +
      "'faq' = 3-5 objects {question, answer, mapsTo}. Each question must be one a real searcher asks about this keyword AND that the draft genuinely answers " +
      "(e.g. market size, growth rate, drivers, leading segment/region/players — only if present in the draft). Each answer: 40-55 words, the FIRST sentence a direct, standalone answer " +
      "(this is what AI Overviews and featured snippets extract), using ONLY facts and figures from the draft/detectedFigures. 'mapsTo' = first ~8 words of the draft passage the answer comes from. " +
      "If the draft answers fewer than 3 such questions, return fewer and say so in notes — never pad with invented answers. " +
      "'secondaryKeywords' = 5-10 phrases a searcher would use that this page should also rank for — ONLY phrases that already appear in the draft or that label content the draft genuinely covers; mark each as {phrase, inDraft: true|false}. " +
      "'gapRecommendations' = for EACH topic listed in competitorTopicsMissingFromDraft (if any), one object {topic, addWhat} where addWhat is ONE concrete sentence telling the writer what to add to cover it. These are ADVICE for new content to write — do NOT add them to headingOutline. " +
      `'linkPlan' = object {externalSuggestions: array of {anchorText, sourceType, why} ` +
      `(suggest ${linkTargets.recommendedExternalLinks} items from editorial best practice, sourceType like 'government/regulator', ` +
      "'standards body', 'primary research', 'industry association' — name the type, not invented URLs; anchor texts must come from or fit naturally into the draft). " +
      "Do NOT suggest internal links — those are provided separately from the site's own sitemaps. " +
      "'notes' = 2-4 short editorial notes on what to strengthen before publishing.",
    keyword,
    contentType,
    ourWords,
    wordTarget: linkTargets.recommendedWords || null,
    competitorBenchmarks: compBrief,
    competitorTopicsMissingFromDraft: missingTopics,
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
    faq: Array.isArray(parsed.faq) ? parsed.faq : [],
    secondaryKeywords: Array.isArray(parsed.secondaryKeywords) ? parsed.secondaryKeywords : [],
    gapRecommendations: Array.isArray(parsed.gapRecommendations) ? parsed.gapRecommendations : [],
    linkPlan: parsed.linkPlan || { internalSuggestions: [], externalSuggestions: [] },
    notes: Array.isArray(parsed.notes) ? parsed.notes : [],
  };
}
