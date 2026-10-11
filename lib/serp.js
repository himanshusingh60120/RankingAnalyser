// lib/serp.js
// Live Google results for a keyword, normalised across SERP providers.
//
// Provider order (first one configured wins):
//   1. Serper.dev  -> SERPER_API_KEY  (recommended: fast, cheap, returns People Also Ask + related searches)
//   2. SerpApi     -> SERPAPI_KEY     (pricier; also returns AI Overview text + cited sources)
//   3. Google CSE  -> GOOGLE_CSE_KEY + GOOGLE_CSE_CX  (LEGACY fallback only: switched off by Google on 1 Jan 2027)
//
// prefer: "serpapi" uses SerpApi for that one search when SERPAPI_KEY is set (the brief does this for the
// main keyword search to capture AI Overview sources), and falls back to the default provider on error.
// page: 1 = ranks 1–10, 2 = ranks 11–20. Positions are always absolute ranks.
// Bing Web Search is intentionally NOT supported: Microsoft retired it on 11 Aug 2025.

const TIMEOUT_MS = 15000;

export function serpProviderName() {
  if (process.env.SERPER_API_KEY) return "serper";
  if (process.env.SERPAPI_KEY) return "serpapi";
  if (process.env.GOOGLE_CSE_KEY && process.env.GOOGLE_CSE_CX) return "google-cse";
  return null;
}

export async function searchGoogle(query, { gl = "us", hl = "en", num = 10, page = 1, prefer = null } = {}) {
  const fallback = serpProviderName();
  if (!fallback) {
    const e = new Error(
      "No SERP provider configured. Add SERPER_API_KEY (recommended) or SERPAPI_KEY in Vercel → Settings → Environment Variables, then redeploy."
    );
    e.code = "NO_SERP_PROVIDER";
    throw e;
  }
  const opts = {
    gl: String(gl || "us").toLowerCase(),
    hl: String(hl || "en").toLowerCase(),
    num: Math.min(Math.max(Number(num) || 10, 1), 10),
    page: Math.min(Math.max(Math.floor(Number(page) || 1), 1), 10),
  };
  let provider = prefer === "serpapi" && process.env.SERPAPI_KEY ? "serpapi" : fallback;
  let out;
  try {
    out = await run(provider, query, opts);
  } catch (e) {
    if (provider === fallback) throw e;
    provider = fallback;
    out = await run(provider, query, opts);
  }
  return { provider, query, gl: opts.gl, hl: opts.hl, page: opts.page, fetchedAt: new Date().toISOString(), ...out };
}

function run(provider, query, opts) {
  if (provider === "serper") return viaSerper(query, opts);
  if (provider === "serpapi") return viaSerpApi(query, opts);
  return viaCse(query, opts);
}

async function viaSerper(q, { gl, hl, num, page }) {
  const body = page > 1 ? { q, gl, hl, num, page } : { q, gl, hl, num };
  const data = await fetchJson("https://google.serper.dev/search", {
    method: "POST",
    headers: { "X-API-KEY": process.env.SERPER_API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const offset = (page - 1) * num;
  return {
    organic: (data.organic || []).map((r, i) => organicRow(offset + i + 1, r.title, r.link, r.snippet, r.date)),
    peopleAlsoAsk: (data.peopleAlsoAsk || [])
      .map((p) => ({ question: p.question || p.title || "", snippet: p.snippet || "", link: p.link || "" }))
      .filter((p) => p.question),
    relatedSearches: (data.relatedSearches || []).map((r) => r.query).filter(Boolean),
    aiOverview: null, // not parsed for Serper — set SERPAPI_KEY to capture AI Overview sources
    answerBox: data.answerBox
      ? { title: data.answerBox.title || "", text: data.answerBox.answer || data.answerBox.snippet || "", link: data.answerBox.link || "" }
      : null,
  };
}

async function viaSerpApi(q, { gl, hl, num, page }) {
  const key = process.env.SERPAPI_KEY;
  const u = new URL("https://serpapi.com/search.json");
  const params = { engine: "google", q, gl, hl, num: String(num), api_key: key };
  if (page > 1) params.start = String((page - 1) * num);
  u.search = new URLSearchParams(params).toString();
  const data = await fetchJson(u.toString());
  if (data.error) throw new Error(`SerpApi: ${data.error}`);

  let ao = data.ai_overview || null;
  // Sometimes Google loads the AI Overview separately; SerpApi then returns a page_token to fetch it.
  if (ao && !ao.text_blocks && ao.page_token) {
    try {
      const u2 = new URL("https://serpapi.com/search.json");
      u2.search = new URLSearchParams({ engine: "google_ai_overview", page_token: ao.page_token, api_key: key }).toString();
      const d2 = await fetchJson(u2.toString());
      if (d2 && d2.ai_overview) ao = d2.ai_overview;
    } catch { /* keep what we have */ }
  }
  let aiOverview = null;
  if (ao) {
    const text = (ao.text_blocks || [])
      .map((b) => b.snippet || (b.list || []).map((l) => l.snippet || l.title).filter(Boolean).join("; "))
      .filter(Boolean)
      .join(" ")
      .slice(0, 1500);
    const sources = (ao.references || [])
      .map((r) => ({ title: r.title || "", link: r.link || "", domain: domainOf(r.link) }))
      .filter((s) => s.link);
    aiOverview = { present: true, text, sources };
  }
  const offset = (page - 1) * num;
  return {
    organic: (data.organic_results || []).map((r, i) => organicRow(offset + i + 1, r.title, r.link, r.snippet, r.date)),
    peopleAlsoAsk: (data.related_questions || [])
      .map((p) => ({ question: p.question || "", snippet: p.snippet || "", link: p.link || "" }))
      .filter((p) => p.question),
    relatedSearches: (data.related_searches || []).map((r) => r.query).filter(Boolean),
    aiOverview,
    answerBox: data.answer_box
      ? { title: data.answer_box.title || "", text: data.answer_box.answer || data.answer_box.snippet || "", link: data.answer_box.link || "" }
      : null,
  };
}

async function viaCse(q, { gl, hl, num, page }) {
  const u = new URL("https://www.googleapis.com/customsearch/v1");
  const params = { key: process.env.GOOGLE_CSE_KEY, cx: process.env.GOOGLE_CSE_CX, q, gl, hl, num: String(num) };
  if (page > 1) params.start = String((page - 1) * num + 1);
  u.search = new URLSearchParams(params).toString();
  const data = await fetchJson(u.toString());
  const offset = (page - 1) * num;
  return {
    organic: (data.items || []).map((r, i) => organicRow(offset + i + 1, r.title, r.link, r.snippet, null)),
    peopleAlsoAsk: [],
    relatedSearches: [],
    aiOverview: null,
    answerBox: null,
    warning: "Using the legacy Google CSE fallback: no People Also Ask data, and Google switches this API off on 1 Jan 2027. Add SERPER_API_KEY.",
  };
}

async function fetchJson(url, init = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal });
    const text = await res.text();
    if (!res.ok) throw new Error(`SERP provider HTTP ${res.status}: ${text.slice(0, 240)}`);
    try { return JSON.parse(text); }
    catch { throw new Error("SERP provider returned non-JSON output."); }
  } catch (e) {
    if (e.name === "AbortError") throw new Error("SERP provider timed out.");
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

function organicRow(position, title, link, snippet, date) {
  return {
    position: Number(position) || 0,
    title: title || "",
    link: link || "",
    domain: domainOf(link),
    snippet: snippet || "",
    date: date || null,
  };
}

export function domainOf(u) {
  try { return new URL(u).hostname.replace(/^www\./, "").toLowerCase(); }
  catch { return ""; }
}
