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
//     "startDate": "2026-06-15",        // optional custom range (YYYY-MM-DD, GSC/PT dates)
//     "endDate": "2026-07-12",          //   — overrides "days"; matches GSC UI custom ranges
//     "country": "usa",                 // optional country filter (US / usa / United States)
//     "searchType": "web",              // optional: web | image | video | news | discover
//     "extractTitles": false,           // optional: fetch each URL and read its real <title>
//     "precise": false,                 // optional, exact per-URL query for every row
//     "format": "json" | "csv"          // optional, default json
//   }
//
// You can also POST raw "text/csv" as the body and pass params on the query
// string: /api/bulk-gsc?days=28&format=csv&site=https://www.kingsresearch.com/
//   (also supported: start, end, country, searchType, extractTitles=true)
//
// CSV output columns (original two kept, metrics inserted after):
//   Title, URL, Avg Position, CTR (%), Impressions, Clicks, Found

import {
  refreshAccessToken,
  queryManyPageMetrics,
  queryPageTotals,
  normalizeForMatch,
  indexMetricsByNormalizedUrl,
  resolveDateRange,
  normalizeCountry,
} from "../lib/gsc.js";
import { parseTitleUrlCsv, toCsv } from "../lib/csv.js";
import { fetchTitle } from "../lib/titles.js";

const MAX_ROWS = 5000;        // hard ceiling on CSV rows processed
const MAX_PER_URL = 250;      // cap on exact per-URL GSC calls (bounds runtime)
const MAX_TITLE_FETCH = 250;  // cap on live title fetches (bounds runtime)
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
      startDate: u.searchParams.get("start") || undefined,
      endDate: u.searchParams.get("end") || undefined,
      country: u.searchParams.get("country") || undefined,
      searchType: u.searchParams.get("searchType") || undefined,
      extractTitles: u.searchParams.get("extractTitles") === "true",
      precise: u.searchParams.get("precise") === "true",
      format: u.searchParams.get("format") || undefined,
    };
  }

  const days = Number.isFinite(body.days) && body.days > 0 ? Math.floor(body.days) : 28;
  const precise = body.precise === true;
  const extractTitles = body.extractTitles === true;
  const country = normalizeCountry(body.country);
  if (body.country && !country) {
    return json({
      error: `Unrecognized country "${body.country}".`,
      hint: "Use an ISO 3166-1 alpha-3 code like usa, ind, gbr — or a common form like US / United States.",
    }, 400);
  }
  // One options object drives every GSC call so all rows share the exact
  // same window/filters — and we echo the resolved dates back so results can
  // be verified 1:1 against the GSC UI with the same custom range + filters.
  const gscOpts = {
    days,
    startDate: body.startDate,
    endDate: body.endDate,
    country: country || undefined,
    searchType: body.searchType,
  };
  const range = resolveDateRange(gscOpts);
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
      exactMap = await queryManyPageMetrics(accessToken, siteUrl, gscOpts);
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
      const t = await queryPageTotals(accessToken, siteUrl, r.url, gscOpts);
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

  // ---- title extraction: read the live <title> straight from each URL ----
  // The URL is the source of truth; CSV titles are often stale or missing.
  let titlesFetched = 0;
  let titleTruncated = false;
  const titleErrors = [];
  if (extractTitles) {
    let toTitle = results.filter((r) => !r.invalid);
    if (toTitle.length > MAX_TITLE_FETCH) {
      toTitle = toTitle.slice(0, MAX_TITLE_FETCH);
      titleTruncated = true;
    }
    await pool(toTitle, POOL, async (r) => {
      try {
        const t = await fetchTitle(r.url);
        if (t.title) { r.title = t.title; r.titleSource = "live"; titlesFetched++; }
        else if (t.error) titleErrors.push({ url: r.url, error: t.error });
      } catch (e) {
        titleErrors.push({ url: r.url, error: String(e.message || e) });
      }
    });
  }

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
    ...(r.titleSource ? { titleSource: r.titleSource } : {}),
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
    dateRange: range, // exact GSC (PT) dates used — set the same custom range in the GSC UI to verify
    filters: {
      country: country || "all",
      searchType: gscOpts.searchType || "web",
      dataState: "all (includes fresh data, like the GSC UI)",
    },
    mode: precise ? "precise (per-URL)" : "bulk + per-URL fallback",
    note: `Metrics aggregated ${range.startDate} → ${range.endDate} (GSC/Pacific dates, ` +
          `fresh data included). To verify in the GSC UI, set the same custom date range` +
          (country ? ` and Country filter (${country})` : "") + ".",
    totals: {
      rows: clean.length,
      matched,
      unmatched: clean.length - matched,
      ...(extractTitles ? { titlesExtracted: titlesFetched } : {}),
    },
    flags: {
      skippedHeader,
      truncatedRows: truncatedRows ? `input capped at ${MAX_ROWS} rows` : false,
      lookupTruncated: lookupTruncated ? `per-URL lookups capped at ${MAX_PER_URL}` : false,
      titleTruncated: titleTruncated ? `title fetches capped at ${MAX_TITLE_FETCH}` : false,
      bulkError,
      lookupErrors: lookupErrors.length ? lookupErrors.slice(0, 10) : undefined,
      titleErrors: titleErrors.length ? titleErrors.slice(0, 10) : undefined,
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
