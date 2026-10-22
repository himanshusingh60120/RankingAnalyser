// lib/sheet-summary.js
// What the tracking Google Sheet shows for each brief (apps-script/Code.gs writes it):
//   misses   a numbered, plain-language list of what to work on — sections our page lacks vs the page-1
//            competitors, depth, keyword wording, out-of-date numbers, overlapping pages of ours, and
//            gaps from the research team's gap analysis that no competitor covers
//   page1    the ten URLs ranking on Google's first page ("1. Site — URL", ours marked "(you)")
//   tracked  each tracked competitor's Google position (top 20) and the URL that ranks
// Pure functions over data the brief already has — no extra network calls.

import { BRIEF_TRACKED, displayName } from "./brief.js";

const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, "").toLowerCase(); } catch { return ""; } };
const onDomain = (d, base) => !!d && !!base && (d === base || d.endsWith("." + base));
const fmtN = (n) => Number(n).toLocaleString("en-US");

/* ---------- page 1 ---------- */

export function page1List(organic = [], ourDomain = null) {
  return (organic || []).slice(0, 10).map((r) => {
    const dom = String(r.domain || hostOf(r.link)).replace(/^www\./, "");
    return {
      position: r.position,
      site: r.name || displayName(dom),
      url: r.link || "",
      ours: r.type === "ours" || (!!ourDomain && onDomain(dom, ourDomain)),
    };
  });
}

export function page1Text(list) {
  return (list || []).map((r) => `${r.position}. ${r.site}${r.ours ? " (you)" : ""} — ${r.url}`).join("\n");
}

/* ---------- tracked competitors: position + ranking URL ---------- */

// results: [{ domain?, link, position }] sorted by position (top 20). → { [name]: { position, url } }
export function trackedFromResults(results = []) {
  const out = {};
  BRIEF_TRACKED.forEach((t) => {
    const hit = (results || []).find((r) => r && r.position && onDomain(String(r.domain || hostOf(r.link)).replace(/^www\./, ""), t.domain));
    out[t.name] = hit ? { position: hit.position, url: hit.link || "" } : { position: null, url: "" };
  });
  return out;
}

// From a saved brief: page-1 results first (exact ranking URLs), then tracked competitors ranking 11–20.
export function trackedFromBrief(c) {
  const organic = ((c.serp && c.serp.organic) || []).map((r) => ({ domain: r.domain, link: r.link, position: r.position }));
  const comps = (c.competitors || []).filter((x) => x && x.position)
    .map((x) => ({ domain: x.domain || hostOf(x.link), link: x.link, position: x.position }));
  return trackedFromResults([...organic, ...comps].sort((a, b) => a.position - b.position));
}

/* ---------- misses to work on ---------- */

export function briefMisses(c) {
  const out = [];
  const N = (c.topics && c.topics.pagesCompared) || 0;
  const topics = ((c.topics && c.topics.topics) || []).filter((t) => t.tier === "must" || t.tier === "should");

  const kc = c.keywordCheck && !c.keywordCheck.error ? c.keywordCheck : null;
  if (kc && kc.status === "variant" && kc.suggestedKeyword) {
    out.push(`Keyword wording — page 1 says “${kc.variantDisplay}”; use “${kc.suggestedKeyword}” in the title, H1 and first sentence.`);
  }

  if (c.ourPage) {
    const lacking = topics.filter((t) => t.ours === false)
      .sort((a, b) => (a.tier === b.tier ? b.count - a.count : a.tier === "must" ? -1 : 1));
    lacking.slice(0, 8).forEach((t) => {
      out.push(`Missing section “${t.label}” — ${t.count} of ${N} competitors cover it${t.tier === "must" ? " (must have)" : ""}.`);
    });
    const med = c.benchmarks && c.benchmarks.words && c.benchmarks.words.median;
    if (med && c.ourPage.words && c.ourPage.words < med * 0.8) {
      out.push(`Go deeper — our page has ${fmtN(c.ourPage.words)} words; competitors' median is ${fmtN(med)}.`);
    }
  } else {
    const must = topics.filter((t) => t.tier === "must").sort((a, b) => b.count - a.count).map((t) => t.label);
    if (must.length) out.push(`Check our page has every must-have section: ${must.slice(0, 8).join(", ")}.`);
  }

  const FR = c.freshness && !c.freshness.error ? c.freshness : null;
  const staleOurs = FR && (FR.stale || []).find((i) => i.type === "ours");
  if (staleOurs) out.push(`Update our numbers — ${staleOurs.reasons.join("; ")}.`);

  const d = c.dupes;
  if (d && d.checked && d.verdict && !["clear", "ok"].includes(d.verdict) && d.message) out.push(`Fix overlapping pages — ${d.message}`);

  const G = c.gap && Array.isArray(c.gap.missing) ? c.gap : null;
  if (G) G.missing.slice(0, 5).forEach((m) => out.push(`Own the gap competitors leave — ${m.topic}.`));

  if (!c.ourPage) {
    const main = d && Array.isArray(d.pages) ? d.pages.find((p) => /main/i.test(p.role || "")) : null;
    out.push(`For an exact section-by-section list, regenerate the brief with our page under “Your existing page & language”${main && main.url ? ` (${main.url})` : ""}.`);
  }
  return out;
}

/* ---------- everything the sheet needs for one brief ---------- */

export function sheetSummary(c) {
  const misses = briefMisses(c);
  const p1 = page1List((c.serp && c.serp.organic) || [], c.ourDomain);
  return {
    misses: misses.map((m, i) => `${i + 1}. ${m}`).join("\n"),
    missesCount: misses.length,
    page1: page1Text(p1),
    tracked: trackedFromBrief(c),
    ourUrl: (c.ourRank && (c.ourRank.link || c.ourRank.url)) || (c.ourPage && c.ourPage.url) || "",
    top1: p1[0] ? `${p1[0].site} — ${p1[0].url}` : "",
  };
}
