// lib/fetcher.js
// Server-side fetch with realistic browser headers. Running on Vercel's
// Node runtime, requests originate from a datacenter IP with full headers,
// which clears the simple UA-based 403 blocks these market-research sites use.

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

/**
 * Fetch a URL with retries on transient/block status codes.
 * @returns {Promise<{status:number, html:string, finalUrl:string, blocked:boolean, error?:string}>}
 */
export async function fetchPage(url, { timeoutMs = 20000, retries = 2 } = {}) {
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
      if ([403, 429, 503].includes(status) && attempt < retries) {
        await sleep(1200 * (attempt + 1));
        last = { status, html: "", finalUrl, blocked: true };
        continue;
      }
      const html = await res.text();
      return { status, html, finalUrl, blocked: [403, 429, 503].includes(status) };
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

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
