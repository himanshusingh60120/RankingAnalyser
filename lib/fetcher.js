// lib/fetcher.js
// Server-side page fetcher.
//  1. Normal request with realistic browser headers.
//  2. If the site blocks us (HTTP 403 / 429 / 503, or a "Just a moment…" / captcha page), fall back in order:
//     a. SCRAPER_API_URL (if set) — a paid scraping service
//     b. FREE routes, raced — Jina Reader (r.jina.ai) and the latest archive.org copy (up to ~3 years old)
//     c. ChatGPT web search (needs OPENAI_API_KEY) — GPT opens the page through OpenAI's web search and
//        returns its headings, figures, segments, companies and FAQs, which we rebuild into a page.
//        This is AI-extracted: the result is marked via:"ai-reader" and word / table counts are approximate.
//  Switches: READER_FALLBACK=off (free routes) · AI_READER=off (ChatGPT route) · OPENAI_READER_MODEL (model).

const BROWSER_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  Accept:
    "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif," +
    "image/webp,image/apng,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  "Sec-Fetch-Dest": "document",
  "Sec-Fetch-Mode": "navigate",
  "Sec-Fetch-Site": "none",
  "Sec-Fetch-User": "?1",
  "Upgrade-Insecure-Requests": "1",
  "Cache-Control": "max-age=0",
};

const BLOCK_STATUSES = [403, 429, 503];
const CHALLENGE_RE =
  /<title>[^<]{0,40}(just a moment|attention required|access denied|please wait|security check|are you a robot|verify you are human)|cf-browser-verification|cf_chl_|\/cdn-cgi\/challenge-platform|captcha-delivery\.com|px-captcha|_incapsula_resource|distil_r_captcha/i;
const MAX_ARCHIVE_AGE_DAYS = 1095;

/**
 * Fetch a URL. Falls back to other routes when the site blocks us.
 * @returns {Promise<{status:number, html:string, finalUrl:string, blocked:boolean, via?:string, archivedAt?:string, aiMeta?:object, error?:string}>}
 */
export async function fetchPage(url, { timeoutMs = 20000, retries = 2, fallback = true } = {}) {
  let last = { status: 0, html: "", finalUrl: url, blocked: false };
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, { headers: BROWSER_HEADERS, redirect: "follow", signal: ctrl.signal });
      const status = res.status;
      const finalUrl = res.url || url;
      if (BLOCK_STATUSES.includes(status)) {
        clearTimeout(timer);
        try { await res.body?.cancel(); } catch { /* ignore */ }
        last = { status, html: "", finalUrl, blocked: true };
        break;
      }
      const html = await res.text();
      clearTimeout(timer);
      if (status === 200 && looksLikeChallenge(html)) {
        last = { status: 403, html: "", finalUrl, blocked: true };
        break;
      }
      return { status, html, finalUrl, blocked: false };
    } catch (err) {
      clearTimeout(timer);
      last = { status: 0, html: "", finalUrl: url, blocked: false, error: String(err && err.message ? err.message : err) };
      if (attempt < retries) await sleep(800);
    }
  }
  if (last.blocked && fallback) {
    const alt = await fetchFallback(url);
    if (alt) return alt;
  }
  return last;
}

async function fetchFallback(url) {
  const scraper = process.env.SCRAPER_API_URL || "";
  if (scraper) {
    const r = await viaScraper(scraper, url, 12000);
    if (r) return r;
  }
  if (String(process.env.READER_FALLBACK || "").toLowerCase() !== "off") {
    const routes = [viaReader(url, 11000), viaArchive(url, 11000)]
      .map((p) => p.then((r) => (r ? r : Promise.reject(new Error("no result")))));
    try { return await Promise.any(routes); }
    catch { /* both free routes failed */ }
  }
  if (process.env.OPENAI_API_KEY && String(process.env.AI_READER || "").toLowerCase() !== "off") {
    const r = await viaOpenAI(url, 16000);
    if (r) return r;
  }
  return null;
}

async function viaScraper(template, url, timeoutMs) {
  const target = template.includes("{url}")
    ? template.replace("{url}", encodeURIComponent(url))
    : template + encodeURIComponent(url);
  const res = await timedFetch(target, {}, timeoutMs);
  if (!res || res.status !== 200) return null;
  const html = await res.text().catch(() => "");
  if (!usable(html)) return null;
  return { status: 200, html, finalUrl: url, blocked: false, via: "scraper" };
}

async function viaReader(url, timeoutMs) {
  const headers = { "X-Return-Format": "html", Accept: "text/html" };
  if (process.env.JINA_API_KEY) headers.Authorization = `Bearer ${process.env.JINA_API_KEY}`;
  const res = await timedFetch("https://r.jina.ai/" + url, { headers }, timeoutMs);
  if (!res || res.status !== 200) return null;
  const html = await res.text().catch(() => "");
  if (!usable(html)) return null;
  return { status: 200, html, finalUrl: url, blocked: false, via: "reader" };
}

async function viaArchive(url, timeoutMs) {
  const t0 = Date.now();
  let ts = null;
  const cdx = await timedFetch(
    `https://web.archive.org/cdx/search/cdx?url=${encodeURIComponent(url)}&output=json&fl=timestamp&filter=statuscode:200&limit=-1`,
    {}, 7000);
  if (cdx && cdx.ok) {
    const rows = await cdx.json().catch(() => null);
    if (Array.isArray(rows) && rows.length > 1 && rows[rows.length - 1][0]) ts = String(rows[rows.length - 1][0]);
  }
  if (!ts) {
    const avail = await timedFetch(`https://archive.org/wayback/available?url=${encodeURIComponent(url)}`, {}, 4000);
    if (avail && avail.ok) {
      const d = await avail.json().catch(() => null);
      const snap = d && d.archived_snapshots && d.archived_snapshots.closest;
      if (snap && snap.available && String(snap.status) === "200" && snap.timestamp) ts = String(snap.timestamp);
    }
  }
  if (!ts) return null;
  const archivedAt = `${ts.slice(0, 4)}-${ts.slice(4, 6)}-${ts.slice(6, 8)}`;
  const ageDays = (Date.now() - new Date(archivedAt).getTime()) / 864e5;
  if (!Number.isFinite(ageDays) || ageDays > MAX_ARCHIVE_AGE_DAYS) return null;
  const raw = `https://web.archive.org/web/${ts}id_/${url}`;
  const res = await timedFetch(raw, { headers: BROWSER_HEADERS }, Math.max(3000, timeoutMs - (Date.now() - t0)));
  if (!res || res.status !== 200) return null;
  const html = await res.text().catch(() => "");
  if (!usable(html)) return null;
  return { status: 200, html, finalUrl: url, blocked: false, via: "archive", archivedAt };
}

/* ---------- ChatGPT web search route ---------- */

async function viaOpenAI(url, timeoutMs) {
  const key = process.env.OPENAI_API_KEY;
  const model = process.env.OPENAI_READER_MODEL || process.env.OPENAI_BRIEF_MODEL || process.env.OPENAI_MODEL || "gpt-4o-mini";
  const shape = {
    found: true,
    title: "<the page title>",
    metaDescription: "<meta description or empty>",
    h1: "<main heading>",
    lastUpdated: "<YYYY-MM-DD or null>",
    summary: "<2-3 sentences on what the page covers>",
    sections: [{ level: 2, heading: "<exact heading text>", summary: "<1-2 sentences of what the section says>" }],
    marketSize: { baseYear: "<year or null>", baseValue: "<value exactly as written or null>", forecastYear: "<year or null>", forecastValue: "<value exactly as written or null>", cagr: "<number or null>", period: "<e.g. 20XX-20XX or null>" },
    segments: ["<By <split>: sub-segment, sub-segment>"],
    regions: ["<region names covered>"],
    companies: ["<company names listed>"],
    faqs: [{ q: "<question>", a: "<short answer>" }],
    approxWordCount: "<number>",
    tableCount: "<number>",
  };
  const input = [
    `Use web search to open and read this exact web page: ${url}`,
    "Read only that page — not other pages on the site and not search snippets about other pages.",
    "Return ONLY a JSON object, no other text, in this shape:",
    JSON.stringify(shape),
    "List headings in page order (H2 = level 2, H3 = level 3), at most 40.",
    "Copy numbers exactly as written on the page. Use null for anything the page doesn't state — never guess.",
    'If you cannot open that exact page, return {"found": false}.',
  ].join("\n");

  const t0 = Date.now();
  const left = () => Math.max(3000, timeoutMs - (Date.now() - t0));
  const call = (toolType) => timedFetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model, tools: [{ type: toolType }], input }),
  }, left());

  let res = await call("web_search");
  if (res && res.status === 400) {
    const t = await res.text().catch(() => "");
    if (!/web_search/i.test(t)) return null;
    res = await call("web_search_preview"); // older tool name on some accounts / models
  }
  if (!res || !res.ok) return null;
  const d = await res.json().catch(() => null);
  const data = parseJsonLoose(outputText(d));
  if (!data || data.found === false || !Array.isArray(data.sections) || data.sections.filter((s) => s && s.heading).length < 3) return null;
  return {
    status: 200,
    html: rebuildPage(data),
    finalUrl: url,
    blocked: false,
    via: "ai-reader",
    aiMeta: { words: toNum(data.approxWordCount), tables: toNum(data.tableCount) },
  };
}

function outputText(d) {
  if (!d) return "";
  if (typeof d.output_text === "string") return d.output_text;
  const out = [];
  for (const item of d.output || []) {
    if (item && item.type === "message") {
      for (const c of item.content || []) if (c && (c.type === "output_text" || c.type === "text") && c.text) out.push(c.text);
    }
  }
  return out.join("\n");
}

function parseJsonLoose(text) {
  const s = String(text || "").replace(/```json|```/gi, "");
  const a = s.indexOf("{");
  const b = s.lastIndexOf("}");
  if (a < 0 || b <= a) return null;
  try { return JSON.parse(s.slice(a, b + 1)); }
  catch { return null; }
}

const toNum = (v) => { const n = Number(String(v ?? "").replace(/[^\d.]/g, "")); return Number.isFinite(n) && n > 0 ? Math.round(n) : null; };

// Turn GPT's structured read-out back into simple HTML the rest of the tool understands.
function rebuildPage(d) {
  const e = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const clean = (v) => (v == null || /^null$/i.test(String(v)) || /^<.*>$/.test(String(v)) ? "" : String(v).trim());
  const ms = d.marketSize || {};
  const html = [];
  html.push(`<!doctype html><html><head><title>${e(clean(d.title) || clean(d.h1))}</title><meta name="description" content="${e(clean(d.metaDescription))}"></head><body><main><article>`);
  html.push(`<h1>${e(clean(d.h1) || clean(d.title))}</h1>`);
  if (clean(d.lastUpdated)) html.push(`<p>Last updated: ${e(clean(d.lastUpdated))}</p>`);
  if (clean(d.summary)) html.push(`<p>${e(clean(d.summary))}</p>`);
  const fig = [];
  if (clean(ms.baseValue)) fig.push(`The market was valued at ${clean(ms.baseValue)}${clean(ms.baseYear) ? ` in ${clean(ms.baseYear)}` : ""}`);
  if (clean(ms.forecastValue)) fig.push(`and is projected to reach ${clean(ms.forecastValue)}${clean(ms.forecastYear) ? ` by ${clean(ms.forecastYear)}` : ""}`);
  if (clean(ms.cagr)) fig.push(`at a CAGR of ${clean(ms.cagr).replace(/%/g, "")}%${clean(ms.period) ? ` from ${clean(ms.period)}` : ""}`);
  if (fig.length) html.push(`<p>${e(fig.join(", "))}.</p>`);
  for (const s of (d.sections || []).slice(0, 40)) {
    if (!s || !clean(s.heading)) continue;
    const lvl = Number(s.level) === 3 ? 3 : 2;
    html.push(`<h${lvl}>${e(clean(s.heading))}</h${lvl}>`);
    if (clean(s.summary)) html.push(`<p>${e(clean(s.summary))}</p>`);
  }
  const segs = (d.segments || []).map(clean).filter(Boolean);
  if (segs.length) html.push(`<h2>Segmentation</h2><ul>${segs.map((x) => `<li>${e(x)}</li>`).join("")}</ul>`);
  const regs = (d.regions || []).map(clean).filter(Boolean);
  if (regs.length) html.push(`<h2>Regional Coverage</h2><ul>${regs.map((x) => `<li>${e(x)}</li>`).join("")}</ul>`);
  const cos = (d.companies || []).map(clean).filter(Boolean);
  if (cos.length) html.push(`<h2>Key Players</h2><ul>${cos.map((x) => `<li>${e(x)}</li>`).join("")}</ul>`);
  const faqs = (d.faqs || []).filter((f) => f && clean(f.q));
  if (faqs.length) {
    html.push(`<h2>Frequently Asked Questions</h2>`);
    faqs.forEach((f) => html.push(`<h3>${e(clean(f.q))}</h3><p>${e(clean(f.a))}</p>`));
  }
  html.push(`</article></main></body></html>`);
  return html.join("\n");
}

/* ---------- helpers ---------- */

function looksLikeChallenge(html) {
  const s = String(html || "");
  return s.length < 60000 && CHALLENGE_RE.test(s.slice(0, 25000));
}

function usable(html) {
  const s = String(html || "");
  return s.length > 3000 && !looksLikeChallenge(s) && /<(h1|h2|p)\b/i.test(s);
}

async function timedFetch(url, init, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, redirect: "follow", signal: ctrl.signal });
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
