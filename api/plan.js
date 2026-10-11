// api/plan.js
// CONTENT BRIEF — for NEW content or a page UPDATE, before publishing.
//
// Input  (POST JSON): { keyword, content, contentType?: "blog"|"report", url?,
//                       publishedDate?: "YYYY-MM-DD", authorName?, authorTitle?, authorUrl? }
// Header: x-brief-key  (required once BRIEF_ACCESS_KEY is set — see lib/guard.js)
//
// Output: live SERP check · competitor benchmarks (benchmarking the page that
//         actually ranks) · SERP-weighted word & link targets · forecast-period
//         freshness vs competitors · topic gaps · draft health · AI outline,
//         meta and FAQs fact-checked against the draft · JSON-LD + schema notes
//         · sitemap internal links (GSC-enriched).
//
// Same fixed 5 competitors and the same fetch/x-ray pipeline as /api/analyze.

import { fetchPage } from "../lib/fetcher.js";
import { xray } from "../lib/xray.js";
import { findCompetitorUrls, keywordMatches, keywordMatchesRelaxed, serpPositions } from "../lib/competitors.js";
import { suggestInternalLinks } from "../lib/internal-links.js";
import { refreshAccessToken, queryManyPageMetrics } from "../lib/gsc.js";
import { guard, preflight } from "../lib/guard.js";

const MAX_CONTENT_CHARS = 60000; // ~10k words: caps OpenAI spend per request
const UNRANKED_WEIGHT = 0.5;     // weight of a benchmarked competitor NOT in Google's top 10

const json = (obj, status = 200, headers = {}) =>
  new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });

const clean = (s, n) => String(s || "").replace(/\s+/g, " ").trim().slice(0, n) || null;
const cleanUrl = (s) => {
  const u = String(s || "").trim();
  return /^https?:\/\/\S+$/i.test(u) ? u.slice(0, 300) : null;
};

export async function OPTIONS(request) {
  return preflight(request, "POST, OPTIONS");
}

export async function POST(request) {
  // ---- Origin + access key + rate limit (lib/guard.js) ----
  const g = guard(request, { bucket: "plan" });
  if (!g.ok) return g.response;
  const H = g.headers;

  let body;
  try { body = await request.json(); }
  catch { return json({ error: "Invalid JSON body" }, 400, H); }

  const keyword = String(body.keyword || "").trim().slice(0, 150);
  const content = String(body.content || "").trim();

  if (!keyword) return json({ error: "Provide 'keyword'." }, 400, H);
  if (!content || content.length < 200)
    return json({ error: "Provide 'content' (your draft text, at least ~200 characters)." }, 400, H);
  if (content.length > MAX_CONTENT_CHARS)
    return json({
      error: `Draft is ${content.length.toLocaleString()} characters; the limit is ${MAX_CONTENT_CHARS.toLocaleString()} per brief. Split very long reports into sections.`,
    }, 413, H);

  // ---- Content type: auto-detected, NOT hard-defaulted to "blog" ----
  const planUrl = cleanUrl(body.url) || "";
  const reportKeyword = /\b(market|industry|forecast|outlook|market size|market share|analysis)\b/i.test(keyword);
  const blogUrl = /\/(blog|insights?|articles?|news|resources?)\//i.test(planUrl);
  let contentType;
  if (body.contentType === "report") contentType = "report";
  else if (body.contentType === "blog") contentType = reportKeyword && !blogUrl ? "report" : "blog";
  else contentType = blogUrl ? "blog" : (reportKeyword ? "report" : "blog");

  // ---- Optional schema inputs (item 3) ----
  const publishedDate = /^\d{4}-\d{2}-\d{2}$/.test(String(body.publishedDate || "")) ? String(body.publishedDate) : null;
  const author = {
    name: clean(body.authorName, 80),
    jobTitle: clean(body.authorTitle, 100),
    url: cleanUrl(body.authorUrl),
  };

  // ---- Draft stats, health checks, the report's own figures ----
  const ourWords = content.split(/\s+/).filter(Boolean).length;
  const draftHealth = draftChecks(keyword, content, ourWords);
  const figures = extractReportFigures(content);

  // ---- Discovery + live SERP check in parallel ----
  const [discovered, serp] = await Promise.all([
    findCompetitorUrls(keyword, contentType),
    serpPositions(keyword),
  ]);

  // ---- Benchmark the page Google actually ranks (item 5) ----
  // If a competitor ranks top-10 with a different URL than discovery found
  // (a press release, a regional variant), Google chose THAT page for this
  // query — benchmarking any other page measures the wrong thing. The
  // discovered URL is kept as a fallback if the ranking page can't be fetched.
  const serpBySite = new Map();
  if (serp && serp.available) {
    for (const r of serp.top10 || []) {
      if (!/\(you\)/.test(r.site) && !serpBySite.has(r.site)) serpBySite.set(r.site, r);
    }
  }
  const targets = discovered.map((c) => {
    const s = serpBySite.get(c.site);
    if (!s) return { ...c, serpPosition: null };
    return {
      site: c.site, url: s.url, method: "serp", serpPosition: s.position,
      discoveredUrl: c.url, discoveredMethod: c.method,
    };
  });

  const comps = await Promise.all(targets.map((t) => benchmarkCompetitor(keyword, t)));
  const matched = comps.filter((c) => c.keywordMatch);
  // Pages whose body parse yielded almost nothing (blocked / JS-rendered)
  // would drag ratios toward zero — excluded from the math, kept in the table.
  const ratioComps = matched.filter((c) => (c.contentWords || 0) >= 150);

  // ---- Freshness (item 6), topic gaps, targets (item 5) ----
  const freshness = freshnessCheck(figures.period, matched);
  const topicGaps = topicGapAnalysis(keyword, content, matched);
  const linkTargets = computeTargets({ ratioComps, matched, ourWords, contentType, serp });

  // ---- Sitemap-powered REAL internal links (own sitemaps, GSC-enriched) ----
  let internalLinkBlock = { suggestions: [], gscEnriched: false };
  try {
    const { suggestions } = await suggestInternalLinks(
      keyword, content, planUrl || null,
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
  let ai;
  const key = process.env.OPENAI_API_KEY;
  if (key) {
    try {
      ai = await planWithAi({ key, keyword, contentType, content, ourWords, matched, linkTargets, topicGaps, figures });
    } catch (e) {
      ai = { error: String(e.message || e) };
    }
    if (ai && !ai.error) {
      ai.guards = applyFactGuards(ai, content);   // item 8 — runs BEFORE meta checks & schema
      ai.metaChecks = metaChecks(keyword, ai);
    }
  } else {
    ai = { skipped: true, reason: "OPENAI_API_KEY not set" };
  }

  // ---- JSON-LD (item 3): real dates only, named analyst, verified FAQs only ----
  const { schema, notes: schemaNotes } = buildSchema({
    keyword, contentType, ai, pageUrl: planUrl || null, publishedDate, author,
  });

  return json({
    generatedAt: new Date().toISOString(),
    keyword,
    contentType,
    ourWords,
    security: g.security,
    serp,
    draftHealth,
    competitors: comps,
    freshness,
    topicGaps,
    linkTargets,
    internalLinks: internalLinkBlock,
    ai,
    schema,
    schemaNotes,
    input: { url: planUrl || null, publishedDate, author },
  }, 200, H);
}

// ---------------------------------------------------------------------------
// Fetch + x-ray one competitor. Tries the ranking URL first, then the
// discovered URL. Ranking pages are accepted as on-topic (Google ranked them
// for this exact query); slug-probed URLs are fabricated and must pass the
// strict title test.
async function benchmarkCompetitor(keyword, t) {
  const base = { site: t.site, serpPosition: t.serpPosition ?? null };
  const candidates = [];
  if (t.url) candidates.push({ url: t.url, method: t.method });
  if (t.discoveredUrl && t.discoveredUrl !== t.url) candidates.push({ url: t.discoveredUrl, method: t.discoveredMethod });
  if (!candidates.length) return { ...base, found: false };

  let lastUrl = candidates[0].url, anyFetched = false, mismatchUrl = null;
  for (const cand of candidates) {
    const f = await fetchPage(cand.url);
    if (f.status !== 200 || !f.html) { lastUrl = cand.url; continue; }
    anyFetched = true;
    const x = xray(cand.url, f.status, f.html);

    const fromSerp = cand.method === "serp";
    const trusted = cand.method !== "slug-probe";
    const titleMatch = keywordMatches(keyword, "", x.title)
      || (trusted && keywordMatchesRelaxed(keyword, cand.url, x.title));
    if (!(fromSerp || titleMatch || (trusted && keywordMatches(keyword, cand.url, "")))) {
      mismatchUrl = cand.url;
      continue;
    }

    const h1 = (x.headingTree || []).find((h) => (Array.isArray(h) ? h[0] : h.level) === 1);
    const per = competitorPeriod({
      title: x.title,
      meta: x.metaDesc,
      h1: h1 ? (Array.isArray(h1) ? h1[1] : h1.text) : "",
      html: f.html,
    });

    return {
      ...base,
      url: cand.url, method: cand.method, isRankingUrl: fromSerp,
      found: true, fetched: true, keywordMatch: true,
      title: x.title, titleLen: x.titleLen, metaDesc: x.metaDesc, metaDescLen: x.metaDescLen,
      contentWords: x.contentWords,
      headings: x.headingTree,
      internalLinks: x.inContentInternal.length,
      externalLinks: x.inContentExternal.length,
      internalAnchors: x.inContentInternal.slice(0, 10).map((l) => l.anchor),
      externalDomains: [...new Set(x.inContentExternal.map((l) => {
        try { return new URL(l.href).hostname.replace(/^www\./, ""); } catch { return null; }
      }).filter(Boolean))].slice(0, 8),
      period: per ? { start: per.start, end: per.end } : null,
      periodSource: per ? per.source : null,
    };
  }
  if (mismatchUrl) return { ...base, url: mismatchUrl, found: true, fetched: true, keywordMatch: false };
  return { ...base, url: lastUrl, found: true, fetched: anyFetched };
}

// ---------------------------------------------------------------------------
// ITEM 5 — SERP-WEIGHTED TARGETS
// Weight = 11 − Google position (#1 → 10×, #10 → 1×); benchmarked but unranked
// competitors → 0.5×. Linear on purpose so the team can verify it by hand.
// Ranked pages dominate, but none is ignored: a single page can rank on
// backlinks/domain age the brief can't copy, so a leader-only target is noisy.
function computeTargets({ ratioComps, matched, ourWords, contentType, serp }) {
  const extPer1k = contentType === "blog" ? 2.5 : 2.0;

  if (!ratioComps.length) {
    const internal = contentType === "blog" ? 3.5 : 4.5;
    return {
      ourWords, basis: "editorial", leader: null,
      avgCompetitorWords: null, recommendedWords: null, wordGap: null,
      recommendedInternalLinks: Math.max(3, Math.round((internal * ourWords) / 1000)),
      recommendedExternalLinks: Math.max(2, Math.round((extPer1k * ourWords) / 1000)),
      note: "No keyword-matched competitor pages found; counts use standard editorial ratios per 1000 words.",
    };
  }

  const anyRanked = ratioComps.some((c) => c.serpPosition);
  for (const c of ratioComps) {
    c.weight = anyRanked ? (c.serpPosition ? 11 - c.serpPosition : UNRANKED_WEIGHT) : 1;
  }
  const wSum = ratioComps.reduce((a, c) => a + c.weight, 0);
  const wAvg = (f) => ratioComps.reduce((a, c) => a + f(c) * c.weight, 0) / wSum;
  const per1k = (n, w) => (w > 0 ? (n / w) * 1000 : 0);

  const avgWords = Math.round(wAvg((c) => c.contentWords));
  const plainAvgWords = Math.round(ratioComps.reduce((a, c) => a + c.contentWords, 0) / ratioComps.length);
  const topCompWords = Math.max(...ratioComps.map((c) => c.contentWords));
  const internalPer1k = wAvg((c) => per1k(c.internalLinks, c.contentWords));
  const leader = anyRanked
    ? ratioComps.filter((c) => c.serpPosition).sort((a, b) => a.serpPosition - b.serpPosition)[0]
    : null;

  // Word target: +10% over the (weighted) average is the margin to win. With
  // a SERP leader, never below the leader's own depth (the price of entry).
  // Without SERP data: floor at 90% of the deepest competitor (previous rule).
  const recommendedWords = leader
    ? Math.max(Math.round(avgWords * 1.1), leader.contentWords)
    : Math.max(Math.round(avgWords * 1.1), Math.round(topCompWords * 0.9));

  const recommendedInternalLinks = Math.min(25, Math.max(
    contentType === "blog" ? 3 : 4,
    Math.round((internalPer1k * ourWords) / 1000 * 1.15)
  ));
  const recommendedExternalLinks = Math.max(contentType === "blog" ? 2 : 1, Math.round((extPer1k * ourWords) / 1000));

  let note;
  if (leader) {
    note = `Targets are weighted by live Google rank (weight = 11 − position; benchmarked-but-unranked = ${UNRANKED_WEIGHT}×), so the pages that actually win this query dominate. ` +
      `Word target = 10% above the weighted average, never below the rank leader's depth (${leader.site}, #${leader.serpPosition}). ` +
      "Internal-link target = weighted internal links per 1000 words applied to your draft (+15% to lead). External citations follow editorial best practice. " +
      "Word count stands in for topical completeness — close the content gaps below rather than padding.";
  } else {
    note = "Internal-link target = competitors' INTERNAL links per 1000 content words applied to your draft (+15% to lead). Word target = 10% above the competitor average (floored at 90% of the deepest competitor). External citations follow editorial best practice.";
    if (serp && serp.available && matched.length) {
      note += " None of the benchmarked pages rank in Google's top 10 for this query, so all count equally — treat these targets as a floor and check the live SERP for what Google is rewarding instead.";
    } else if (!serp || !serp.available) {
      note += " Live SERP data unavailable, so all competitors count equally.";
    }
  }

  return {
    ourWords,
    basis: leader ? "serp-weighted" : "equal-average",
    leader: leader ? { site: leader.site, url: leader.url, position: leader.serpPosition, words: leader.contentWords } : null,
    avgCompetitorWords: avgWords,
    plainAverageWords: plainAvgWords,
    topCompetitorWords: topCompWords,
    recommendedWords,
    wordGap: Math.max(0, recommendedWords - ourWords),
    competitorInternalPer1000Words: +internalPer1k.toFixed(2),
    recommendedInternalLinks,
    recommendedExternalLinks,
    note,
  };
}

// ---------------------------------------------------------------------------
// ITEM 6 — FRESHNESS. Forecast-period detection that rejects "© 2012–2026"
// footers, historical-only ranges and implausible spans.
function findPeriods(text) {
  const t = String(text || "");
  const year = new Date().getUTCFullYear();
  const out = [];
  const push = (start, end, idx) => {
    const span = end - start;
    if (span < 3 || span > 16) return;            // forecast windows run ~4–15 years
    if (end < year || end > year + 25) return;    // must reach into the future
    const before = t.slice(Math.max(0, idx - 16), idx).toLowerCase();
    if (/©|copyright|\(c\)/.test(before)) return; // footer copyright ranges
    out.push({ start, end, idx });
  };
  let m;
  const full = /(20\d{2})\s?(?:-|–|—|to)\s?(20\d{2})/gi;
  while ((m = full.exec(t))) push(+m[1], +m[2], m.index);
  const short = /(20\d{2})\s?(?:-|–|—)\s?(\d{2})(?!\d)/g; // "2025-35"
  while ((m = short.exec(t))) push(+m[1], 2000 + +m[2], m.index);
  return out;
}

function pickForecastPeriod(text, mode = "frequent") {
  const ps = findPeriods(text);
  if (!ps.length) return null;
  if (mode === "first") {
    const p = ps.sort((a, b) => a.idx - b.idx)[0];
    return { start: p.start, end: p.end };
  }
  // Body text: the real forecast window repeats; nav/related-report noise doesn't.
  const counts = new Map();
  for (const p of ps) {
    const k = `${p.start}-${p.end}`;
    const cur = counts.get(k) || { start: p.start, end: p.end, n: 0 };
    cur.n++;
    counts.set(k, cur);
  }
  const best = [...counts.values()].sort((a, b) => b.n - a.n || b.end - a.end)[0];
  return { start: best.start, end: best.end };
}

function htmlToText(html) {
  return String(html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&[a-z#0-9]+;/gi, " ")
    .replace(/\s+/g, " ");
}

// Competitors state the window in the title/meta/H1 — check those first.
function competitorPeriod({ title, meta, h1, html }) {
  for (const [source, text] of [["title", title], ["meta", meta], ["h1", h1]]) {
    const p = pickForecastPeriod(text, "first");
    if (p) return { ...p, source };
  }
  const p = pickForecastPeriod(htmlToText(html), "frequent");
  return p ? { ...p, source: "body" } : null;
}

function freshnessCheck(ours, matched) {
  const year = new Date().getUTCFullYear();
  const withP = matched.filter((c) => c.period);
  const flags = [];
  let status = "unknown";

  if (!ours) {
    flags.push("No forecast period found in your draft (e.g. '2026–2034'). Ranking reports put it in the title and opening — add yours.");
  } else {
    if (ours.start < year - 1) {
      flags.push(`Your forecast window starts in ${ours.start}, which reads as dated in ${year}. Refresh the base year if newer data exists.`);
    }
    if (withP.length) {
      const newer = withP.filter((c) => c.period.end > ours.end || c.period.start > ours.start);
      if (newer.length) {
        status = "behind";
        for (const c of newer) {
          flags.push(`${c.site}${c.serpPosition ? ` (#${c.serpPosition} on Google)` : ""} shows ${c.period.start}–${c.period.end}; your draft shows ${ours.start}–${ours.end}. Searchers see years right in the results — a newer range is an easy reason to click a competitor instead.`);
        }
      } else {
        const maxEnd = Math.max(...withP.map((c) => c.period.end));
        const maxStart = Math.max(...withP.map((c) => c.period.start));
        status = ours.end > maxEnd || ours.start > maxStart ? "ahead" : "level";
      }
    }
  }

  return {
    currentYear: year,
    ours: ours || null,
    status,
    flags,
    competitors: matched.map((c) => ({
      site: c.site, period: c.period || null, source: c.periodSource || null, serpPosition: c.serpPosition ?? null,
    })),
  };
}

// ---------------------------------------------------------------------------
// ITEM 8 — FACT GUARDS. Deterministic checks on the AI output against the
// draft: numbers must exist in the draft, mapsTo quotes must be real passages.
function normText(s) {
  return String(s || "").toLowerCase()
    .replace(/[\u2018\u2019\u201C\u201D'"]/g, "")
    .replace(/(\d),(?=\d{3}\b)/g, "$1")   // 1,370 -> 1370
    .replace(/(?<!\d)\.|\.(?!\d)/g, " ")  // keep decimal points, drop sentence dots
    .replace(/[^a-z0-9%.\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function numbersIn(s) {
  return (String(s || "").match(/\d[\d,]*(?:\.\d+)?/g) || [])
    .map((n) => n.replace(/,/g, "").replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, ""));
}

function mapsToFound(mapsTo, draftNorm) {
  const m = normText(mapsTo);
  if (!m) return false;
  if (draftNorm.includes(m)) return true;
  const w = m.split(" ");
  return w.length >= 5 && draftNorm.includes(w.slice(0, 5).join(" "));
}

function applyFactGuards(ai, content) {
  const draftNorm = normText(content);
  const draftNums = new Set(numbersIn(content));
  // Single-digit integers are skipped ("top 5 players" vs "five") to avoid noise.
  const badNums = (s) => numbersIn(s).filter((n) => !/^\d$/.test(n) && !draftNums.has(n));

  const issues = [];
  const out = {
    issues, metaTitleSwapped: false, metaDescriptionSwapped: false,
    alternatesRemoved: 0, headingsUnverified: 0, faqsExcludedFromSchema: 0, secondaryCorrected: 0,
  };

  // Meta: a number not in the draft is a fabricated claim shown on Google.
  // Promote a clean alternate when the recommended one fails.
  const fixMeta = (primaryKey, altKey, label, flagKey) => {
    const alts = Array.isArray(ai[altKey]) ? ai[altKey] : [];
    const cleanAlts = alts.filter((t) => !badNums(t).length);
    out.alternatesRemoved += alts.length - cleanAlts.length;
    const bad = ai[primaryKey] ? badNums(ai[primaryKey]) : [];
    if (bad.length) {
      if (cleanAlts.length) {
        issues.push(`${label}: the recommended version used number(s) not in your draft (${bad.join(", ")}) — replaced with a verified alternate.`);
        ai[primaryKey] = cleanAlts.shift();
        out[flagKey] = true;
      } else {
        issues.push(`${label}: contains number(s) not found in your draft (${bad.join(", ")}) — verify or edit before publishing.`);
      }
    }
    ai[altKey] = cleanAlts;
  };
  fixMeta("metaTitle", "metaTitleAlternates", "Meta title", "metaTitleSwapped");
  fixMeta("metaDescription", "metaDescriptionAlternates", "Meta description", "metaDescriptionSwapped");
  if (out.alternatesRemoved) issues.push(`${out.alternatesRemoved} meta alternate(s) removed for using numbers not in your draft.`);

  // Headings: each must map to a passage that really exists.
  for (const h of ai.headingOutline || []) {
    h.verified = mapsToFound(h.mapsTo, draftNorm);
    if (!h.verified) out.headingsUnverified++;
  }
  if (out.headingsUnverified) {
    issues.push(`${out.headingsUnverified} heading(s) point to a start passage that isn't in your draft — marked ⚠ in the outline; check placement.`);
  }

  // FAQs: only verified ones go into the schema.
  for (const f of ai.faq || []) {
    const reasons = [];
    if (!mapsToFound(f.mapsTo, draftNorm)) reasons.push("source passage not found in draft");
    const bn = badNums(`${f.question || ""} ${f.answer || ""}`);
    if (bn.length) reasons.push(`number(s) not in draft: ${bn.join(", ")}`);
    f.verified = reasons.length === 0;
    if (!f.verified) { f.guardReasons = reasons; out.faqsExcludedFromSchema++; }
  }
  if (out.faqsExcludedFromSchema) {
    issues.push(`${out.faqsExcludedFromSchema} FAQ(s) failed verification and were left out of the schema — fix or drop them.`);
  }

  // Secondary keywords: recompute "in draft" instead of trusting the model.
  for (const k of ai.secondaryKeywords || []) {
    const actual = !!k.phrase && draftNorm.includes(normText(k.phrase));
    if (k.inDraft !== actual) out.secondaryCorrected++;
    k.inDraft = actual;
  }

  return out;
}

// ---------------------------------------------------------------------------
// Deterministic pre-publish checks on the draft itself (no AI involved).
function draftChecks(keyword, content, ourWords) {
  const lc = content.toLowerCase();
  const kw = keyword.toLowerCase();
  const kwWords = kw.split(/\s+/).filter(Boolean).length || 1;
  const keywordCount = kw ? lc.split(kw).length - 1 : 0;
  const keywordDensityPct = ourWords ? +(((keywordCount * kwWords) / ourWords) * 100).toFixed(2) : 0;
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

  return { keywordCount, keywordDensityPct, keywordInFirst100Words, avgSentenceWords, paragraphs: paras.length, longParagraphs, flags };
}

// ---------------------------------------------------------------------------
// Topic-gap analysis: competitor H2/H3s whose distinctive terms are absent
// from the draft. Lexical and deterministic — the AI only advises what to add.
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
// Server-side meta validation (runs after the fact guards).
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
// ITEM 3 — JSON-LD: real dates only, a named analyst as author when given,
// verified FAQs only, honest notes about what each block does.
function buildSchema({ keyword, contentType, ai, pageUrl, publishedDate, author }) {
  const notes = [];
  const okAi = ai && !ai.error && !ai.skipped;
  const ORG_ID = "https://www.kingsresearch.com/#organization";
  const org = { "@type": "Organization", "@id": ORG_ID, "name": "Kings Research", "url": "https://www.kingsresearch.com" };
  const graph = [org];

  let authorRef = { "@id": ORG_ID };
  if (author && author.name) {
    const slug = author.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    const person = {
      "@type": "Person",
      "@id": author.url ? `${author.url}#person` : `https://www.kingsresearch.com/#author-${slug}`,
      "name": author.name,
      "worksFor": { "@id": ORG_ID },
    };
    if (author.jobTitle) person.jobTitle = author.jobTitle;
    if (author.url) person.url = author.url;
    graph.push(person);
    authorRef = { "@id": person["@id"] };
    if (!author.jobTitle || !author.url) {
      notes.push("Add the analyst's job title and a profile-page URL (bio, credentials) — a named, verifiable expert is a stronger E-E-A-T signal than a name alone.");
    }
  } else {
    notes.push("No analyst named, so the author falls back to the organisation. Fill in 'Author' in the form — a named analyst with a job title and profile page is a stronger E-E-A-T signal.");
  }

  const main = {
    "@type": contentType === "report" ? "Report" : "BlogPosting",
    "headline": ((okAi && ai.metaTitle) || keyword).slice(0, 110),
    "description": (okAi && ai.metaDescription) || undefined,
    "about": keyword,
    "inLanguage": "en",
    "author": authorRef,
    "publisher": { "@id": ORG_ID },
  };
  if (pageUrl) {
    main["@id"] = `${pageUrl}#main`;
    main.url = pageUrl;
    main.mainEntityOfPage = pageUrl;
  } else {
    notes.push("No page URL given — add 'url' and 'mainEntityOfPage' once the page's final URL is known.");
  }

  if (publishedDate) {
    main.datePublished = publishedDate;
    main.dateModified = new Date().toISOString().slice(0, 10);
    notes.push(`datePublished kept as ${publishedDate} (the original publish date); dateModified set to today for this update — change it to the real go-live date if the update ships later.`);
  } else {
    notes.push("datePublished / dateModified are intentionally left out: add them with the real go-live date when the page publishes — never the date this brief was generated.");
  }
  graph.push(main);

  const faqs = okAi && Array.isArray(ai.faq)
    ? ai.faq.filter((f) => f && f.question && f.answer && f.verified !== false)
    : [];
  if (faqs.length) {
    graph.push({
      "@type": "FAQPage",
      ...(pageUrl ? { "@id": `${pageUrl}#faq` } : {}),
      "mainEntity": faqs.map((f) => ({
        "@type": "Question", "name": f.question,
        "acceptedAnswer": { "@type": "Answer", "text": f.answer },
      })),
    });
    notes.push("FAQPage markup is valid, but Google only shows FAQ rich results for authoritative government and health sites. Keep it for machine-readability; the visible on-page FAQ is what earns People-Also-Ask and AI-Overview pickup.");
  }

  return { schema: { "@context": "https://schema.org", "@graph": graph }, notes };
}

// ---------------------------------------------------------------------------
// Pull the report's OWN headline figures out of the draft so the meta is built
// from real data and never invented.
function extractReportFigures(text = "") {
  const t = String(text).replace(/\s+/g, " ");
  const VAL =
    "(?:USD|US\\$|EUR|€|\\$|£|GBP|INR|₹)\\s?\\d[\\d,]*(?:\\.\\d+)?\\s?" +
    "(?:trillion|billion|million|thousand|tn|bn|mn|k)\\b";
  const values = [...new Set((t.match(new RegExp(VAL, "gi")) || []).map((s) => s.replace(/\s+/g, " ").trim()))];

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

  // Forecast period: validated picker (rejects © footers, past-only and
  // implausible ranges) instead of "first year-range in the text".
  const fp = pickForecastPeriod(t, "frequent");
  if (!baseYear && fp) baseYear = String(fp.start);
  if (!forecastYear && fp) forecastYear = String(fp.end);
  let forecastPeriod = fp ? `${fp.start}–${fp.end}` : null;
  if (!forecastPeriod && baseYear && forecastYear) forecastPeriod = `${baseYear}–${forecastYear}`;
  const period = fp || (baseYear && forecastYear && +forecastYear > +baseYear
    ? { start: +baseYear, end: +forecastYear } : null);

  if (!baseValue && values.length >= 2) { baseValue = values[0]; forecastValue = values[1]; }
  else if (!baseValue && values.length === 1) { forecastValue = values[0]; }

  const hasFigures = !!((baseValue || forecastValue) && cagr) || !!(baseValue && forecastValue);
  return {
    hasFigures, baseValue, baseYear, forecastValue, forecastYear, cagr, forecastPeriod, period,
    allValues: values, allCagrs: [...new Set(cagrs)],
  };
}

// ---------------------------------------------------------------------------
async function planWithAi({ key, keyword, contentType, content, ourWords, matched, linkTargets, topicGaps, figures }) {
  const model = process.env.OPENAI_MODEL || "gpt-4o-mini";
  const isBlog = contentType === "blog";

  const MAX = 9000;
  const draft = content.length > MAX
    ? content.slice(0, MAX * 0.7) + "\n[...trimmed...]\n" + content.slice(-MAX * 0.3)
    : content;

  const compBrief = matched.map((c) => ({
    site: c.site,
    serpPosition: c.serpPosition || null,
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
  const missingTopics = ((topicGaps && topicGaps.missing) || []).map((g) => g.topic);

  const user = JSON.stringify({
    task:
      "First READ and UNDERSTAND our draft content below; every suggestion must be grounded in what the draft actually says. " +
      (hasComps
        ? "You are also given competitor pages' titles, meta descriptions and heading structures for the same keyword — use them as the benchmark to beat. Competitors with a serpPosition currently rank on Google for this keyword; treat the best-ranked one as the primary benchmark. "
        : "No competitor pages were available for this keyword — fall back to technical-SEO best practice for this content type. ") +
      "Produce: " +
      "'headingOutline' = ordered array of {level:'H1'|'H2'|'H3', text, mapsTo}. CRITICAL CONSTRAINT: build the outline ONLY from " +
      "material that ALREADY EXISTS in our draft. Every heading must label a block of text that is actually present in the draft, and " +
      "'mapsTo' MUST be the first ~8 words of the real draft paragraph where that section begins, copied EXACTLY. Do NOT invent, add, or recommend " +
      "headings for any topic the draft does not already cover, and do NOT output '[ADD]' or placeholder headings. Exactly one H1. " +
      "Cover every major topic shift that is genuinely in the draft. Use the keyword naturally in the H1 and 1-2 H2s where the draft supports it, no stuffing. " +
      "Prefer QUESTION-phrased H2/H3s (how searchers actually ask) wherever the draft's content answers a question — these win People-Also-Ask and AI Overviews. " +
      (figures.hasFigures
        ? "The draft contains this report's own market figures (provided below as detectedFigures). Build the meta around THOSE exact values — never alter them, and never introduce a number that is not in the draft. "
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
      (hasComps ? "Position it to stand out against the competitor meta descriptions provided (do not copy their phrasing). " : "") +
      "'metaDescriptionAlternates' = 2 alternates, EACH 140-155 characters (never under 140), following the same figure rules. " +
      "'figuresNote' = ONE short sentence: if you used detected figures, state them; if figures were missing, tell the user to add market size + CAGR + forecast years to the page so the meta can lead with them. " +
      "'faq' = 3-5 objects {question, answer, mapsTo}. Each question must be one a real searcher asks about this keyword AND that the draft genuinely answers " +
      "(e.g. market size, growth rate, drivers, leading segment/region/players — only if present in the draft). Each answer: 40-55 words, the FIRST sentence a direct, standalone answer " +
      "(this is what AI Overviews and featured snippets extract), using ONLY facts and figures that appear in the draft. 'mapsTo' = first ~8 words of the draft passage the answer comes from, copied EXACTLY. " +
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

  const arr = (v) => (Array.isArray(v) ? v : []);
  return {
    model,
    headingOutline: arr(parsed.headingOutline),
    metaTitle: parsed.metaTitle || "",
    metaTitleAlternates: arr(parsed.metaTitleAlternates),
    metaDescription: parsed.metaDescription || "",
    metaDescriptionAlternates: arr(parsed.metaDescriptionAlternates),
    figuresNote: parsed.figuresNote || "",
    detectedFigures: figures,
    faq: arr(parsed.faq),
    secondaryKeywords: arr(parsed.secondaryKeywords)
      .map((k) => (typeof k === "string" ? { phrase: k } : k))
      .filter((k) => k && typeof k === "object"),
    gapRecommendations: arr(parsed.gapRecommendations),
    linkPlan: parsed.linkPlan || { externalSuggestions: [] },
    notes: arr(parsed.notes),
  };
}
