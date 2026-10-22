// lib/sheet-summary.js
// What the tracking Google Sheet shows for each brief (apps-script/Code.gs writes it):
//   misses   "Misses to work on" — what most competitors miss, which we can add to beat them
//            (lib/competitor-gaps.js), plus People Also Ask questions no competitor answers
//   page1    the ten URLs ranking on Google's first page ("1. Site — URL", ours marked "(you)")
//   tracked  each tracked competitor's Google position (top 20) and the URL that ranks
// Pure functions over data the brief already has — no extra network calls.

import { BRIEF_TRACKED, displayName } from "./brief.js";
import { competitorGaps } from "./competitor-gaps.js";

const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, "").toLowerCase(); } catch { return ""; } };
const onDomain = (d, base) => !!d && !!base && (d === base || d.endsWith("." + base));

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

/* ---------- what competitors miss (the "Misses to work on" column) ---------- */

export function gapLines(cg) {
  if (!cg || !Array.isArray(cg.items)) return [];
  const short = (names) => `${names.slice(0, 4).join(", ")}${names.length > 4 ? "…" : ""}`;
  const lines = cg.items
    .filter((it) => it.most && it.area !== "Buyer question")
    .slice(0, 10)
    .map((it) => `${it.label} — ${it.n} of ${it.of} competitors miss it (${short(it.lacks)}). Add: ${it.add}`);
  (cg.unanswered || []).slice(0, 4).forEach((q) => lines.push(`Buyer question no competitor answers: “${q}” — answer it in our FAQ.`));
  return lines;
}

/* ---------- everything the sheet needs for one brief ---------- */

export function sheetSummary(c) {
  let cg = c.competitorGaps || null;
  if (!cg) { try { cg = competitorGaps(c, null); } catch { cg = null; } }
  const lines = gapLines(cg);
  const p1 = page1List((c.serp && c.serp.organic) || [], c.ourDomain);
  return {
    misses: lines.length
      ? lines.map((m, i) => `${i + 1}. ${m}`).join("\n")
      : "No clear gaps — most competitors cover everything we check. Win on fresher numbers, depth and clearer answers.",
    missesCount: lines.length,
    page1: page1Text(p1),
    tracked: trackedFromBrief(c),
    ourUrl: (c.ourRank && (c.ourRank.link || c.ourRank.url)) || (c.ourPage && c.ourPage.url) || "",
    top1: p1[0] ? `${p1[0].site} — ${p1[0].url}` : "",
  };
}
