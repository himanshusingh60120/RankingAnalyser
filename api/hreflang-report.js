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
//     "verifyIndexing": false,                           // optional: check TRUE index status
//     "maxInspections": 2000,                            //   via URL Inspection API (2000/day cap)
//     "format": "json" | "csv" | "xlsx"                  // csv = long format; xlsx = styled workbook,
//                                                        //   Summary sheet + one sheet per language
//   }

import {
  refreshAccessToken,
  queryManyPageMetrics,
  normalizeForMatch,
  indexMetricsByNormalizedUrl,
  resolveDateRange,
  normalizeCountry,
  listSites,
  resolveSiteForRequest,
} from "../lib/gsc.js";
import { collectSitemapUrls, urlMatchesLang } from "../lib/sitemaps.js";
import { toCsv } from "../lib/csv.js";
import { buildHreflangWorkbook } from "../lib/xlsx-report.js";
import { inspectMany, indexLabel } from "../lib/url-inspection.js";
import { loadLatestCrawl } from "../lib/crawl-store.js";
import { parseScreamingFrogCsv, buildSfIndex, sfIndexMeta } from "../lib/screaming-frog.js";
import { pageFilterForLang, saveSlice, saveSessionMeta } from "../lib/report-session.js";
import { isKvConfigured } from "../lib/kv.js";

const MAX_SITEMAPS = 12;   // selected sitemaps per run
const MAX_WEEKS = 8;       // week ranges per run (each = 1+ GSC bulk queries)
const MAX_URLS = 60000;    // total sitemap URLs processed
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

  // ---- validate periods (weeks or months; "periods" is an alias) ----
  const periodType = (body.periodType || "").toLowerCase() === "month" ? "month" : "week";
  let weeks = Array.isArray(body.weeks) ? body.weeks
            : Array.isArray(body.periods) ? body.periods : [];
  weeks = weeks
    .map((w, i) => ({
      label: String(w.label || (periodType === "month" ? `Month ${i + 1}` : `Week ${i + 1}`)),
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
  const verifyIndexing = body.verifyIndexing === true;
  const useCrawlData = body.useCrawlData === true; // fill index status from the latest Screaming Frog crawl (no quota)
  const maxInspections = Number.isFinite(body.maxInspections) && body.maxInspections > 0
    ? Math.min(Math.floor(body.maxInspections), 2000) : 2000;
  // free-tier chunked mode: compute one language's slice and stash it in KV
  const partial = body.partial === true;
  const sessionId = typeof body.sessionId === "string" ? body.sessionId.replace(/[^a-z0-9_-]/gi, "").slice(0, 60) : "";
  const langCode = typeof body.langCode === "string" ? body.langCode : "";
  const fmt = (body.format || "").toLowerCase();
  const wantCsv = fmt === "csv" || (request.headers.get("accept") || "").includes("text/csv");
  const wantXlsx = fmt === "xlsx" || fmt === "excel";

  // Property resolved after auth against the account's real property list.
  const requestedSite = String(body.gscSiteUrl || "").trim() || null;
  const envSite = String(process.env.GSC_SITE_URL || "").trim() || null;
  const autoDetectSite = body.autoDetectSite !== false;
  const refreshToken = body.gscRefreshToken || process.env.GSC_REFRESH_TOKEN || null;
  if (!refreshToken) {
    return json({ error: "Search Console credentials missing.",
                  hint: "Pass gscRefreshToken, or set the GSC_REFRESH_TOKEN env var." }, 400);
  }

  // ---- 1. collect URLs from the selected sitemaps ----
  const { perSitemap, truncated: urlsTruncated } =
    await collectSitemapUrls(sitemaps, { maxUrls: MAX_URLS });
  const rawUrlTotal = perSitemap.reduce((n, s) => n + s.urls.length, 0);
  if (!rawUrlTotal) {
    return json({
      error: "No page URLs could be read from the selected sitemaps.",
      sitemaps: perSitemap.map((s) => ({ sitemap: s.sitemap, error: s.error || "0 URLs" })),
    }, 502);
  }

  // ---- 2. auth ----
  let accessToken;
  try { ({ access_token: accessToken } = await refreshAccessToken(refreshToken)); }
  catch (e) { return json({ error: "GSC token refresh failed.", detail: String(e.message || e) }, 502); }

  // ---- 2b. which property? ----
  // The token reads every property this Google account is verified on, so the
  // sitemap's own URLs decide the property when one wasn't named.
  let sites = [];
  let sitesError = null;
  try { sites = await listSites(accessToken); }
  catch (e) { sitesError = String(e.message || e); }

  const sampleUrls = perSitemap.flatMap((s) => (s.urls || []).slice(0, 25));
  const picked = resolveSiteForRequest({
    requested: requestedSite,
    envSite,
    sites,
    urls: sampleUrls,
    autoDetect: autoDetectSite,
  });
  if (!picked.siteUrl) {
    return json({
      error: picked.reason === "no-access"
        ? `This Google account has no Search Console property matching "${requestedSite}".`
        : "Could not tell which Search Console property to query.",
      hint: "Pass gscSiteUrl set to one of availableProperties, exactly as listed.",
      availableProperties: sites.filter((s) => s.canQuery).map((s) => s.siteUrl),
      ...(sitesError ? { sitesError } : {}),
    }, 400);
  }
  const siteUrl = picked.siteUrl;

  // ---- 3. one property-wide bulk query per week ----
  // In partial (free-tier) mode, scope each GSC query to this one language's
  // URL pattern so the request stays small and fast (well under 60s).
  const pageFilter = partial && langCode ? pageFilterForLang(langCode) : {};

  const weekData = []; // [{ exact: Map, norm: Map, error? }]
  for (const w of weeks) {
    try {
      const exact = await queryManyPageMetrics(accessToken, siteUrl, {
        startDate: w.startDate, endDate: w.endDate,
        country: country || undefined, searchType,
        ...pageFilter,
      });
      weekData.push({ exact, norm: indexMetricsByNormalizedUrl(exact) });
    } catch (e) {
      weekData.push({ exact: new Map(), norm: new Map(), error: String(e.message || e) });
    }
  }

  // ---- 4. group selected sitemaps by language, keep only URLs that belong ----
  // A localized sitemap (e.g. /fr/sitemap-reports.xml) may list URLs that
  // aren't actually that language's pages. Group every selected sitemap by its
  // detected language, then keep only URLs whose own path matches that language
  // (root/no-prefix URLs count as English). This makes "URLs in Sitemap" reflect
  // the language's real pages instead of the whole catalog. URLs are de-duped.
  const langGroups = new Map(); // code -> { lang, sitemaps:[], urls:Set, warnings:[] }
  for (const sm of perSitemap) {
    const code = sm.lang.code;
    if (!langGroups.has(code)) langGroups.set(code, { lang: sm.lang, sitemaps: [], urls: new Set(), warnings: [] });
    const g = langGroups.get(code);
    g.sitemaps.push(sm.sitemap);
    if (sm.error) g.warnings.push(`${smShort(sm.sitemap)}: ${sm.error}`);
    for (const u of sm.urls) if (urlMatchesLang(u, code)) g.urls.add(u);
  }
  const perLang = [...langGroups.values()].map((g) => ({
    lang: g.lang,
    sitemaps: g.sitemaps,
    urls: [...g.urls],
    warning: g.warnings.length ? g.warnings.join(" · ") : null,
  }));
  const totalUrls = perLang.reduce((n, g) => n + g.urls.length, 0);

  // ---- 4b. optional: attach a per-URL index status ----
  // Two sources, in priority order:
  //   1. Screaming Frog data (quota-free, covers every crawled URL) — either a
  //      CSV uploaded in this request, or the latest crawl stored in KV by the
  //      local agent (useCrawlData).
  //   2. URL Inspection API (Google's live verdict, capped at 2000/day).
  // Whichever is active produces a lookup of url -> { kind, label } where
  // kind is "good" (indexed/indexable) | "bad" (not) | "missing" | "unknown".
  let sfSource = null;
  let crawlMeta = null;
  if (typeof body.screamingFrogCsv === "string" && body.screamingFrogCsv.trim()) {
    const parsed = parseScreamingFrogCsv(body.screamingFrogCsv);
    if (parsed.entries.length) sfSource = { entries: parsed.entries, basis: parsed.basis };
  } else if (useCrawlData) {
    const { map, meta } = await loadLatestCrawl();
    if (map.size) {
      // stored records: r.i (indexed bool|null) + r.l (label). Convert to compact "kind|label".
      const compact = {};
      let basis = "crawl";
      for (const [key, rec] of map) {
        if (!/^https?:\/\//i.test(key)) continue; // skip normalized-only keys
        const kind = rec.indexed === true ? "good" : rec.indexed === false ? "bad" : "unknown";
        const label = rec.label || (rec.indexed === true ? "Indexable" : "Non-Indexable");
        compact[key] = `${kind}|${label}`;
        if (/indexed|on google/i.test(label)) basis = "gsc";
      }
      sfSource = { compact, basis };
      crawlMeta = meta;
    } else {
      crawlMeta = meta; // no crawl yet
    }
  }

  let indexLookup = null;   // { exact: Map, norm: Map }
  let indexMeta = null;     // { source, colHeader, sectionTitle, goodLabel, badLabel, missingLabel, note }
  let inspectionMeta = null;
  let crawlMetaOut = crawlMeta;

  if (sfSource) {
    indexLookup = buildSfIndex(sfSource);
    indexMeta = sfIndexMeta(sfSource.basis);
  } else if (verifyIndexing) {
    // order: URLs with no search data first (most worth verifying), then the rest
    const withData = new Set();
    for (const wd of weekData) for (const u of wd.exact.keys()) withData.add(u);
    const ordered = [];
    for (const g of perLang) for (const u of g.urls) if (!withData.has(u)) ordered.push(u);
    for (const g of perLang) for (const u of g.urls) if (withData.has(u)) ordered.push(u);

    const { results, checked, rateLimited, errors } =
      await inspectMany(accessToken, siteUrl, ordered, { maxInspections });
    const exact = new Map(), norm = new Map();
    for (const [url, insp] of results) {
      const val = insp.indexed === true ? { kind: "good", label: "Indexed" }
        : insp.indexed === false ? { kind: "bad", label: indexLabel(insp) }
        : { kind: "unknown", label: "Unknown" };
      exact.set(url, val);
      const n = normalizeForMatch(url);
      if (!norm.has(n)) norm.set(n, val);
    }
    indexLookup = { exact, norm };
    indexMeta = { source: "gsc-inspection", colHeader: "Index Status (GSC)",
      sectionTitle: "Index Status verified via URL Inspection (Google's actual verdict)",
      goodLabel: "Indexed", badLabel: "Not Indexed", missingLabel: "Not Checked (over daily quota)",
      note: "Index Status is Google's real verdict from the URL Inspection API. Not Indexed includes states such as 'Crawled - currently not indexed'. The API allows 2,000 inspections per property per day, so Not Checked URLs roll over to a later run." };
    inspectionMeta = { requested: Math.min(ordered.length, maxInspections), checked, rateLimited, errors,
                       totalUrls, notChecked: totalUrls - checked };
  }
  const indexActive = !!indexLookup;

  // ---- 5. match + roll up (one entry per language) ----
  // A URL is "indexed" (search sense) when Search Console returns data for it in
  // at least one selected week; otherwise unindexed. Every sitemap URL is listed
  // with that status. When an index source is active each URL also carries a
  // true index status (kind + label) and per-language good/bad/missing tallies.
  const urlRows = [];      // every checked URL (indexed and unindexed)
  let unindexedTotal = 0;  // URLs with no GSC data in any selected week
  const sitemapReports = perLang.map((sm) => {
    const weekTotals = weeks.map(() => ({
      clicks: 0, impressions: 0, posWeighted: 0, matchedUrls: 0,
    }));
    let indexedCount = 0;
    let ixGood = 0, ixBad = 0, ixMissing = 0;

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
      const indexed = perWeek.some((p) => p.found);
      if (indexed) indexedCount++;

      let indexStatus;
      if (indexActive) {
        const hit = indexLookup.exact.get(pageUrl) || indexLookup.norm.get(norm);
        indexStatus = hit || { kind: "missing", label: indexMeta.missingLabel };
        if (indexStatus.kind === "good") ixGood++;
        else if (indexStatus.kind === "bad") ixBad++;
        else ixMissing++;
      }

      if (includeUrls) urlRows.push({ url: pageUrl, sitemap: sm.sitemaps[0], lang: sm.lang.code,
                                      langLabel: sm.lang.label, indexed, weeks: perWeek,
                                      ...(indexStatus ? { indexStatus } : {}) });
    }
    const unindexedCount = sm.urls.length - indexedCount;
    unindexedTotal += unindexedCount;

    return {
      sitemap: sm.sitemaps.join(" , "),
      sitemaps: sm.sitemaps,
      lang: sm.lang,
      urlCount: sm.urls.length,
      indexedUrls: indexedCount,
      unindexedUrls: unindexedCount,
      ...(indexActive ? { indexStatusCounts: { good: ixGood, bad: ixBad, missing: ixMissing } } : {}),
      ...(sm.warning ? { warning: sm.warning } : {}),
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

  // rank rows: indexed first (by latest-week impressions), then unindexed A-Z
  urlRows.sort((a, b) => {
    if (a.indexed !== b.indexed) return a.indexed ? -1 : 1;
    if (!a.indexed) return a.url.localeCompare(b.url);
    const li = a.weeks.length - 1;
    return (b.weeks[li].impressions || 0) - (a.weeks[li].impressions || 0);
  });

  // ---- Partial (free-tier) mode: stash this language's slice, return summary ----
  if (partial) {
    if (!sessionId) return json({ error: "partial mode requires a sessionId." }, 400);
    if (!isKvConfigured()) return json({ error: "partial mode needs a KV store connected." }, 503);
    const codes = sitemapReports.map((s) => s.lang.code);
    for (const sr of sitemapReports) {
      const code = sr.lang.code;
      const rows = urlRows.filter((u) => u.lang === code);
      await saveSlice(sessionId, code, { sitemapReport: sr, urlRows: rows });
    }
    await saveSessionMeta(sessionId, {
      langs: codes, siteUrl,
      weeks: weeks.map((w) => ({ label: w.label, startDate: w.startDate, endDate: w.endDate })),
      filters: { country: country || "all", searchType: searchType || "web" },
      periodType,
      indexActive, indexMeta,
    });
    return json({
      partial: true, sessionId,
      languages: sitemapReports.map((s) => ({
        code: s.lang.code, label: s.lang.label,
        urlsInSitemap: s.urlCount, indexed: s.indexedUrls, unindexed: s.unindexedUrls,
      })),
      totals: {
        urlsInSitemaps: totalUrls,
        urlsIndexed: urlRows.filter((r) => r.indexed).length,
      },
      ...(inspectionMeta ? { indexVerification: inspectionMeta } : {}),
    });
  }

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
      periodType,
      indexActive,
      indexMeta,
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
    const idxCol = indexActive;
    const header = ["Sitemap", "Language", "URL", "Search Data",
                    ...(idxCol ? [indexMeta.colHeader] : []),
                    "Week", "Start", "End", "Clicks", "Impressions", "CTR (%)", "Avg Position"];
    const rows = [header];
    // sitemap roll-up rows first
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
                   ...(idxCol ? [(r.indexStatus && r.indexStatus.label) || "Not checked"] : []),
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

  const urlRowsCapped = urlRows.length > MAX_URL_ROWS;
  return json({
    generatedAt: new Date().toISOString(),
    siteUrl,
    siteResolution: {
      siteUrl,
      reason: picked.reason,
      verified: picked.verified !== false,
      permissionLevel: picked.site ? picked.site.permissionLevel : null,
      propertiesOnAccount: sites.length || null,
    },
    filters: {
      country: country || "all",
      searchType: searchType || "web",
      dataState: "all (includes fresh data, like the GSC UI)",
    },
    note: "Weeks use GSC calendar dates (Pacific Time). Set the same custom range " +
          "(+ country filter) in the GSC UI to verify totals 1:1. Unindexed URLs " +
          "(no Search Console data in any selected week) are counted, not listed.",
    weeks: weeks.map((w) => ({ label: w.label, startDate: w.startDate, endDate: w.endDate })),
    totals: {
      sitemaps: sitemapReports.length,
      urlsInSitemaps: totalUrls,
      urlsIndexed: urlRows.filter((r) => r.indexed).length,
      urlsUnindexed: unindexedTotal,
      ...(indexActive ? {
        indexStatus: {
          source: indexMeta.source,
          label: indexMeta.colHeader,
          good: sitemapReports.reduce((n, s) => n + (s.indexStatusCounts ? s.indexStatusCounts.good : 0), 0),
          bad: sitemapReports.reduce((n, s) => n + (s.indexStatusCounts ? s.indexStatusCounts.bad : 0), 0),
          missing: sitemapReports.reduce((n, s) => n + (s.indexStatusCounts ? s.indexStatusCounts.missing : 0), 0),
          goodLabel: indexMeta.goodLabel, badLabel: indexMeta.badLabel, missingLabel: indexMeta.missingLabel,
        },
      } : {}),
    },
    ...(inspectionMeta ? { indexVerification: inspectionMeta } : {}),
    ...(crawlMetaOut ? { crawl: { jobId: crawlMetaOut.jobId, finishedAt: crawlMetaOut.finishedAt, counts: crawlMetaOut.counts } } : {}),
    periodType,
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

function smShort(u) {
  try { return new URL(u).pathname; } catch { return u; }
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
