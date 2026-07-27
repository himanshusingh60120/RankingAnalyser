// lib/xlsx-report.js
// Builds the weekly hreflang report as an Excel workbook (exceljs).
//
// Layout:
//   Sheet 1 "Summary"     language table (indexed URLs, clicks, impressions,
//                         CTR, avg position per week) and a ranked table of
//                         top performing languages for the latest week.
//   One sheet per sitemap the language's URL-level data, weeks as grouped
//                         columns. No summary blocks on these sheets.
//
// Style rules: plain human-maintained look. No frozen panes, no arrow or
// delta symbols, no generation notes. Totals and CTR cells are live Excel
// formulas with cached results.

import ExcelJS from "exceljs";

const F = "Arial";
const NAVY = "FF1F3548";
const WHITE = "FFFFFFFF";
const BAND = "FFF3F6F9";
const RULE = "FFD5DDE4";
const MUTED = "FF6B7A88";

const NUM = "#,##0";
const PCT2 = "0.00";
const POS1 = "0.0";
const DELTA = "+#,##0;-#,##0;0";

const thin = { style: "thin", color: { argb: RULE } };
const boxAll = { top: thin, left: thin, bottom: thin, right: thin };

function headCell(c, text) {
  c.value = text;
  c.font = { name: F, size: 9, bold: true, color: { argb: WHITE } };
  c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: NAVY } };
  c.alignment = { vertical: "middle", horizontal: "center", wrapText: true };
  c.border = boxAll;
}
function sectionTitle(ws, row, text, span) {
  ws.mergeCells(row, 1, row, span);
  const c = ws.getCell(row, 1);
  c.value = text;
  c.font = { name: F, size: 11, bold: true, color: { argb: NAVY } };
  c.border = { bottom: { style: "medium", color: { argb: NAVY } } };
  ws.getRow(row).height = 18;
}
function noteCell(ws, row, text, span) {
  ws.mergeCells(row, 1, row, span);
  const c = ws.getCell(row, 1);
  c.value = text;
  c.font = { name: F, size: 8, italic: true, color: { argb: MUTED } };
}
function dataCell(c, value, numFmt, opts = {}) {
  c.value = value == null ? "" : value;
  c.font = { name: F, size: 9, ...(opts.bold ? { bold: true } : {}) };
  if (numFmt) c.numFmt = numFmt;
  c.border = boxAll;
  c.alignment = { vertical: "middle", horizontal: opts.left ? "left" : "right" };
  if (opts.band) c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: BAND } };
}
function fx(c, formula, result, numFmt, opts = {}) {
  c.value = { formula, result: result == null ? 0 : result };
  c.font = { name: F, size: 9, ...(opts.bold ? { bold: true } : {}) };
  if (numFmt) c.numFmt = numFmt;
  c.border = boxAll;
  c.alignment = { vertical: "middle", horizontal: "right" };
  if (opts.band) c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: BAND } };
}
const colL = (n) => {
  let s = "";
  while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = (n - 1 - m) / 26; }
  return s;
};
function pageTitle(ws, title, subtitle, span) {
  ws.mergeCells(1, 1, 1, span);
  const t = ws.getCell(1, 1);
  t.value = title;
  t.font = { name: F, size: 14, bold: true, color: { argb: NAVY } };
  ws.getRow(1).height = 22;
  if (subtitle) {
    ws.mergeCells(2, 1, 2, span);
    const s = ws.getCell(2, 1);
    s.value = subtitle;
    s.font = { name: F, size: 9, color: { argb: MUTED } };
  }
}
function sheetName(base, used) {
  let name = base.replace(/[\\/*?:\[\]]/g, " ").trim().slice(0, 31) || "Sheet";
  let n = 2;
  while (used.has(name.toLowerCase())) {
    const suffix = ` (${n++})`;
    name = base.slice(0, 31 - suffix.length) + suffix;
  }
  used.add(name.toLowerCase());
  return name;
}
const fmtDate = (iso) => {
  const d = new Date(iso + "T00:00:00Z");
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
};
const dateSpan = (a, b) => fmtDate(a) + " to " + fmtDate(b);
const wkTitle = (label) => String(label || "").split("\u00b7")[0].trim();

/**
 * @param {object} r  { siteUrl, filters, weeks, grandTotals, sitemapReports, urlRows }
 * @returns {ExcelJS.Workbook}
 */
export function buildHreflangWorkbook(r) {
  const wb = new ExcelJS.Workbook();
  wb.creator = "Ranking X-Ray";

  const weeks = r.weeks || [];
  const li = weeks.length - 1;
  const period = (r.periodType || "week") === "month" ? "Month" : "Week";
  const used = new Set();
  const noun = (r.periodType || "week") === "month" ? "Month" : "Week";
  const perWeekCols = 5; // Indexed URLs, Clicks, Impressions, CTR, Avg Position

  // =========================== SUMMARY ===========================
  const cols = 2 + weeks.length * perWeekCols;
  const ws = wb.addWorksheet(sheetName("Summary", used));
  const rangeTxt = weeks.length ? dateSpan(weeks[0].startDate, weeks[li].endDate) : "";
  const countryTxt = (r.filters && r.filters.country) || "all";
  pageTitle(ws, "Search Performance by Language",
    [hostOf(r.siteUrl), rangeTxt, "Country: " + countryTxt].filter(Boolean).join("   |   "), cols);

  // ---- language table: indexed URLs + metrics per week ----
  let row = 4;
  sectionTitle(ws, row, "Language Performance by " + noun, cols);
  row++;
  const h1 = row, h2 = row + 1;
  ws.mergeCells(h1, 1, h2, 1); headCell(ws.getCell(h1, 1), "Language");
  ws.mergeCells(h1, 2, h2, 2); headCell(ws.getCell(h1, 2), "URLs in Sitemap");
  weeks.forEach((w, i) => {
    const c0 = 3 + i * perWeekCols;
    ws.mergeCells(h1, c0, h1, c0 + perWeekCols - 1);
    headCell(ws.getCell(h1, c0), wkTitle(w.label) + "\n" + dateSpan(w.startDate, w.endDate));
    ["Indexed URLs", "Clicks", "Impressions", "CTR (%)", "Avg Position"]
      .forEach((t, j) => headCell(ws.getCell(h2, c0 + j), t));
  });
  ws.getRow(h1).height = 26;
  row = h2 + 1;

  const firstDataRow = row;
  (r.sitemapReports || []).forEach((sr, si) => {
    const band = si % 2 === 1;
    dataCell(ws.getCell(row, 1), langLabel(sr), null, { left: true, band });
    dataCell(ws.getCell(row, 2), sr.urlCount, NUM, { band });
    sr.weeks.forEach((wt, wi) => {
      const c0 = 3 + wi * perWeekCols;
      dataCell(ws.getCell(row, c0), wt.matchedUrls, NUM, { band });
      dataCell(ws.getCell(row, c0 + 1), wt.clicks, NUM, { band });
      dataCell(ws.getCell(row, c0 + 2), wt.impressions, NUM, { band });
      fx(ws.getCell(row, c0 + 3),
        `IFERROR(${colL(c0 + 1)}${row}/${colL(c0 + 2)}${row}*100,0)`, wt.ctr, PCT2, { band });
      dataCell(ws.getCell(row, c0 + 4), wt.position, POS1, { band });
    });
    row++;
  });
  const lastDataRow = row - 1;

  dataCell(ws.getCell(row, 1), "TOTAL", null, { left: true, bold: true });
  fx(ws.getCell(row, 2), `SUM(B${firstDataRow}:B${lastDataRow})`,
    (r.sitemapReports || []).reduce((n, s) => n + (s.urlCount || 0), 0), NUM, { bold: true });
  (r.grandTotals || []).forEach((gt, wi) => {
    const c0 = 3 + wi * perWeekCols;
    fx(ws.getCell(row, c0), `SUM(${colL(c0)}${firstDataRow}:${colL(c0)}${lastDataRow})`, gt.matchedUrls, NUM, { bold: true });
    fx(ws.getCell(row, c0 + 1), `SUM(${colL(c0 + 1)}${firstDataRow}:${colL(c0 + 1)}${lastDataRow})`, gt.clicks, NUM, { bold: true });
    fx(ws.getCell(row, c0 + 2), `SUM(${colL(c0 + 2)}${firstDataRow}:${colL(c0 + 2)}${lastDataRow})`, gt.impressions, NUM, { bold: true });
    fx(ws.getCell(row, c0 + 3), `IFERROR(${colL(c0 + 1)}${row}/${colL(c0 + 2)}${row}*100,0)`, gt.ctr, PCT2, { bold: true });
    dataCell(ws.getCell(row, c0 + 4), gt.position, POS1, { bold: true });
  });
  row += 2;

  // ---- top performing languages, latest week ----
  if (weeks.length) {
    const ranked = (r.sitemapReports || [])
      .map((sr) => ({ sr, wt: sr.weeks[li], prev: li > 0 ? sr.weeks[li - 1] : null }))
      .sort((a, b) => (b.wt.clicks - a.wt.clicks) || (b.wt.impressions - a.wt.impressions));

    const hasPrev = li > 0;
    const topCols = hasPrev ? 8 : 7;
    sectionTitle(ws, row, "Top Performing Languages, " + wkTitle(weeks[li].label) + " (" + dateSpan(weeks[li].startDate, weeks[li].endDate) + ")", cols);
    row++;
    const heads = ["Rank", "Language", "Indexed URLs", "Clicks", "Impressions", "CTR (%)", "Avg Position"];
    if (hasPrev) heads.push("Clicks vs Prior " + noun);
    heads.forEach((t, i) => headCell(ws.getCell(row, i + 1), t));
    row++;
    ranked.forEach((e, i) => {
      const band = i % 2 === 1;
      dataCell(ws.getCell(row, 1), i + 1, "0", { band });
      dataCell(ws.getCell(row, 2), langLabel(e.sr), null, { left: true, band });
      dataCell(ws.getCell(row, 3), e.wt.matchedUrls, NUM, { band });
      dataCell(ws.getCell(row, 4), e.wt.clicks, NUM, { band });
      dataCell(ws.getCell(row, 5), e.wt.impressions, NUM, { band });
      fx(ws.getCell(row, 6), `IFERROR(D${row}/E${row}*100,0)`, e.wt.ctr, PCT2, { band });
      dataCell(ws.getCell(row, 7), e.wt.position, POS1, { band });
      if (hasPrev) dataCell(ws.getCell(row, 8), e.wt.clicks - e.prev.clicks, DELTA, { band });
      row++;
    });
    row++;
  }

  noteCell(ws, row, "CTR = Clicks / Impressions. Avg position is weighted by impressions. Indexed URLs are the URLs that recorded impressions in the " + noun.toLowerCase() + ". Blank cells mean Search Console recorded no data for that URL in that " + noun.toLowerCase() + ". Dates follow the Search Console calendar (Pacific Time).", cols);

  ws.getColumn(1).width = 22;
  ws.getColumn(2).width = 15;
  for (let c = 3; c <= cols; c++) ws.getColumn(c).width = 12;

  // ====================== PER-LANGUAGE SHEETS ======================
  const urls = (r.urlRows || []).slice();
  urls.sort((a, b) => {
    const ai = a.indexed !== false, bi = b.indexed !== false;
    if (ai !== bi) return ai ? -1 : 1;
    if (!ai) return String(a.url).localeCompare(String(b.url));
    return ((b.weeks[li] && b.weeks[li].impressions) || 0) - ((a.weeks[li] && a.weeks[li].impressions) || 0);
  });

  for (const sr of r.sitemapReports || []) {
    const name = sheetName(langLabel(sr), used);
    const lws = wb.addWorksheet(name);
    const lcols = 2 + weeks.length * 4;

    pageTitle(lws, langLabel(sr), sr.sitemap, lcols);

    const uh1 = 3, uh2 = 4;
    lws.mergeCells(uh1, 1, uh2, 1); headCell(lws.getCell(uh1, 1), "URL");
    lws.mergeCells(uh1, 2, uh2, 2); headCell(lws.getCell(uh1, 2), "Status");
    weeks.forEach((w, i) => {
      const c0 = 3 + i * 4;
      lws.mergeCells(uh1, c0, uh1, c0 + 3);
      headCell(lws.getCell(uh1, c0), wkTitle(w.label) + "\n" + dateSpan(w.startDate, w.endDate));
      ["Clicks", "Impressions", "CTR (%)", "Avg Position"].forEach((t, j) => headCell(lws.getCell(uh2, c0 + j), t));
    });
    lws.getRow(uh1).height = 26;

    let lr = uh2 + 1;
    // indexed URLs first (sorted by latest impressions), then not-indexed A-Z
    const langUrls = urls.filter((u) => u.sitemap === sr.sitemap && u.indexed !== false);
    const langNotIndexed = (r.urlRows || [])
      .filter((u) => u.sitemap === sr.sitemap && u.indexed === false)
      .sort((a, b) => a.url.localeCompare(b.url));
    const allRows = langUrls.concat(langNotIndexed);
    allRows.forEach((u, i) => {
      const band = i % 2 === 1;
      const indexed = u.indexed !== false;
      dataCell(lws.getCell(lr, 1), u.url, null, { left: true, band });
      dataCell(lws.getCell(lr, 2), indexed ? "Indexed" : "Not indexed", null, { left: true, band });
      weeks.forEach((w, wi) => {
        const c0 = 3 + wi * 4;
        const pw = u.weeks[wi] || {};
        dataCell(lws.getCell(lr, c0), pw.found ? pw.clicks : null, NUM, { band });
        dataCell(lws.getCell(lr, c0 + 1), pw.found ? pw.impressions : null, NUM, { band });
        dataCell(lws.getCell(lr, c0 + 2), pw.found ? pw.ctr : null, PCT2, { band });
        dataCell(lws.getCell(lr, c0 + 3), pw.found ? pw.position : null, POS1, { band });
      });
      lr++;
    });
    if (allRows.length) {
      lws.autoFilter = { from: { row: uh2, column: 1 }, to: { row: lr - 1, column: lcols } };
    }
    lws.getColumn(1).width = 64;
    lws.getColumn(2).width = 12;
    for (let c = 3; c <= lcols; c++) lws.getColumn(c).width = 11;
  }

  return wb;
}

function langLabel(sr) {
  return sr.lang && sr.lang.label ? sr.lang.label : "Default";
}
function hostOf(u) {
  try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return u || ""; }
}
