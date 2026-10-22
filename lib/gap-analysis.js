// lib/gap-analysis.js
// GAP — reads the research team's "Competitor SEO & Content Gap Analysis" for a market and turns it into
// data the writer's skeleton uses (buildSkeleton() in brief.html):
//   pointers      driver / restraint / opportunity / risk / regulation / competition / definition /
//                 regional rows — why, search terms, facts, source links — and where each one goes
//   newSections   the "New: …" H2s the doc recommends, placed where the doc puts them, with their pointers
//   regulatory    the fixed Regulatory Landscape slot: title, what to cover, one entry per country / bloc
//   players, deals, capex, developments   for the Competitive Landscape H3s
//   faqs, missing, structure notes, title tag, RD-sheet edits, items to verify, market-fact sources
//   figureCheck   competitor figures in the doc's benchmark table that don't add up
// Input: a Google Docs link shared "anyone with the link can view", HTML pasted from Google Docs or Word
// (headings, bold and tables survive), or markdown / plain text.
// No AI here: api/brief.js stage "gap" calls phraseGapH3s() in lib/brief-ai.js to word the H3s.

import * as cheerio from "cheerio";
import { checkFigureRows } from "./brief-checks.js";

const MAX_HTML = 3000000;
const withHint = (e, hint) => { e.hint = hint; return e; };

/* ---------------- entry point ---------------- */

export async function readGapAnalysis({ url = "", html = "", text = "", keyword = "", now = new Date() } = {}) {
  let blocks;
  let source;
  if (url) {
    const doc = await fetchGoogleDoc(url);
    blocks = blocksFromHtml(doc.html);
    source = { type: "google-doc", url: doc.url };
  } else if (html && /<(table|h[1-6]|li|p)\b/i.test(html)) {
    blocks = blocksFromHtml(String(html).slice(0, MAX_HTML));
    source = { type: "pasted" };
  } else if (text || html) {
    const t = text || cheerio.load(String(html).replace(/<br\s*\/?>|<\/(?:div|p|li|h[1-6]|tr)>/gi, "\n")).text();
    blocks = blocksFromText(String(t).slice(0, MAX_HTML));
    source = { type: "pasted" };
  } else {
    throw withHint(new Error("Add a Google Doc link or paste the gap analysis."), "");
  }
  const raw = extractGap(blocks);
  if (!raw.pointers.length && !raw.missing.length && !raw.newSections.length) {
    throw withHint(new Error("That doesn't look like a gap analysis."),
      "Expected a “Pointers we should cover” table, a “What competitors are missing” list or a “Recommended page structure” list.");
  }
  return buildGapLayer(raw, { keyword, now, source });
}

async function fetchGoogleDoc(link) {
  const id = (String(link).match(/\/document\/d\/([\w-]{20,})/) || [])[1];
  if (!id) throw withHint(new Error("That isn't a Google Docs link."), "Copy the link from the doc's address bar, or paste the document instead.");
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const res = await fetch(`https://docs.google.com/document/d/${id}/export?format=html`, { redirect: "follow", signal: ctrl.signal });
    const html = res.ok ? await res.text() : "";
    if (!res.ok || /accounts\.google\.com|ServiceLogin/i.test(res.url) || !/<body/i.test(html)) {
      throw withHint(new Error("Couldn't open that Google Doc."),
        "Share it as “Anyone with the link can view” (a Word file in Drive needs File → Save as Google Docs first), or paste the document instead.");
    }
    return { html: html.slice(0, MAX_HTML), url: `https://docs.google.com/document/d/${id}` };
  } catch (e) {
    if (e.hint !== undefined) throw e;
    throw withHint(new Error("Couldn't open that Google Doc."),
      e.name === "AbortError" ? "Google took too long to respond — try again, or paste the document." : "Paste the document instead.");
  } finally {
    clearTimeout(timer);
  }
}

/* ---------------- 1. document → blocks ---------------- */

const clean = (s) => String(s ?? "")
  .replace(/\u00a0/g, " ")
  .replace(/\*+/g, "")          // markdown bold + Docs artefacts like "M****&****A"
  .replace(/\\(.)/g, "$1")      // markdown escapes: \$ \[ \&
  .replace(/\s+/g, " ")
  .trim();
const GLYPH_RE = /^[·•▪◦§o]$/;

function blocksFromHtml(html) {
  const $ = cheerio.load(html);
  // Google Docs marks bold with CSS classes, not <b>.
  const boldClasses = new Set([...$("style").text().matchAll(/\.([\w-]+)\s*\{[^}]*font-weight:\s*(?:700|bold)/g)].map((m) => m[1]));
  const isBold = (el) => {
    const st = $(el).attr("style") || "";
    if (/font-weight:\s*(?:normal|[1-5]00)\b/.test(st)) return false;
    if (/font-weight:\s*(?:bold|[6-9]00)\b/.test(st) || $(el).is("b, strong")) return true;
    return ($(el).attr("class") || "").split(/\s+/).some((c) => boldClasses.has(c));
  };
  const unwrap = (href) => {
    try {
      const u = new URL(href);
      if (/(^|\.)google\.com$/.test(u.hostname) && u.pathname === "/url") return u.searchParams.get("q") || href;
    } catch { /* relative link */ }
    return href;
  };
  const linksIn = (el) => $(el).find("a[href]")
    .map((_, a) => ({ label: clean($(a).text()), url: unwrap($(a).attr("href")) })).get()
    .filter((l) => /^https?:\/\//i.test(l.url));
  // Leading bold run of a paragraph / list item ("Market definition." in "Market definition. No page…").
  const leadOf = (el) => {
    let out = "";
    const leaves = $(el).find("span, b, strong").toArray().filter((s) => !$(s).find("span, b, strong").length);
    for (const s of leaves) {
      const t = $(s).text();
      if (!clean(t) || GLYPH_RE.test(clean(t))) { out += clean(t) ? "" : t; continue; }
      if (!isBold(s) && !$(s).parentsUntil(el).filter("b, strong").length) break;
      out += t;
    }
    return clean(out);
  };

  const blocks = [];
  $("h1, h2, h3, h4, p, table, li").each((_, el) => {
    const tag = String(el.name || el.tagName || "").toLowerCase();
    if ($(el).parents("table").length) return;
    if (tag === "p" && $(el).parents("li").length) return;
    if (/^h\d$/.test(tag)) { const t = clean($(el).text()); if (t) blocks.push({ type: "h", text: t }); return; }
    if (tag === "table") {
      const rows = $(el).find("tr").map((_, tr) => [$(tr).children("td, th")
        .map((_, td) => ({ text: clean($(td).text()), links: linksIn(td) })).get()]).get();
      if (rows.length) blocks.push({ type: "table", rows });
      return;
    }
    const msoList = tag === "p" && /MsoList/i.test($(el).attr("class") || ""); // Word list paragraphs
    let text = clean($(el).text());
    if (msoList) text = text.replace(/^(?:[·•▪◦§o-]|\d+[.)])\s+/, "");
    if (!text) return;
    let lead = leadOf(el);
    if (lead && !text.startsWith(lead)) lead = "";
    blocks.push({ type: tag === "li" || msoList ? "li" : "p", text, lead, links: linksIn(el) });
  });
  return blocks;
}

function blocksFromText(md) {
  const LINK = /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g;
  const linksOf = (s) => [...s.matchAll(LINK)].map((m) => ({ label: clean(m[1]), url: m[2] }));
  const strip = (s) => clean(s.replace(LINK, "$1"));
  const leadOf = (s) => {
    const m = s.replace(/\*{4}/g, "").match(/^\s*(?:[-*•]\s+|\d+\.\s+)?\*\*(.+?)\*\*/);
    return m ? strip(m[1]) : "";
  };
  const blocks = [];
  const lines = String(md).replace(/\r/g, "").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const pipe = /^\s*\|/.test(line);
    if (pipe || line.includes("\t")) {                    // markdown table, or tab-separated rows
      const rows = [];
      for (; i < lines.length && (pipe ? /^\s*\|/.test(lines[i]) : lines[i].includes("\t")); i++) {
        const cells = pipe ? lines[i].trim().replace(/^\||\|$/g, "").split(/(?<!\\)\|/) : lines[i].split("\t");
        if (cells.every((c) => /^\s*:?-{2,}:?\s*$/.test(c))) continue;
        rows.push(cells.map((c) => ({ text: strip(c), links: linksOf(c) })));
      }
      i--;
      if (rows.length) blocks.push({ type: "table", rows });
      continue;
    }
    const h = line.match(/^\s*#{1,6}\s+(.*)$/);
    if (h) { const t = strip(h[1]); if (t) blocks.push({ type: "h", text: t }); continue; }
    const li = line.match(/^\s*(?:[-*•]|\d+\.)\s+(.*)$/);
    if (li) { blocks.push({ type: "li", text: strip(li[1]), lead: leadOf(li[1]), links: linksOf(li[1]) }); continue; }
    if (line.trim()) blocks.push({ type: "p", text: strip(line), lead: leadOf(line), links: linksOf(line) });
  }
  return blocks;
}

/* ---------------- 2. blocks → gap analysis ---------------- */

const KIND = [
  ["driver", /driver/], ["restraint", /restraint|challenge/], ["opportunity", /opportunit/], ["risk", /risk/],
  ["regulation", /regulat|policy/], ["competition", /compet/], ["developments", /development/],
  ["definition", /definition|scope/], ["regional", /region/],
];
const kindOf = (s) => (KIND.find(([, re]) => re.test(String(s).toLowerCase())) || ["other"])[0];

// Which standard H2 a "Recommended page structure" line belongs to — new H2s go after the last one seen.
const ANCHOR = [
  ["overview", /overview|summary/], ["highlights", /highlight|takeaway/], ["dynamics", /dynamic/],
  ["segmentation", /segment/], ["regional", /regional/], ["competitive", /competitive|recent development|player/], ["faq", /faq/],
];
const anchorOf = (s) => (ANCHOR.find(([, re]) => re.test(String(s).toLowerCase())) || [null])[0];
const bare = (s) => String(s).replace(/[.:]\s*$/, "").trim();

export function extractGap(blocks) {
  const g = {
    title: "", readOn: "", headline: "", competitors: [], missing: [], pointers: [], developments: [],
    developmentsNote: "", newSections: [], structure: [], titleTag: "", faqs: [], checks: [], rdEdits: [], verify: [], sources: [],
  };
  let section = "";
  let sub = "";
  let lastStd = "dynamics";
  for (const b of blocks) {
    const text = b.text || "";
    const lead = b.lead || "";
    if (b.type === "h") { if (!g.title) g.title = text.split(/\s[—–]\s/)[0]; section = text.toLowerCase(); sub = ""; continue; }
    if (b.type === "table") { readTable(b.rows, g); continue; }
    if (!g.readOn) { const m = text.match(/\bread on (\d{1,2}\s+[A-Za-z]{3,9}\.?\s+20\d{2})/i); if (m) g.readOn = m[1]; }
    if (b.type === "p" && lead && bare(lead) === bare(text)) { sub = text.toLowerCase(); continue; }       // bold line = sub-heading
    if (b.type === "p" && /^sources/.test(section) && !b.links.length && text.length < 40) { sub = text.toLowerCase(); continue; }

    if (b.type === "p") {
      if (/edits? to the rd sheet/i.test(lead)) g.rdEdits.push(text.slice(lead.length).trim());
      else if (/should (?:confirm|verify)|confirm .{0,80}\bbefore\b/i.test(text)) g.verify.push(text);
      else if (/^for recent developments/i.test(text)) g.developmentsNote = text;
      else if (/executive summary/.test(section) && !g.headline) g.headline = text;
      continue;
    }

    // list items
    if (/missing/.test(section)) {
      g.missing.push(lead ? { topic: bare(lead), detail: text.slice(lead.length).trim() } : { topic: text, detail: "" });
    } else if (/page structure/.test(section)) {
      if (/faq/.test(sub)) { g.faqs.push(text); continue; }
      if (/check/.test(sub)) { g.checks.push(text.replace(/^☐\s*/, "")); continue; }
      const nm = text.match(/^New(?:\s*H2)?\s*:\s*(.+?)\s+[—–-]\s+(.+)$/i);     // "New: Title — what to cover"
      const km = text.match(/^([^:]{2,45}):\s*(.+)$/);                         // "Overview: …", "Title tag: …"
      if (nm) {
        g.newSections.push({ title: bare(nm[1]), desc: nm[2].replace(/\.\s*$/, ""), after: lastStd });
      } else if (km) {
        const id = anchorOf(km[1]);
        if (id) lastStd = id;
        g.structure.push({ key: km[1].trim(), value: km[2].replace(/\s*\((?:table|list) above\)/i, "").trim(), id });
        if (/title tag/i.test(km[1])) g.titleTag = km[2].replace(/\s*\([^)]*\)\s*\.?\s*$/, "").replace(/\.\s*$/, "").trim();
        if (/faq/i.test(km[1])) g.faqs.push(...[...km[2].matchAll(/["“]([^"”]+?\?)["”]/g)].map((m) => m[1].trim()));
      }
    } else if (/^sources/.test(section) && /market facts/.test(sub) && b.links[0]) {
      g.sources.push({ label: text.split(/\s[—–]\s/)[0].trim(), url: b.links[0].url });
    }
  }
  return g;
}

function readTable(rows, g) {
  if (!rows || rows.length < 2) return;
  const head = rows[0].map((c) => c.text.toLowerCase());
  const col = (re) => head.findIndex((h) => re.test(h));
  const at = (r, i) => (i >= 0 && r[i] ? r[i] : { text: "", links: [] });
  const body = rows.slice(1).filter((r) => r.some((c) => c.text));

  if (col(/pointer/) >= 0) {                                    // "Pointers we should cover"
    const [iS, iP, iW, iT, iF] = [col(/^section/), col(/pointer/), col(/why|gap it fills/), col(/search/), col(/facts/)];
    for (const r of body) {
      const pointer = at(r, iP).text;
      if (!pointer) continue;
      const terms = at(r, iT).text;
      const quoted = [...terms.matchAll(/["“]([^"”]+)["”]/g)].map((m) => m[1].trim()).filter(Boolean);
      g.pointers.push({
        kind: kindOf(at(r, iS).text), section: at(r, iS).text || "Pointer", pointer, why: at(r, iW).text,
        searchTerms: quoted.length ? quoted : terms.split(/,\s*/).map((t) => t.trim()).filter(Boolean),
        facts: at(r, iF).text, sources: at(r, iF).links,
      });
    }
  } else if (/^date/.test(head[0] || "")) {                     // "Developments to feature"
    for (const r of body) {
      if (at(r, 1).text) g.developments.push({ date: at(r, 0).text, text: at(r, 1).text, why: at(r, 2).text, sources: r.flatMap((c) => c.links).slice(0, 3) });
    }
  } else if (col(/publisher|competitor/) >= 0 && col(/size/) >= 0) {  // "Competitor benchmark"
    const [iN, iSc, iSz, iU, iWk] = [col(/publisher|competitor/), col(/^scope/), col(/size/), col(/updated/), col(/weakness/)];
    for (const r of body) {
      const name = at(r, iN).text.replace(/\s*\(.*\)\s*$/, "").trim();
      if (!name) continue;
      g.competitors.push({
        publisher: name, url: (at(r, iN).links[0] || {}).url || "", scope: at(r, iSc).text,
        size: at(r, iSz).text, updated: at(r, iU).text, weaknesses: at(r, iWk).text,
      });
    }
  }
}

/* ---------------- 3. gap analysis → skeleton layer ---------------- */

const STOP = new Set(("a an and are as at be been by can do does for from has have how in into is it its new no not of on or our " +
  "than that the their these this those to vs was were what when which who why will with would key global market markets").split(" "));
function stems(s) {
  const out = new Set();
  for (const w of String(s || "").replace(/[^A-Za-z0-9&\s-]/g, " ").split(/[\s-]+/)) {
    const lw = w.toLowerCase();
    if (!lw || STOP.has(lw)) continue;
    if (lw.length > 2 || /^[A-Z]{2}$/.test(w)) out.add((lw.length > 3 ? lw.replace(/s$/, "") : lw).slice(0, 5));
  }
  return out;
}

const PLACES = [
  ["U.S.", "US|U\\.S\\.|USA|United States"], ["EU", "EU|European Union"], ["UK", "UK|U\\.K\\.|United Kingdom"],
  ["China", "China"], ["India", "India"], ["Japan", "Japan"], ["Brazil", "Brazil"], ["Canada", "Canada"],
  ["Australia", "Australia"], ["Russia", "Russia"], ["South Korea", "South Korea|Korea"], ["Germany", "Germany"],
  ["France", "France"], ["Gulf states", "Gulf states|GCC|Saudi Arabia|UAE"],
];
const placeRe = (alt, tail = "") => new RegExp(`(?<![A-Za-z])(?:${alt})(?![A-Za-z])${tail}`);
function findPlaces(text) {
  const s = String(text || "");
  return PLACES.map(([name, alt]) => ({ name, alt, at: s.search(placeRe(alt)) })).filter((p) => p.at >= 0).sort((a, b) => a.at - b.at);
}
// "US: tariffs + IRA. EU: data protection… India: …" → one part per label
const labelled = (t) => String(t || "").split(/(?<=[.)])\s+(?=[A-Z][A-Za-z.&\s]{0,25}:)/);

const REG_RE = /regulat|polic|subsid/i;
const DEAL_TITLE_RE = /m&a|merger|acqui|funding|\bdeals?\b/i;
const DEAL_RE = /acqui|m&a|merger|\bdeals?\b|funding|partnership|collaborat|licens/i;
const CAPEX_RE = /capacity|onshor|expansion|investment/i;
const MON = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

function parseDevDate(s) {
  const t = String(s || "").toLowerCase();
  let m = t.match(/(?:end|late)[-\s]*(20\d{2})/);
  if (m) return new Date(+m[1], 11, 31);
  m = t.match(/(?:(\d{1,2})\s+)?([a-z]{3})[a-z]*\.?\s+(20\d{2})/);
  if (m && MON.includes(m[2])) return new Date(+m[3], MON.indexOf(m[2]), +(m[1] || 1));
  m = t.match(/(20\d{2})/);
  return m ? new Date(+m[1], 0, 1) : null;
}

// "Specialists: MDClone, Syntho. Big tech: NVIDIA, Microsoft. Data/CRO: IQVIA, Aetion" → role groups
function playerGroups(ptrs) {
  for (const p of ptrs) {
    const groups = String(p.facts || "").split(/\.\s+(?=[A-Z][\w/&\- ]{1,30}:)/)
      .map((part) => part.match(/^\s*([^:]{2,30}):\s*(.+)$/)).filter(Boolean)
      .map((m) => ({ role: m[1].trim(), names: m[2].replace(/\.\s*$/, "").split(/,\s*/).map((n) => n.trim()).filter((n) => n && n.length < 50) }))
      .filter((x) => x.names.length);
    if (groups.length >= 2) return { groups, from: p.id };
  }
  return null;
}

export function buildGapLayer(raw, { keyword = "", now = new Date(), source = null } = {}) {
  const kwStems = stems(keyword);
  const P = raw.pointers.map((p, i) => ({ ...p, id: `p${i + 1}`, target: null, alsoIn: null, h3: "" }));
  const stOf = new Map(P.map((p) => {
    const s = stems(`${p.pointer} ${(p.searchTerms || []).join(" ")}`);
    kwStems.forEach((k) => s.delete(k));
    return [p.id, s];
  }));
  const df = new Map();
  stOf.forEach((s) => s.forEach((w) => df.set(w, (df.get(w) || 0) + 1)));
  // A pointer belongs to a section when it shares 2+ distinctive words with the section's title + description.
  const match = (p, text) => {
    const t = stems(text);
    let sc = 0, n = 0;
    stOf.get(p.id).forEach((w) => { if (t.has(w)) { sc += 1 / df.get(w); n++; } });
    return n >= 2 && sc >= 1 ? sc : 0;
  };
  const of = (k) => P.filter((p) => p.kind === k);

  // New H2s. A regulation-type "New:" becomes the Regulatory slot; an M&A-type one is the fixed M&A H3.
  const newAll = raw.newSections.map((s, i) => ({ ...s, order: i }));
  const regSrc = newAll.find((s) => REG_RE.test(s.title));
  const newSections = newAll.filter((s) => s !== regSrc && !DEAL_TITLE_RE.test(s.title)).map((s, j) => ({
    id: `gap-new-${j + 1}`, title: s.title, desc: s.desc, after: s.after, order: s.order, pointerIds: [], h3s: [],
  }));

  for (const p of P) {
    if (!["driver", "restraint", "opportunity", "risk", "other"].includes(p.kind)) continue;
    let best = null, bestSc = 0;
    newSections.forEach((s) => { const sc = match(p, `${s.title} ${s.desc}`); if (sc > bestSc) { best = s; bestSc = sc; } });
    if (best) { best.pointerIds.push(p.id); p.alsoIn = best.id; }
  }
  const HOME = { definition: "overview", regulation: "regulatory", competition: "competitive", developments: "competitive", regional: "regional", other: "trends" };
  for (const p of P) {
    p.target = HOME[p.kind] || "dynamics";
    // Risks and "other" pointers move to the new H2 they match; drivers, restraints and opportunities keep a
    // short H3 in Market Dynamics too.
    if ((p.kind === "risk" || p.kind === "other") && p.alsoIn) { p.target = p.alsoIn; p.alsoIn = null; }
  }

  // Regulatory slot — one H3 per country / bloc the doc names.
  const regPtrs = P.filter((p) => p.kind === "regulation" ||
    (regSrc && !["competition", "developments"].includes(p.kind) && match(p, `${regSrc.title} ${regSrc.desc}`)));
  const regText = [regSrc ? regSrc.desc : "", ...of("regulation").map((p) => p.pointer)].join(" ");
  const lawsText = regSrc ? regSrc.desc : regText;
  const regFacts = of("regulation").map((p) => p.facts).join(" ");
  const jurisdictions = findPlaces(regText).slice(0, 5).map((j, i) => ({
    id: `gap-jur-${i + 1}`,
    name: j.name,
    laws: (lawsText.match(placeRe(j.alt, "\\s*\\(([^)]*)\\)")) || [])[1] || "",
    facts: labelled(regFacts).filter((part) => placeRe(j.alt).test(part.split(":")[0])).join(" "),
    h3: "",
  }));
  const regulatory = {
    title: regSrc ? regSrc.title : "Regulatory Landscape",
    desc: regSrc ? regSrc.desc : "",
    after: regSrc ? regSrc.after : "regional",
    order: regSrc ? regSrc.order : 99,
    required: !!(regSrc || of("regulation").length),
    jurisdictions,
    pointerIds: regPtrs.map((p) => p.id),
  };

  // Competitive Landscape: deals → M&A H3, capacity → its own H3, the rest → key players.
  const comp = of("competition");
  const deals = comp.filter((p) => DEAL_RE.test(`${p.pointer} ${p.facts}`));
  const capex = comp.filter((p) => !deals.includes(p) && CAPEX_RE.test(`${p.pointer} ${p.facts}`));
  const playerPtrs = comp.filter((p) => !deals.includes(p) && !capex.includes(p));

  // Latest developments: from July of last year, newest first, max 5.
  const cutoff = new Date(now.getFullYear() - 1, 6, 1);
  const developments = raw.developments.map((d) => ({ ...d, t: parseDevDate(d.date) }))
    .filter((d) => !d.t || d.t >= cutoff)
    .sort((a, b) => (b.t ? b.t.getTime() : 0) - (a.t ? a.t.getTime() : 0))
    .slice(0, 5)
    .map(({ t, ...d }) => d);

  const countries = [...new Set([
    ...findPlaces(of("regional").map((p) => p.pointer).join(" ")).map((j) => j.name),
    ...jurisdictions.map((j) => j.name),
  ])];

  const figureCheck = raw.competitors.length
    ? checkFigureRows(raw.competitors.map((x) => ({ name: x.publisher, link: x.url, text: x.size, scope: x.scope, weaknesses: x.weaknesses })), { byScope: true })
    : null;

  return {
    version: 1,
    source: { ...(source || {}), readOn: raw.readOn || "", attachedAt: now.toISOString() },
    title: raw.title,
    headline: raw.headline,
    missing: raw.missing,
    pointers: P,
    newSections,
    regulatory,
    players: playerGroups(playerPtrs),
    deals: deals.map((p) => p.id),
    capex: capex.map((p) => p.id),
    playerPtrs: playerPtrs.map((p) => p.id),
    developments,
    developmentsNote: raw.developmentsNote,
    countries,
    structure: raw.structure,
    titleTag: raw.titleTag,
    faqs: [...new Set(raw.faqs)].slice(0, 12),
    checks: raw.checks,
    rdEdits: raw.rdEdits,
    verify: raw.verify,
    sources: raw.sources,
    competitors: raw.competitors,
    figureCheck,
    h3Model: null,
    h3Note: "",
  };
}

// Puts the AI-worded H3s (lib/brief-ai.js phraseGapH3s) onto the gap layer. Without them the skeleton
// shows template H3s marked "reword".
export function applyGapPhrasing(gap, ph) {
  if (!ph || ph.skipped || ph.error) {
    gap.h3Note = ph && ph.error
      ? `H3 wording failed (${ph.error}) — the H3s marked “reword” are templates.`
      : ph && /OPENAI_API_KEY/.test(ph.reason || "") ? "OPENAI_API_KEY isn't set — the H3s marked “reword” are templates." : "";
    return gap;
  }
  const items = ph.items || {};
  const secs = ph.sections || {};
  gap.pointers.forEach((p) => { if (items[p.id]) p.h3 = items[p.id]; });
  gap.regulatory.jurisdictions.forEach((j) => { if (items[j.id]) j.h3 = items[j.id]; });
  gap.newSections.forEach((s) => { if (Array.isArray(secs[s.id])) s.h3s = secs[s.id]; });
  gap.h3Model = ph.model || null;
  gap.h3Note = "";
  return gap;
}
