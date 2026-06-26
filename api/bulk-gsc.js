// api/bulk-gsc.js
// POST /api/bulk-gsc
//
// Attach a CSV of pages (column A = Title, column B = URL) and get the latest
// Search Console metrics — average position (rank), CTR, impressions, clicks —
// pulled and inserted for every URL.
//
// Body (application/json):
//   {
//     "csv": "Title,URL\n...",        // raw CSV text   (OR)
//     "rows": [{ "title": "...", "url": "..." }],
//     "gscSiteUrl": "https://www.kingsresearch.com/",   // optional -> env GSC_SITE_URL
//     "gscRefreshToken": "...",        // optional -> env GSC_REFRESH_TOKEN
//     "days": 28,                       // optional, default 28 (recent window = "latest")
//     "precise": false,                 // optional, exact per-URL query for every row
//     "format": "json" | "csv"          // optional, default json
//   }
//
// You can also POST raw "text/csv" as the body and pass params on the query
// string: /api/bulk-gsc?days=28&format=csv&site=https://www.kingsresearch.com/
//
// CSV output columns (original two kept, metrics inserted after):
//   Title, URL, Avg Position, CTR (%), Impressions, Clicks, Found

import {
  refreshAccessToken,
  queryManyPageMetrics,
  queryPageTotals,
  normalizeForMatch,
  indexMetricsByNormalizedUrl,
} from "../lib/gsc.js";
import { parseTitleUrlCsv, toCsv } from "../lib/csv.js";

const MAX_ROWS = 5000;        // hard ceiling on CSV rows processed
const MAX_PER_URL = 250;      // cap on exact per-URL GSC calls (bounds runtime)
const POOL = 6;               // per-URL request concurrency

export async function POST(request) {
  // ---- read body: JSON, or raw text/csv with query-string params ----
  const u = new URL(request.url);
  const ctype = (request.headers.get("content-type") || "").toLowerCase();
  let body = {};
  let csvText = null;

  if (ctype.includes("application/json")) {
    try { body = await request.json(); }
    catch { return json({ error: "Invalid JSON body." }, 400); }
    csvText = typeof body.csv === "string" ? body.csv : null;
  } else {
    // treat the raw body as CSV; params come from the query string
    csvText = await request.text();
    body = {
      gscSiteUrl: u.searchParams.get("site") || undefined,
      gscRefreshToken: u.searchParams.get("token") || undefined,
      days: u.searchParams.get("days") ? Number(u.searchParams.get("days")) : undefined,
      precise: u.searchParams.get("precise") === "true",
      format: u.searchParams.get("format") || undefined,
    };
  }

  const days = Number.isFinite(body.days) && body.days > 0 ? Math.floor(body.days) : 28;
  const precise = body.precise === true;
  const wantCsv =
    (body.format || "").toLowerCase() === "csv" ||
    (request.headers.get("accept") || "").includes("text/csv");

  const siteUrl = body.gscSiteUrl || process.env.GSC_SITE_URL || null;
  const refreshToken = body.gscRefreshToken || process.env.GSC_REFRESH_TOKEN || null;

  if (!siteUrl || !refreshToken) {
    return json({
      error: "Search Console credentials missing.",
      hint: "Pass gscSiteUrl + gscRefreshToken, or set GSC_SITE_URL + GSC_REFRESH_TOKEN " +
            "env vars. Get a refresh token from /api/auth/start.",
    }, 400);
  }

  // ---- collect rows: parsed CSV or pre-supplied rows[] ----
  let inputRows = [];
  let skippedHeader = false;
  if (csvText && csvText.trim()) {
    const parsed = parseTitleUrlCsv(csvText);
    inputRows = parsed.rows;
    skippedHeader = parsed.skippedHeader;
  } else if (Array.isArray(body.rows)) {
    inputRows = body.rows.map((r, i) => ({
      title: (r.title || "").trim(),
      url: (r.url || "").trim(),
      line: i + 1,
    }));
  }

  if (!inputRows.length) {
    return json({
      error: "No rows found.",
      hint: "Send a CSV with Title in column A and URL in column B, or a rows[] array.",
    }, 400);
  }

  let truncatedRows = false;
  if (inputRows.length > MAX_ROWS) {
    inputRows = inputRows.slice(0, MAX_ROWS);
    truncatedRows = true;
  }

  const isUrl = (v) => /^https?:\/\//i.test(v || "");

  // ---- get an access token ----
  let accessToken;
  try {
    ({ access_token: accessToken } = await refreshAccessToken(refreshToken));
  } catch (e) {
    return json({ error: "GSC token refresh failed.", detail: String(e.message || e) }, 502);
  }

  // ---- bulk pull (one call) unless precise mode forces per-URL for all ----
  let exactMap = new Map();
  let normIndex = new Map();
  let bulkError = null;
  if (!precise) {
    try {
      exactMap = await queryManyPageMetrics(accessToken, siteUrl, days);
      normIndex = indexMetricsByNormalizedUrl(exactMap);
    } catch (e) {
      bulkError = String(e.message || e);
    }
  }

  // ---- first pass: match each row against the bulk data ----
  const results = inputRows.map((r) => {
    if (!isUrl(r.url)) {
      return { ...r, found: false, invalid: true, source: null,
               position: null, ctr: null, impressions: null, clicks: null };
    }
    if (!precise) {
      const hit = exactMap.get(r.url) || normIndex.get(normalizeForMatch(r.url));
      if (hit) {
        return { ...r, found: true, source: "bulk",
                 position: hit.position, ctr: hit.ctr,
                 impressions: hit.impressions, clicks: hit.clicks };
      }
    }
    return { ...r, found: false, source: null,
             position: null, ctr: null, impressions: null, clicks: null };
  });

  // ---- second pass: exact per-URL lookups ----
  // precise mode -> every valid row; otherwise only the bulk misses.
  const needLookup = results.filter((r) => !r.invalid && !r.found);
  let lookupTruncated = false;
  let toLookup = needLookup;
  if (toLookup.length > MAX_PER_URL) {
    toLookup = toLookup.slice(0, MAX_PER_URL);
    lookupTruncated = true;
  }

  const lookupErrors = [];
  await pool(toLookup, POOL, async (r) => {
    try {
      const t = await queryPageTotals(accessToken, siteUrl, r.url, days);
      if (t.hasData) {
        r.found = true;
        r.source = "per-url";
        r.position = t.position;
        r.ctr = t.ctr;
        r.impressions = t.impressions;
        r.clicks = t.clicks;
      }
    } catch (e) {
      lookupErrors.push({ url: r.url, error: String(e.message || e) });
    }
  });

  // ---- shape output ----
  const matched = results.filter((r) => r.found).length;
  const clean = results.map((r) => ({
    title: r.title,
    url: r.url,
    found: r.found,
    position: r.found ? r.position : null,   // avg rank
    ctr: r.found ? r.ctr : null,             // %
    impressions: r.found ? r.impressions : null,
    clicks: r.found ? r.clicks : null,
    source: r.source,
    ...(r.invalid ? { invalid: true } : {}),
  }));

  if (wantCsv) {
    const header = ["Title", "URL", "Avg Position", "CTR (%)", "Impressions", "Clicks", "Found"];
    const out = [header, ...clean.map((r) => [
      r.title,
      r.url,
      r.position == null ? "" : r.position,
      r.ctr == null ? "" : r.ctr,
      r.impressions == null ? "" : r.impressions,
      r.clicks == null ? "" : r.clicks,
      r.found ? "yes" : "no",
    ])];
    return new Response(toCsv(out), {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": 'attachment; filename="gsc-metrics.csv"',
      },
    });
  }

  return json({
    generatedAt: new Date().toISOString(),
    siteUrl,
    days,
    mode: precise ? "precise (per-URL)" : "bulk + per-URL fallback",
    note: "Position/CTR/impressions are aggregated over the last " + days +
          " days (GSC data lags ~2-3 days). Lower 'days' for a fresher window.",
    totals: {
      rows: clean.length,
      matched,
      unmatched: clean.length - matched,
    },
    flags: {
      skippedHeader,
      truncatedRows: truncatedRows ? `input capped at ${MAX_ROWS} rows` : false,
      lookupTruncated: lookupTruncated ? `per-URL lookups capped at ${MAX_PER_URL}` : false,
      bulkError,
      lookupErrors: lookupErrors.length ? lookupErrors.slice(0, 10) : undefined,
    },
    results: clean,
  });
}

// run an async fn over items with bounded concurrency
async function pool(items, size, fn) {
  const queue = items.slice();
  const workers = Array.from({ length: Math.min(size, queue.length) }, async () => {
    while (queue.length) {
      const item = queue.shift();
      await fn(item);
    }
  });
  await Promise.all(workers);
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
