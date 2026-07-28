// api/hreflang-assemble.js
// POST /api/hreflang-assemble
//
// Final step of the free-tier chunked flow. The browser has already called
// /api/hreflang-report with { partial:true, sessionId, langCode } once per
// language, storing each slice in KV. This reads all slices back and builds the
// combined report — no Search Console or sitemap work, so it finishes quickly
// even for ~27k URLs across all languages, staying inside Vercel Hobby's 60s.
//
// Body: { sessionId, format: "json" | "csv" | "xlsx" }

import { loadSession } from "../lib/report-session.js";
import { isKvConfigured } from "../lib/kv.js";
import { buildHreflangWorkbook } from "../lib/xlsx-report.js";
import { toCsv } from "../lib/csv.js";

export async function POST(request) {
  if (!isKvConfigured()) return json({ error: "No KV store connected." }, 503);
  let body;
  try { body = await request.json(); } catch { return json({ error: "Invalid JSON body." }, 400); }

  const sessionId = typeof body.sessionId === "string" ? body.sessionId.replace(/[^a-z0-9_-]/gi, "").slice(0, 60) : "";
  if (!sessionId) return json({ error: "sessionId is required." }, 400);

  const fmt = (body.format || "").toLowerCase();
  const wantCsv = fmt === "csv" || (request.headers.get("accept") || "").includes("text/csv");
  const wantXlsx = fmt === "xlsx" || fmt === "excel";

  const session = await loadSession(sessionId);
  if (!session) return json({ error: "Session not found or expired. Re-run the language passes." }, 404);
  const { meta, slices } = session;
  if (!slices.length) return json({ error: "No language slices stored for this session yet." }, 400);

  // reconstruct sitemapReports + urlRows in a stable language order
  const order = meta.langs || slices.map((s) => s.sitemapReport.lang.code);
  slices.sort((a, b) => order.indexOf(a.sitemapReport.lang.code) - order.indexOf(b.sitemapReport.lang.code));
  const sitemapReports = slices.map((s) => s.sitemapReport);
  const urlRows = slices.flatMap((s) => s.urlRows || []);
  const weeks = meta.weeks || [];

  // grand totals per week across all languages
  const grandTotals = weeks.map((w, wi) => {
    let clicks = 0, impressions = 0, posW = 0, matched = 0;
    for (const sr of sitemapReports) {
      const t = sr.weeks[wi]; if (!t) continue;
      clicks += t.clicks; impressions += t.impressions;
      posW += (t.position || 0) * t.impressions; matched += t.matchedUrls;
    }
    return {
      label: w.label, startDate: w.startDate, endDate: w.endDate,
      clicks, impressions,
      ctr: impressions ? +((clicks / impressions) * 100).toFixed(2) : 0,
      position: impressions ? +(posW / impressions).toFixed(1) : null,
      matchedUrls: matched,
    };
  });

  const totals = {
    sitemaps: sitemapReports.length,
    urlsInSitemaps: sitemapReports.reduce((n, s) => n + (s.urlCount || 0), 0),
    urlsIndexed: sitemapReports.reduce((n, s) => n + (s.indexedUrls || 0), 0),
    urlsUnindexed: sitemapReports.reduce((n, s) => n + (s.unindexedUrls || 0), 0),
  };

  // ----- XLSX -----
  if (wantXlsx) {
    const wb = buildHreflangWorkbook({
      siteUrl: meta.siteUrl,
      generatedAt: new Date().toISOString(),
      filters: meta.filters || { country: "all", searchType: "web" },
      weeks, grandTotals, sitemapReports, urlRows,
      periodType: meta.periodType || "week",
      indexActive: meta.indexActive, indexMeta: meta.indexMeta,
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

  // ----- CSV -----
  if (wantCsv) {
    const idxCol = !!meta.indexActive;
    const header = ["Sitemap", "Language", "URL", "Search Data",
                    ...(idxCol ? [(meta.indexMeta && meta.indexMeta.colHeader) || "Index Status"] : []),
                    "Week", "Start", "End", "Clicks", "Impressions", "CTR (%)", "Avg Position"];
    const rows = [header];
    for (const sr of sitemapReports) {
      for (const wt of sr.weeks) {
        rows.push([sr.sitemap, sr.lang.label, "(all URLs in sitemap)", "",
                   ...(idxCol ? [""] : []),
                   wt.label, wt.startDate, wt.endDate, wt.clicks, wt.impressions, wt.ctr,
                   wt.position == null ? "" : wt.position]);
      }
    }
    for (const r of urlRows) {
      r.weeks.forEach((pw, wi) => {
        rows.push([r.sitemap, r.lang, r.url, r.indexed ? "Has data" : "No data",
                   ...(idxCol ? [(r.indexStatus && r.indexStatus.label) || ""] : []),
                   weeks[wi].label, weeks[wi].startDate, weeks[wi].endDate,
                   pw.found ? pw.clicks : "", pw.found ? pw.impressions : "",
                   pw.found ? pw.ctr : "", pw.found ? pw.position : ""]);
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

  // ----- JSON (default): summary for on-screen render (URLs capped) -----
  return json({
    generatedAt: new Date().toISOString(),
    siteUrl: meta.siteUrl,
    filters: meta.filters,
    weeks, grandTotals, totals,
    periodType: meta.periodType || "week",
    sitemaps: sitemapReports,
    urls: urlRows.filter((r) => r.indexed).slice(0, 2000),
  });
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj, null, 2), { status, headers: { "Content-Type": "application/json" } });
}
