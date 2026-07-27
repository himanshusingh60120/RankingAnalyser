// api/hreflang-report.js
// POST /api/hreflang-report
//
// Weekly hreflang performance report. The user picks sitemaps from the site's
// sitemap index (see /api/sitemaps) plus one or more week ranges; this pulls
// clicks · impressions · CTR · avg position from Search Console for every URL
// in the chosen sitemaps, one property-wide bulk query per week, then rolls
// the numbers up per sitemap (= per hreflang/language) per week.
//
// Body (application/json):
//   {
//     "sitemaps": ["https://www.kingsresearch.com/sitemap-ja.xml", ...],  // required
//     "weeks": [{ "label": "Wk 28 · Jul 6–12",                            // required
//                 "startDate": "2026-07-06", "endDate": "2026-07-12" }],
//     "gscSiteUrl": "https://www.kingsresearch.com/",   // optional -> env GSC_SITE_URL
//     "gscRefreshToken": "...",                          // optional -> env GSC_REFRESH_TOKEN
//     "country": "usa",                                  // optional GSC country filter
//     "searchType": "web",                               // optional
//     "includeUrls": true,                               // optional per-URL rows (capped)
//     "format": "json" | "csv" | "xlsx"                  // csv = long format; xlsx = styled workbook,\n//                                                        //   Summary sheet + one sheet per language
//   }

import {
  refreshAccessToken,
  queryManyPageMetrics,
  normalizeForMatch,
  indexMetricsByNormalizedUrl,
  resolveDateRange,
  normalizeCountry,
} from "../lib/gsc.js";
import { collectSitemapUrls } from "../lib/sitemaps.js";
import { toCsv } from "../lib/csv.js";
import { buildHreflangWorkbook } from "../lib/xlsx-report.js";

const MAX_SITEMAPS = 12;   // selected sitemaps per run
const MAX_WEEKS = 8;       // week ranges per run (each = 1+ GSC bulk queries)
const MAX_URLS = 30000;    // total sitemap URLs processed
const MAX_URL_ROWS = 2000; // per-URL rows returned in JSON (CSV gets them all)
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

export async function POST(request) {
  let body;
  try { body = await request.json(); }
  catch { return json({ error: "Invalid JSON body." }, 400); }

  // ---- validate sitemaps ----
  let sitemaps = Array.isArray(body.sitemaps)
    ? body.sitemaps.map((s) => String(s || "").trim()).filter((s) => /^https?:\/\//i.test(s))
    : [];
  if (!sitemaps.length) {
    return json({ error: "No sitemaps selected.", hint: "Pass sitemaps: [url, ...] — list them via /api/sitemaps first." }, 400);
  }
  let sitemapsTruncated = false;
  if (sitemaps.length > MAX_SITEMAPS) { sitemaps = sitemaps.slice(0, MAX_SITEMAPS); sitemapsTruncated = true; }

  // ---- validate weeks ----
  let weeks = Array.isArray(body.weeks) ? body.weeks : [];
  weeks = weeks
    .map((w, i) => ({
      label: String(w.label || `Week ${i + 1}`),
      startDate: String(w.startDate || ""),
      endDate: String(w.endDate || ""),
    }))
    .filter((w) => ISO_DAY.test(w.startDate) && ISO_DAY.test(w.endDate));
  if (!weeks.length) {
    return json({ error: "No valid weeks supplied.", hint: "Pass weeks: [{label, startDate, endDate}] with YYYY-MM-DD dates." }, 400);
  }
  let weeksTruncated = false;
  if (weeks.length > MAX_WEEKS) { weeks = weeks.slice(0, MAX_WEEKS); weeksTruncated = true; }
  // normalize (swap reversed ranges) and echo the exact GSC/PT dates used
  weeks = weeks.map((w) => ({ ...w, ...resolveDateRange({ startDate: w.startDate, endDate: w.endDate }) }));

  const country = normalizeCountry(body.country);
  if (body.country && !country) {
    return json({ error: `Unrecognized country "${body.country}".`,
                  hint: "Use ISO alpha-3 like usa / ind / gbr, or a common form like US." }, 400);
  }
  const searchType = body.searchType;
  const includeUrls = body.includeUrls !== false;
  const fmt = (body.format || "").toLowerCase();
  const wantCsv = fmt === "csv" || (request.headers.get("accept") || "").includes("text/csv");
  const wantXlsx = fmt === "xlsx" || fmt === "excel";

  const siteUrl = body.gscSiteUrl || process.env.GSC_SITE_URL || null;
  const refreshToken = body.gscRefreshToken || process.env.GSC_REFRESH_TOKEN || null;
  if (!siteUrl || !refreshToken) {
    return json({ error: "Search Console credentials missing.",
                  hint: "Pass gscSiteUrl + gscRefreshToken, or set GSC_SITE_URL + GSC_REFRESH_TOKEN env vars." }, 400);
  }

  // ---- 1. collect URLs from the selected sitemaps ----
  const { perSitemap, truncated: urlsTruncated } =
    await collectSitemapUrls(sitemaps, { maxUrls: MAX_URLS });
  const totalUrls = perSitemap.reduce((n, s) => n + s.urls.length, 0);
  if (!totalUrls) {
    return json({
      error: "No page URLs could be read from the selected sitemaps.",
      sitemaps: perSitemap.map((s) => ({ sitemap: s.sitemap, error: s.error || "0 URLs" })),
    }, 502);
  }

  // ---- 2. auth ----
  let accessToken;
  try { ({ access_token: accessToken } = await refreshAccessToken(refreshToken)); }
  catch (e) { return json({ error: "GSC token refresh failed.", detail: String(e.message || e) }, 502); }

  // ---- 3. one property-wide bulk query per week ----
  const weekData = []; // [{ exact: Map, norm: Map, error? }]
  for (const w of weeks) {
    try {
      const exact = await queryManyPageMetrics(accessToken, siteUrl, {
        startDate: w.startDate, endDate: w.endDate,
        country: country || undefined, searchType,
      });
      weekData.push({ exact, norm: indexMetricsByNormalizedUrl(exact) });
    } catch (e) {
      weekData.push({ exact: new Map(), norm: new Map(), error: String(e.message || e) });
    }
  }

  // ---- 4. match + roll up ----
  const urlRows = [];
  const sitemapReports = perSitemap.map((sm) => {
    const weekTotals = weeks.map(() => ({
      clicks: 0, impressions: 0, posWeighted: 0, matchedUrls: 0,
    }));

    for (const pageUrl of sm.urls) {
      const norm = normalizeForMatch(pageUrl);
      const perWeek = weekData.map((wd, wi) => {
        const hit = wd.exact.get(pageUrl) || wd.norm.get(norm);
        if (!hit) return { found: false, clicks: null, impressions: null, ctr: null, position: null };
        const t = weekTotals[wi];
        t.clicks += hit.clicks;
        t.impressions += hit.impressions;
        t.posWeighted += hit.position * hit.impressions;
        t.matchedUrls++;
        return { found: true, clicks: hit.clicks, impressions: hit.impressions,
                 ctr: hit.ctr, position: hit.position };
      });
      if (includeUrls && perWeek.some((p) => p.found)) {
        urlRows.push({ url: pageUrl, sitemap: sm.sitemap, lang: sm.lang.code, langLabel: sm.lang.label, weeks: perWeek });
      }
    }

    return {
      sitemap: sm.sitemap,
      lang: sm.lang,
      urlCount: sm.urls.length,
      ...(sm.error ? { warning: sm.error } : {}),
      weeks: weekTotals.map((t, wi) => ({
        label: weeks[wi].label,
        startDate: weeks[wi].startDate,
        endDate: weeks[wi].endDate,
        clicks: t.clicks,
        impressions: t.impressions,
        ctr: t.impressions ? +((t.clicks / t.impressions) * 100).toFixed(2) : 0,
        position: t.impressions ? +(t.posWeighted / t.impressions).toFixed(1) : null,
        matchedUrls: t.matchedUrls,
        ...(weekData[wi].error ? { error: weekData[wi].error } : {}),
      })),
    };
  });

  // grand totals per week across the selected sitemaps
  const grandTotals = weeks.map((w, wi) => {
    let clicks = 0, impressions = 0, posW = 0, matched = 0;
    for (const sr of sitemapReports) {
      const t = sr.weeks[wi];
      clicks += t.clicks; impressions += t.impressions;
      posW += (t.position || 0) * t.impressions; matched += t.matchedUrls;
    }
    return {
      label: w.label, startDate: w.startDate, endDate: w.endDate,
      clicks, impressions,
      ctr: impressions ? +((clicks / impressions) * 100).toFixed(2) : 0,
      position: impressions ? +(posW / impressions).toFixed(1) : null,
      matchedUrls: matched,
      ...(weekData[wi].error ? { error: weekData[wi].error } : {}),
    };
  });

  // rank per-URL rows by impressions in the last selected week, cap for JSON
  urlRows.sort((a, b) => {
    const li = urlRows.length ? a.weeks.length - 1 : 0;
    return (b.weeks[li].impressions || 0) - (a.weeks[li].impressions || 0);
  });

  // ---- XLSX: summary sheet + one sheet per language (full, uncapped) ----
  if (wantXlsx) {
    const wb = buildHreflangWorkbook({
      siteUrl,
      generatedAt: new Date().toISOString(),
      filters: { country: country || "all", searchType: searchType || "web" },
      weeks: weeks.map((w) => ({ label: w.label, startDate: w.startDate, endDate: w.endDate })),
      grandTotals,
      sitemapReports,
      urlRows,
    });
    const buf = await wb.xlsx.writeBuffer();
    return new Response(buf, {
      status: 200,
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": 'attachment; filename="hreflang-weekly-report.xlsx"',
      },
    });
  }

  // ---- CSV: long format, one row per URL per week (full, uncapped) ----
  if (wantCsv) {
    const header = ["Sitemap", "Language", "URL", "Week", "Start", "End",
                    "Clicks", "Impressions", "CTR (%)", "Avg Position"];
    const rows = [header];
    // sitemap roll-up rows first
    for (const sr of sitemapReports) {
      for (const wt of sr.weeks) {
        rows.push([sr.sitemap, sr.lang.label, "(all URLs in sitemap)", wt.label,
                   wt.startDate, wt.endDate, wt.clicks, wt.impressions, wt.ctr,
                   wt.position == null ? "" : wt.position]);
      }
    }
    for (const r of urlRows) {
      r.weeks.forEach((pw, wi) => {
        if (!pw.found) return;
        rows.push([r.sitemap, r.lang, r.url, weeks[wi].label,
                   weeks[wi].startDate, weeks[wi].endDate,
                   pw.clicks, pw.impressions, pw.ctr, pw.position]);
      });
    }
    return new Response(toCsv(rows), {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": 'attachment; filename="hreflang-weekly-report.csv"',
      },
    });
  }

  const urlRowsCapped = urlRows.length > MAX_URL_ROWS;
  return json({
    generatedAt: new Date().toISOString(),
    siteUrl,
    filters: {
      country: country || "all",
      searchType: searchType || "web",
      dataState: "all (includes fresh data, like the GSC UI)",
    },
    note: "Weeks use GSC calendar dates (Pacific Time). Set the same custom range " +
          "(+ country filter) in the GSC UI to verify totals 1:1.",
    weeks: weeks.map((w) => ({ label: w.label, startDate: w.startDate, endDate: w.endDate })),
    totals: {
      sitemaps: sitemapReports.length,
      urlsInSitemaps: totalUrls,
      urlsWithData: urlRows.length,
    },
    flags: {
      sitemapsTruncated: sitemapsTruncated ? `capped at ${MAX_SITEMAPS} sitemaps` : false,
      weeksTruncated: weeksTruncated ? `capped at ${MAX_WEEKS} weeks` : false,
      urlsTruncated: urlsTruncated ? `sitemap URLs capped at ${MAX_URLS}` : false,
      urlRowsCapped: urlRowsCapped ? `per-URL rows capped at ${MAX_URL_ROWS} in JSON (CSV has all)` : false,
      weekErrors: weekData.map((wd, i) => wd.error ? { week: weeks[i].label, error: wd.error } : null)
                          .filter(Boolean),
    },
    grandTotals,
    sitemaps: sitemapReports,
    ...(includeUrls ? { urls: urlRows.slice(0, MAX_URL_ROWS) } : {}),
  });
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
