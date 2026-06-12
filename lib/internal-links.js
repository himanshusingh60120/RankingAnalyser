// lib/internal-links.js
// Suggests REAL internal links for new content by reading Kings Research's
// own sitemaps (reports, blogs, PR). Each suggestion is a live URL from the
// site, with a generated anchor text, ranked by how well it matches the
// draft's topic. Optionally enriched with GSC position + impressions so the
// writer links to pages that are actually ranking / getting impressions.

import { fetchPage } from "./fetcher.js";

// Kings Research sitemaps to mine for internal-link targets.
export const KR_SITEMAPS = [
  { type: "report", url: "https://www.kingsresearch.com/sitemap-reports.xml" },
  { type: "blog", url: "https://www.kingsresearch.com/sitemap-blogs.xml" },
  { type: "pr", url: "https://www.kingsresearch.com/sitemap-pr.xml" },
];

const GENERIC = new Set([
  "market", "markets", "report", "reports", "size", "share", "growth",
  "industry", "analysis", "global", "forecast", "trends", "outlook", "and",
  "the", "of", "by", "to", "in", "for", "a", "an", "blog", "with", "how",
  "what", "why", "is", "are", "your", "you", "kings", "research", "www",
  "com", "https", "http",
]);

function tokenize(text) {
  return (text || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/[\s-]+/)
    .filter((t) => t.length > 2 && !GENERIC.has(t));
}

// Turn a slug into readable anchor text. report/blog slugs end in -<id>; drop it.
function slugToAnchor(url, type) {
  try {
    const path = new URL(url).pathname.replace(/\/+$/, "");
    let slug = path.split("/").pop() || "";
    slug = slug.replace(/-\d+$/, ""); // strip trailing numeric id
    const words = slug.split(/-+/).filter(Boolean);
    if (!words.length) return null;
    const titled = words
      .map((w) => (w.length <= 3 ? w.toUpperCase() === w ? w : w : w[0].toUpperCase() + w.slice(1)))
      .join(" ");
    // Reports read naturally with "Market" already in the slug; blogs read as titles.
    return titled;
  } catch {
    return null;
  }
}

// Fetch + parse one sitemap into [{ url, type, tokens, anchor }].
async function loadSitemap(sm) {
  try {
    const { status, html } = await fetchPage(sm.url, { retries: 1, timeoutMs: 15000 });
    if (status !== 200 || !html) return [];
    const locs = [...html.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((m) => m[1].trim());
    return locs
      .map((url) => {
        const anchor = slugToAnchor(url, sm.type);
        if (!anchor) return null;
        return { url, type: sm.type, anchor, tokens: tokenize(url + " " + anchor) };
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

let _cache = null;
let _cacheAt = 0;
const CACHE_MS = 10 * 60 * 1000; // 10 min — sitemaps change slowly

export async function loadAllSitemaps() {
  if (_cache && Date.now() - _cacheAt < CACHE_MS) return _cache;
  const lists = await Promise.all(KR_SITEMAPS.map(loadSitemap));
  _cache = lists.flat();
  _cacheAt = Date.now();
  return _cache;
}


/**
 * Core topic tokens of a sitemap entry — derived from its SLUG only (the
 * page's actual subject), not boilerplate. e.g. "software-asset-management-
 * market-3034" -> [software, asset, management].
 */
function coreTokens(url) {
  try {
    let slug = new URL(url).pathname.replace(/\/+$/, "").split("/").pop() || "";
    slug = slug.replace(/-\d+$/, "");
    return tokenize(slug);
  } catch {
    return [];
  }
}

/**
 * Find a phrase in the DRAFT that can serve as the anchor text for a target
 * page. We look for the longest run of the target's core tokens appearing
 * (in any order, near each other) in the draft. Returns the matched draft
 * phrase, or null if the target's topic isn't actually discussed in the draft.
 */
function anchorFromDraft(content, coreToks) {
  if (!coreToks.length) return null;
  const lc = content.toLowerCase();
  // Build candidate phrases from consecutive core tokens, longest first.
  const phrases = [];
  if (coreToks.length >= 2) {
    for (let n = Math.min(coreToks.length, 4); n >= 2; n--) {
      for (let i = 0; i + n <= coreToks.length; i++) {
        phrases.push(coreToks.slice(i, i + n).join(" "));
      }
    }
  }
  phrases.push(...coreToks); // single tokens as a last resort

  for (const p of phrases) {
    // Match the phrase, tolerating a trailing plural 's' on the last word
    // ("virtual machine" ~ "virtual machines"). Word-boundary anchored so we
    // don't match inside a larger word.
    const esc = p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp("\\b" + esc + "s?\\b", "i");
    const m = re.exec(content);
    if (m) return m[0]; // the phrase exactly as it appears in YOUR draft
  }
  return null;
}

/**
 * Suggest internal links for a draft. A target page is only suggested when its
 * core topic is ACTUALLY DISCUSSED in the draft (so a real anchor phrase exists
 * in the pasted text). Anchor text always comes from the draft, never from the
 * destination page title.
 *
 * @returns { entries, suggestions: [{ url, anchor, draftAnchor, type, score }] }
 */
export async function suggestInternalLinks(keyword, content, selfUrl, limit = 8) {
  const entries = await loadAllSitemaps();
  if (!entries.length) return { entries: [], suggestions: [] };

  const draftLc = content.toLowerCase();
  const draftTokenSet = new Set(tokenize(content));
  const keywordTokenSet = new Set(tokenize(keyword));
  const selfPath = (() => { try { return selfUrl ? new URL(selfUrl).pathname.replace(/\/+$/, "") : null; } catch { return null; } })();

  const scored = [];
  for (const e of entries) {
    const core = coreTokens(e.url);
    if (!core.length) continue;

    // STRICT relevance gate: a meaningful share of the page's core topic
    // tokens must appear in the draft. One incidental shared word is NOT enough.
    const present = core.filter((t) => draftTokenSet.has(t));
    const coverage = present.length / core.length;
    // Require either: the full topic phrase covered (>=60% of core tokens),
    // or the keyword's own tokens are the ones matching (the report we sell).
    const keywordOverlap = core.filter((t) => keywordTokenSet.has(t)).length;
    const strongEnough = coverage >= 0.6 || keywordOverlap >= 2;
    if (!strongEnough) continue;

    // The anchor MUST be a phrase that exists in the draft. If we can't find
    // one, the topic isn't really discussed — skip the page entirely.
    const draftAnchor = anchorFromDraft(content, core);
    if (!draftAnchor) continue;
    // Reject weak single-word anchors when the page topic is multi-word
    // (e.g. don't link "software" alone to the SAM report). A real topical
    // match should surface at least a two-word phrase.
    const anchorWordCount = draftAnchor.trim().split(/\s+/).length;
    if (core.length >= 2 && anchorWordCount < 2) continue;

    if (selfPath) {
      try { if (new URL(e.url).pathname.replace(/\/+$/, "") === selfPath) continue; } catch {}
    }

    // Relevance score: core-token coverage + keyword overlap + phrase length.
    const score =
      present.length * 2 +
      keywordOverlap * 3 +
      (draftAnchor.split(/\s+/).length >= 2 ? 2 : 0);

    scored.push({
      url: e.url,
      anchor: draftAnchor,      // the phrase as it appears in YOUR draft
      type: e.type,
      score,
      coverage: +coverage.toFixed(2),
    });
  }

  scored.sort((a, b) => b.score - a.score);

  // De-dupe by URL.
  const seen = new Set();
  const out = [];
  for (const e of scored) {
    if (seen.has(e.url)) continue;
    seen.add(e.url);
    out.push(e);
    if (out.length >= limit) break;
  }
  return { entries, suggestions: out };
}
