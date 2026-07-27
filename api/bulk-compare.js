// api/bulk-compare.js
// POST /api/bulk-compare
//
// Month-on-month (or any period-on-period) comparison for a CSV of URLs.
// One property-wide GSC pull per period; every URL in the CSV is matched
// against each period. URLs with no data in a period keep blank metrics,
// meaning the URL was not indexed in that period. Nothing is estimated.
//
// Body (application/json):
//   {
//     "csv": "Title,URL\n...",                    // raw CSV text  (OR)
//     "rows": [{ "title": "...", "url": "..." }],
//     "periods": [{ "label": "June 2026", "startDate": "2026-06-01", "endDate": "2026-06-30" },
//                 { "label": "July 2026", "startDate": "2026-07-01", "endDate": "2026-07-26" }],
//     "country": "usa",                            // optional
//     "searchType": "web",                         // optional
//     "gscSiteUrl": "...",                         // optional -> env GSC_SITE_URL
//     "gscRefreshToken": "...",                    // optional -> env GSC_REFRESH_TOKEN
//     "format": "json" | "csv"                     // csv = wide comparison download
//   }

import {
  refreshAccessToken,
  queryManyPageMetrics,
  normalizeForMatch,
  indexMetricsByNormalizedUrl,
  resolveDateRange,
  normalizeCountry,
} from "../lib/gsc.js";
import { parseTitleUrlCsv, toCsv } from "../lib/csv.js";

const MAX_ROWS = 5000;
const MAX_PERIODS = 8;
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

export async function POST(request) {
  let body;
  try { body = await request.json(); }
  catch { return json({ error: "Invalid JSON body." }, 400); }

  // ---- rows ----
  let inputRows = [];
  let skippedHeader = false;
  if (typeof body.csv === "string" && body.csv.trim()) {
    const parsed = parseTitleUrlCsv(body.csv);
    inputRows = parsed.rows;
    skippedHeader = parsed.skippedHeader;
  } else if (Array.isArray(body.rows)) {
    inputRows = body.rows.map((r, i) => ({
      title: (r.title || "").trim(), url: (r.url || "").trim(), line: i + 1,
    }));
  }
  if (!inputRows.length) {
    return json({ error: "No rows found.",
                  hint: "Send a CSV with Title in column A and URL in column B, or a rows[] array." }, 400);
  }
  let truncatedRows = false;
  if (inputRows.length > MAX_ROWS) { inputRows = inputRows.slice(0, MAX_ROWS); truncatedRows = true; }

  // ---- periods ----
  let periods = Array.isArray(body.periods) ? body.periods : [];
  periods = periods
    .map((p, i) => ({
      label: String(p.label || `Period ${i + 1}`),
      startDate: String(p.startDate || ""),
      endDate: String(p.endDate || ""),
    }))
    .filter((p) => ISO_DAY.test(p.startDate) && ISO_DAY.test(p.endDate));
  if (periods.length < 2) {
    return json({ error: "Select at least two periods to compare.",
                  hint: "Pass periods: [{label, startDate, endDate}, ...] with YYYY-MM-DD dates." }, 400);
  }
  let periodsTruncated = false;
  if (periods.length > MAX_PERIODS) { periods = periods.slice(0, MAX_PERIODS); periodsTruncated = true; }
  periods = periods.map((p) => ({ ...p, ...resolveDateRange({ startDate: p.startDate, endDate: p.endDate }) }));

  const country = normalizeCountry(body.country);
  if (body.country && !country) {
    return json({ error: `Unrecognized country "${body.country}".`,
                  hint: "Use ISO alpha-3 like usa / ind / gbr, or a common form like US." }, 400);
  }
  const searchType = body.searchType;
  const wantCsv = (body.format || "").toLowerCase() === "csv" ||
                  (request.headers.get("accept") || "").includes("text/csv");

  const siteUrl = body.gscSiteUrl || process.env.GSC_SITE_URL || null;
  const refreshToken = body.gscRefreshToken || process.env.GSC_REFRESH_TOKEN || null;
  if (!siteUrl || !refreshToken) {
    return json({ error: "Search Console credentials missing.",
                  hint: "Pass gscSiteUrl + gscRefreshToken, or set GSC_SITE_URL + GSC_REFRESH_TOKEN env vars." }, 400);
  }

  // ---- auth ----
  let accessToken;
  try { ({ access_token: accessToken } = await refreshAccessToken(refreshToken)); }
  catch (e) { return json({ error: "GSC token refresh failed.", detail: String(e.message || e) }, 502); }

  // ---- one property-wide pull per period ----
  const periodData = [];
  for (const p of periods) {
    try {
      const exact = await queryManyPageMetrics(accessToken, siteUrl, {
        startDate: p.startDate, endDate: p.endDate,
        country: country || undefined, searchType,
      });
      periodData.push({ exact, norm: indexMetricsByNormalizedUrl(exact) });
    } catch (e) {
      periodData.push({ exact: new Map(), norm: new Map(), error: String(e.message || e) });
    }
  }

  // ---- match each CSV row against each period ----
  const isUrl = (v) => /^https?:\/\//i.test(v || "");
  const results = inputRows.map((r) => {
    if (!isUrl(r.url)) {
      return { title: r.title, url: r.url, invalid: true, indexed: false,
               periods: periods.map(() => empty()) };
    }
    const norm = normalizeForMatch(r.url);
    const per = periodData.map((pd) => {
      const hit = pd.exact.get(r.url) || pd.norm.get(norm);
      if (!hit) return empty();
      return { found: true, clicks: hit.clicks, impressions: hit.impressions,
               ctr: hit.ctr, position: hit.position };
    });
    return { title: r.title, url: r.url, indexed: per.some((p) => p.found), periods: per };
  });

  // ---- per-period totals over the CSV's URLs ----
  const totalsByPeriod = periods.map((p, pi) => {
    let clicks = 0, impressions = 0, posW = 0, matched = 0;
    for (const r of results) {
      const m = r.periods[pi];
      if (!m.found) continue;
      clicks += m.clicks; impressions += m.impressions;
      posW += m.position * m.impressions; matched++;
    }
    return {
      label: p.label, startDate: p.startDate, endDate: p.endDate,
      clicks, impressions,
      ctr: impressions ? +((clicks / impressions) * 100).toFixed(2) : 0,
      position: impressions ? +(posW / impressions).toFixed(1) : null,
      matchedUrls: matched,
      ...(periodData[pi].error ? { error: periodData[pi].error } : {}),
    };
  });

  // ---- CSV: wide format, one row per URL, periods as column groups ----
  if (wantCsv) {
    const header = ["Title", "URL", "Status"];
    for (const p of periods) {
      header.push(`${p.label} Clicks`, `${p.label} Impressions`, `${p.label} CTR (%)`, `${p.label} Avg Position`);
    }
    if (periods.length >= 2) {
      const a = periods[periods.length - 2].label, b = periods[periods.length - 1].label;
      header.push(`Clicks Change (${b} vs ${a})`, `Impressions Change (${b} vs ${a})`);
    }
    const rows = [header];
    for (const r of results) {
      const line = [r.title, r.url, r.invalid ? "Invalid URL" : r.indexed ? "Indexed" : "Not indexed"];
      for (const m of r.periods) {
        line.push(m.found ? m.clicks : "", m.found ? m.impressions : "",
                  m.found ? m.ctr : "", m.found ? m.position : "");
      }
      if (periods.length >= 2) {
        const a = r.periods[r.periods.length - 2], b = r.periods[r.periods.length - 1];
        line.push(a.found || b.found ? (b.clicks || 0) - (a.clicks || 0) : "",
                  a.found || b.found ? (b.impressions || 0) - (a.impressions || 0) : "");
      }
      rows.push(line);
    }
    return new Response(toCsv(rows), {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": 'attachment; filename="gsc-month-comparison.csv"',
      },
    });
  }

  return json({
    generatedAt: new Date().toISOString(),
    siteUrl,
    filters: { country: country || "all", searchType: searchType || "web",
               dataState: "all (includes fresh data, like the GSC UI)" },
    note: "Blank period metrics mean Search Console recorded no data for that URL in that period. " +
          "Dates follow the GSC calendar (Pacific Time).",
    periods: periods.map((p) => ({ label: p.label, startDate: p.startDate, endDate: p.endDate })),
    totals: {
      rows: results.length,
      indexed: results.filter((r) => r.indexed).length,
      notIndexed: results.filter((r) => !r.indexed && !r.invalid).length,
      invalid: results.filter((r) => r.invalid).length,
    },
    flags: {
      skippedHeader,
      truncatedRows: truncatedRows ? `input capped at ${MAX_ROWS} rows` : false,
      periodsTruncated: periodsTruncated ? `capped at ${MAX_PERIODS} periods` : false,
      periodErrors: periodData.map((pd, i) => pd.error ? { period: periods[i].label, error: pd.error } : null)
                              .filter(Boolean),
    },
    totalsByPeriod,
    results,
  });
}

function empty() {
  return { found: false, clicks: null, impressions: null, ctr: null, position: null };
}
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
