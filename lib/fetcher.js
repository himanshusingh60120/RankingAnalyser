// lib/fetcher.js
// Server-side page fetcher.
//  1. Normal request with realistic browser headers.
//  2. If the site blocks us (HTTP 403 / 429 / 503, or a "Just a moment…" / captcha page), fall back:
//     a. SCRAPER_API_URL (if set) — a paid scraping service, the most reliable automatic route
//     b. otherwise race two FREE routes and use whichever answers first:
//        - Jina Reader (r.jina.ai) — reads the page from Jina's servers, no key needed
//        - archive.org — the most recent saved copy (up to ~3 years old; the brief shows its date)
//  If every route fails, analysts can paste the page into the brief page themselves.
//  The result says how the page was read (via: "scraper" | "reader" | "archive").
//  Set READER_FALLBACK=off to disable the free routes.

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
 * @returns {Promise<{status:number, html:string, finalUrl:string, blocked:boolean, via?:string, archivedAt?:string, error?:string}>}
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
    const r = await viaScraper(scraper, url, 14000);
    if (r) return r;
  }
  if (String(process.env.READER_FALLBACK || "").toLowerCase() === "off") return null;
  const routes = [viaReader(url, 14000), viaArchive(url, 15000)]
    .map((p) => p.then((r) => (r ? r : Promise.reject(new Error("no result")))));
  try { return await Promise.any(routes); }
  catch { return null; }
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

// Latest archive.org copy. The CDX index is more reliable than the "available" endpoint, so try it first.
async function viaArchive(url, timeoutMs) {
  const t0 = Date.now();
  let ts = null;
  const cdx = await timedFetch(
    `https://web.archive.org/cdx/search/cdx?url=${encodeURIComponent(url)}&output=json&fl=timestamp&filter=statuscode:200&limit=-1`,
    {}, 8000);
  if (cdx && cdx.ok) {
    const rows = await cdx.json().catch(() => null);
    if (Array.isArray(rows) && rows.length > 1 && rows[rows.length - 1][0]) ts = String(rows[rows.length - 1][0]);
  }
  if (!ts) {
    const avail = await timedFetch(`https://archive.org/wayback/available?url=${encodeURIComponent(url)}`, {}, 5000);
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
  const raw = `https://web.archive.org/web/${ts}id_/${url}`; // id_ = the original page without the archive toolbar
  const res = await timedFetch(raw, { headers: BROWSER_HEADERS }, Math.max(3000, timeoutMs - (Date.now() - t0)));
  if (!res || res.status !== 200) return null;
  const html = await res.text().catch(() => "");
  if (!usable(html)) return null;
  return { status: 200, html, finalUrl: url, blocked: false, via: "archive", archivedAt };
}

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
