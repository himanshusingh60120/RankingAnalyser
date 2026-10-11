// lib/fetcher.js
// Server-side fetch with realistic browser headers. Running on Vercel's Node runtime, requests
// originate from a datacenter IP with full headers, which clears the simple UA-based 403 blocks
// these market-research sites use.
//
// NEW: if a site still blocks us (HTTP 403 / 429 / 503) and SCRAPER_API_URL is set, the page is
// fetched once through a scraping / rendering service instead. SCRAPER_API_URL is a URL template —
// {url} is replaced by the encoded page URL. Examples:
//   https://api.scraperapi.com/?api_key=YOUR_KEY&url={url}
//   https://app.scrapingbee.com/api/v1/?api_key=YOUR_KEY&url={url}

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

/**
 * Fetch a URL with retries on transient/block status codes.
 * @returns {Promise<{status:number, html:string, finalUrl:string, blocked:boolean, via?:string, error?:string}>}
 */
export async function fetchPage(url, { timeoutMs = 20000, retries = 2 } = {}) {
  const scraper = process.env.SCRAPER_API_URL || "";
  let last = { status: 0, html: "", finalUrl: url, blocked: false };
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        headers: BROWSER_HEADERS,
        redirect: "follow",
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      const status = res.status;
      const finalUrl = res.url || url;
      if (BLOCK_STATUSES.includes(status)) {
        try { await res.body?.cancel(); } catch { /* ignore */ }
        if (scraper) {
          const viaScraper = await fetchViaScraper(scraper, url, Math.max(timeoutMs, 18000));
          if (viaScraper) return viaScraper;
          return { status, html: "", finalUrl, blocked: true };
        }
        if (attempt < retries) {
          await sleep(1200 * (attempt + 1));
          last = { status, html: "", finalUrl, blocked: true };
          continue;
        }
        return { status, html: "", finalUrl, blocked: true };
      }
      const html = await res.text();
      return { status, html, finalUrl, blocked: false };
    } catch (err) {
      clearTimeout(timer);
      last = {
        status: 0,
        html: "",
        finalUrl: url,
        blocked: false,
        error: String(err && err.message ? err.message : err),
      };
      await sleep(800);
    }
  }
  return last;
}

async function fetchViaScraper(template, url, timeoutMs) {
  const target = template.includes("{url}")
    ? template.replace("{url}", encodeURIComponent(url))
    : template + encodeURIComponent(url);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(target, { signal: ctrl.signal });
    if (res.status !== 200) return null;
    const html = await res.text();
    if (!html || html.length < 500) return null;
    return { status: 200, html, finalUrl: url, blocked: false, via: "scraper" };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
