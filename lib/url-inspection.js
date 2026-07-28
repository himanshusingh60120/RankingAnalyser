// lib/url-inspection.js
// Google Search Console URL Inspection API.
// Returns Google's ACTUAL index status for a URL — the same verdict shown in
// the GSC "URL Inspection" screen (e.g. "Submitted and indexed",
// "Crawled - currently not indexed", "Discovered - currently not indexed").
//
// Hard limits imposed by Google, per property: 2,000 inspections/day, 600/min.
// Works with the existing webmasters.readonly OAuth scope.

const INSPECT_ENDPOINT = "https://searchconsole.googleapis.com/v1/urlInspection/index:inspect";

/**
 * Inspect one URL.
 * @returns {Promise<{indexed: boolean|null, verdict: string|null,
 *   coverageState: string|null, rateLimited?: boolean, error?: string}>}
 */
export async function inspectUrl(accessToken, siteUrl, inspectionUrl, { languageCode = "en-US" } = {}) {
  let res;
  try {
    res = await fetch(INSPECT_ENDPOINT, {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ inspectionUrl, siteUrl, languageCode }),
    });
  } catch (e) {
    return { indexed: null, verdict: null, coverageState: null, error: String(e.message || e) };
  }

  if (res.status === 429) return { indexed: null, verdict: null, coverageState: null, rateLimited: true };
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    return { indexed: null, verdict: null, coverageState: null, error: `HTTP ${res.status} ${text.slice(0, 160)}` };
  }

  let data;
  try { data = await res.json(); }
  catch (e) { return { indexed: null, verdict: null, coverageState: null, error: `Bad JSON: ${e.message}` }; }

  const idx = (data.inspectionResult && data.inspectionResult.indexStatusResult) || {};
  const verdict = idx.verdict || null;             // PASS | FAIL | NEUTRAL | VERDICT_UNSPECIFIED
  const coverageState = idx.coverageState || null; // e.g. "Submitted and indexed"
  const indexed = verdict === "PASS" ? true : verdict ? false : null;
  return {
    indexed, verdict, coverageState,
    robotsTxtState: idx.robotsTxtState,
    indexingState: idx.indexingState,
    lastCrawlTime: idx.lastCrawlTime,
  };
}

/**
 * Inspect many URLs with bounded concurrency, a per-run cap, and 429 backoff.
 * @returns {Promise<{results: Map, checked: number, rateLimited: boolean, errors: number}>}
 */
export async function inspectMany(accessToken, siteUrl, urls, opts = {}) {
  const maxInspections = Math.max(0, opts.maxInspections ?? 2000);
  const concurrency = Math.min(Math.max(1, opts.concurrency ?? 6), 10);
  const languageCode = opts.languageCode || "en-US";

  const queue = urls.slice(0, maxInspections);
  const results = new Map();
  let checked = 0, errors = 0, rateLimited = false, stop = false;

  async function worker() {
    while (queue.length && !stop) {
      const url = queue.shift();
      let attempt = 0, out = null;
      while (attempt < 3) {
        out = await inspectUrl(accessToken, siteUrl, url, { languageCode });
        if (out.rateLimited) {
          attempt++;
          await sleep(1500 * attempt);
          if (attempt >= 3) { rateLimited = true; stop = true; }
          continue;
        }
        break;
      }
      if (out && !out.rateLimited) {
        results.set(url, out);
        checked++;
        if (out.error) errors++;
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker));
  return { results, checked, rateLimited, errors };
}

/** Short, human label for a not-indexed URL: the coverage reason if present. */
export function indexLabel(inspection) {
  if (!inspection) return "Not checked";
  if (inspection.indexed === true) return "Indexed";
  if (inspection.indexed === false) return inspection.coverageState || "Not indexed";
  return "Unknown";
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
