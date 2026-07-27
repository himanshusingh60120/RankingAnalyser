// lib/xlsx-report.js
// Builds the weekly hreflang report as a real Excel workbook (exceljs).
//
// Layout:
//   Sheet 1 "Summary"        — per sitemap · per week matrix, week-over-week,
//                              top URLs by impressions in the latest week.
//   One sheet per sitemap    — that language's weekly totals + every URL with
//                              data, weeks as grouped columns.
//
// Totals, CTR and week-over-week deltas are written as live Excel formulas
// (with cached results) so the workbook recalculates like a hand-built file.
// Avg position roll-ups are impressions-weighted and written as values; a note
// on each sheet states the method.

import ExcelJS from "exceljs";

// ---- palette / fonts (kept deliberately corporate) ----
const F = "Arial";
const NAVY = "FF1F3548";      // header fill
const NAVY_TXT = "FFFFFFFF";
const BAND = "FFF3F6F9";      // zebra band
const RULE = "FFD5DDE4";      // thin border
const MUTED = "FF6B7A88";     // secondary text
const ACCENT = "FF1F3548";
const GOOD = "FF1E7B45";
const BAD = "FFB3402F";

const NUM = "#,##0";
const PCT2 = "0.00";
const POS1 = "0.0";

const thin = { style: "thin", color: { argb: RULE } };
const boxAll = { top: thin, left: thin, bottom: thin, right: thin };

function headCell(c, text) {
  c.value = text;
  c.font = { name: F, size: 9, bold: true, color: { argb: NAVY_TXT } };
  c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: NAVY } };
  c.alignment = { vertical: "middle", horizontal: "center", wrapText: true };
  c.border = boxAll;
}
function sectionTitle(ws, row, text, span) {
  ws.mergeCells(row, 1, row, span);
  const c = ws.getCell(row, 1);
  c.value = text;
  c.font = { name: F, size: 11, bold: true, color: { argb: ACCENT } };
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
  c.font = { name: F, size: 9, ...(opts.bold ? { bold: true } : {}), ...(opts.color ? { color: { argb: opts.color } } : {}) };
  if (numFmt) c.numFmt = numFmt;
  c.border = boxAll;
  c.alignment = { vertical: "middle", horizontal: opts.left ? "left" : "right" };
  if (opts.band) c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: BAND } };
}
const colL = (n) => {
  let s = "";
  while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = (n - 1 - m) / 26; }
  return s;
};
function fx(c, formula, result, numFmt, opts = {}) {
  c.value = { formula, result: result == null ? 0 : result };
  c.font = { name: F, size: 9, ...(opts.bold ? { bold: true } : {}), ...(opts.color ? { color: { argb: opts.color } } : {}) };
  if (numFmt) c.numFmt = numFmt;
  c.border = boxAll;
  c.alignment = { vertical: "middle", horizontal: "right" };
  if (opts.band) c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: BAND } };
}
function pageTitle(ws, title, subtitle, span) {
  ws.mergeCells(1, 1, 1, span);
  const t = ws.getCell(1, 1);
  t.value = title;
  t.font = { name: F, size: 14, bold: true, color: { argb: ACCENT } };
  ws.getRow(1).height = 22;
  ws.mergeCells(2, 1, 2, span);
  const s = ws.getCell(2, 1);
  s.value = subtitle;
  s.font = { name: F, size: 9, color: { argb: MUTED } };
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
const weekShort = (label) => String(label).replace(/^Week\s+/i, "W").split("·")[0].trim();
const fmtDate = (iso) => {
  const d = new Date(iso + "T00:00:00Z");
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
};

/**
 * @param {object} r  report data: { siteUrl, generatedAt, filters, weeks,
 *                    grandTotals, sitemapReports, urlRows }
 * @returns {ExcelJS.Workbook}
 */
export function buildHreflangWorkbook(r) {
  const wb = new ExcelJS.Workbook();
  wb.creator = "Ranking X-Ray";
  wb.created = new Date(r.generatedAt || Date.now());

  const weeks = r.weeks || [];
  const li = weeks.length - 1; // latest week index
  const used = new Set();

  // =========================== SUMMARY ===========================
  const cols = 2 + weeks.length * 4;
  const ws = wb.addWorksheet(sheetName("Summary", used), {
    views: [{ state: "frozen", ySplit: 6 }],
    properties: { defaultRowHeight: 14 },
  });
  const rangeTxt = weeks.length
    ? `${fmtDate(weeks[0].startDate)} – ${fmtDate(weeks[li].endDate)}`
    : "";
  pageTitle(ws, "Search Performance by Language — Weekly Report",
    `${r.siteUrl || ""}   ·   ${rangeTxt}   ·   Country: ${(r.filters && r.filters.country) || "all"}   ·   Search type: ${(r.filters && r.filters.searchType) || "web"}   ·   Generated ${fmtDate((r.generatedAt || new Date().toISOString()).slice(0, 10))}`,
    cols);

  // ---- Section 1: per sitemap · per week ----
  let row = 4;
  sectionTitle(ws, row, "Per sitemap · per week", cols);
  row++;
  // header band: two rows
  const h1 = row, h2 = row + 1;
  ws.mergeCells(h1, 1, h2, 1); headCell(ws.getCell(h1, 1), "Language / sitemap");
  ws.mergeCells(h1, 2, h2, 2); headCell(ws.getCell(h1, 2), "URLs in sitemap");
  weeks.forEach((w, i) => {
    const c0 = 3 + i * 4;
    ws.mergeCells(h1, c0, h1, c0 + 3);
    headCell(ws.getCell(h1, c0), `${w.label}\n${w.startDate} → ${w.endDate}`);
    ["Clicks", "Impressions", "CTR (%)", "Avg pos"].forEach((t, j) => headCell(ws.getCell(h2, c0 + j), t));
  });
  ws.getRow(h1).height = 26;
  row = h2 + 1;

  const firstDataRow = row;
  (r.sitemapReports || []).forEach((sr, si) => {
    const band = si % 2 === 1;
    const label = `${sr.lang && sr.lang.label ? sr.lang.label : "Default"} — ${smPath(sr.sitemap)}`;
    dataCell(ws.getCell(row, 1), label, null, { left: true, band });
    dataCell(ws.getCell(row, 2), sr.urlCount, NUM, { band });
    sr.weeks.forEach((wt, wi) => {
      const c0 = 3 + wi * 4;
      dataCell(ws.getCell(row, c0), wt.clicks, NUM, { band });
      dataCell(ws.getCell(row, c0 + 1), wt.impressions, NUM, { band });
      // CTR as live formula off the two cells beside it
      fx(ws.getCell(row, c0 + 2),
        `IFERROR(${colL(c0)}${row}/${colL(c0 + 1)}${row}*100,0)`, wt.ctr, PCT2, { band });
      dataCell(ws.getCell(row, c0 + 3), wt.position, POS1, { band });
    });
    row++;
  });
  const lastDataRow = row - 1;

  // TOTAL row — SUM formulas over the block above
  dataCell(ws.getCell(row, 1), "TOTAL — all selected sitemaps", null, { left: true, bold: true });
  fx(ws.getCell(row, 2), `SUM(B${firstDataRow}:B${lastDataRow})`,
    (r.sitemapReports || []).reduce((n, s) => n + (s.urlCount || 0), 0), NUM, { bold: true });
  (r.grandTotals || []).forEach((gt, wi) => {
    const c0 = 3 + wi * 4;
    fx(ws.getCell(row, c0), `SUM(${colL(c0)}${firstDataRow}:${colL(c0)}${lastDataRow})`, gt.clicks, NUM, { bold: true });
    fx(ws.getCell(row, c0 + 1), `SUM(${colL(c0 + 1)}${firstDataRow}:${colL(c0 + 1)}${lastDataRow})`, gt.impressions, NUM, { bold: true });
    fx(ws.getCell(row, c0 + 2), `IFERROR(${colL(c0)}${row}/${colL(c0 + 1)}${row}*100,0)`, gt.ctr, PCT2, { bold: true });
    dataCell(ws.getCell(row, c0 + 3), gt.position, POS1, { bold: true });
  });
  for (let c = 1; c <= cols; c++) ws.getCell(row, c).border = { ...boxAll, top: { style: "double", color: { argb: NAVY } } };
  row += 1;
  noteCell(ws, row, "CTR = Clicks ÷ Impressions. Avg position is impressions-weighted across the sitemap's URLs. Dates follow Search Console's calendar (Pacific Time); set the same custom range and country filter in the GSC UI to verify totals.", cols);
  row += 2;

  // ---- Section 2: week-over-week ----
  const totalRowRef = lastDataRow + 1; // the TOTAL row above
  sectionTitle(ws, row, "Week-over-week — all selected sitemaps", cols);
  row++;
  ["Week", "Dates", "Clicks", "Δ clicks", "Impressions", "Δ impressions", "CTR (%)", "Avg pos"]
    .forEach((t, i) => headCell(ws.getCell(row, i + 1), t));
  row++;
  const wowFirst = row;
  (r.grandTotals || []).forEach((gt, wi) => {
    const band = wi % 2 === 1;
    dataCell(ws.getCell(row, 1), gt.label, null, { left: true, band });
    dataCell(ws.getCell(row, 2), `${gt.startDate} → ${gt.endDate}`, null, { left: true, band });
    // clicks / impressions reference the TOTAL row of the matrix — stays live
    const cClicks = colL(3 + wi * 4), cImpr = colL(4 + wi * 4);
    fx(ws.getCell(row, 3), `${cClicks}${totalRowRef}`, gt.clicks, NUM, { band });
    if (wi === 0) dataCell(ws.getCell(row, 4), "", null, { band });
    else {
      const d = gt.clicks - r.grandTotals[wi - 1].clicks;
      fx(ws.getCell(row, 4), `C${row}-C${row - 1}`, d, "+#,##0;-#,##0;0", { band, color: d > 0 ? GOOD : d < 0 ? BAD : undefined });
    }
    fx(ws.getCell(row, 5), `${cImpr}${totalRowRef}`, gt.impressions, NUM, { band });
    if (wi === 0) dataCell(ws.getCell(row, 6), "", null, { band });
    else {
      const d = gt.impressions - r.grandTotals[wi - 1].impressions;
      fx(ws.getCell(row, 6), `E${row}-E${row - 1}`, d, "+#,##0;-#,##0;0", { band, color: d > 0 ? GOOD : d < 0 ? BAD : undefined });
    }
    fx(ws.getCell(row, 7), `IFERROR(C${row}/E${row}*100,0)`, gt.ctr, PCT2, { band });
    dataCell(ws.getCell(row, 8), gt.position, POS1, { band });
    row++;
  });
  row += 1;

  // ---- Section 3: top URLs, latest week ----
  const urls = (r.urlRows || []).slice();
  urls.sort((a, b) => ((b.weeks[li] && b.weeks[li].impressions) || 0) - ((a.weeks[li] && a.weeks[li].impressions) || 0));
  const top = urls.slice(0, 25);
  if (weeks.length && top.length) {
    sectionTitle(ws, row, `Top URLs — by impressions in ${weeks[li].label}`, cols);
    row++;
    const hu = row;
    headCell(ws.getCell(hu, 1), "Language");
    headCell(ws.getCell(hu, 2), "URL");
    weeks.forEach((w, i) => {
      headCell(ws.getCell(hu, 3 + i * 2), `${weekShort(w.label)} clicks`);
      headCell(ws.getCell(hu, 4 + i * 2), `${weekShort(w.label)} impr.`);
    });
    headCell(ws.getCell(hu, 3 + weeks.length * 2), "CTR (%)");
    headCell(ws.getCell(hu, 4 + weeks.length * 2), "Avg pos");
    row++;
    top.forEach((u, i) => {
      const band = i % 2 === 1;
      dataCell(ws.getCell(row, 1), u.langLabel || u.lang, null, { left: true, band });
      dataCell(ws.getCell(row, 2), u.url, null, { left: true, band });
      weeks.forEach((w, wi) => {
        const pw = u.weeks[wi] || {};
        dataCell(ws.getCell(row, 3 + wi * 2), pw.found ? pw.clicks : null, NUM, { band });
        dataCell(ws.getCell(row, 4 + wi * 2), pw.found ? pw.impressions : null, NUM, { band });
      });
      const lastPw = u.weeks[li] || {};
      dataCell(ws.getCell(row, 3 + weeks.length * 2), lastPw.found ? lastPw.ctr : null, PCT2, { band });
      dataCell(ws.getCell(row, 4 + weeks.length * 2), lastPw.found ? lastPw.position : null, POS1, { band });
      row++;
    });
  }

  // column widths
  ws.getColumn(1).width = 34;
  ws.getColumn(2).width = 46;
  for (let c = 3; c <= Math.max(cols, 4 + weeks.length * 2); c++) ws.getColumn(c).width = 12;

  // ====================== PER-LANGUAGE SHEETS ======================
  for (const sr of r.sitemapReports || []) {
    const label = sr.lang && sr.lang.label ? sr.lang.label : "Default";
    const name = sheetName(label, used);
    const lws = wb.addWorksheet(name, { views: [{ state: "frozen", ySplit: 0 }] });
    const lcols = 1 + weeks.length * 4;

    pageTitle(lws, `${label} — weekly search performance`,
      `${sr.sitemap}   ·   ${sr.urlCount.toLocaleString("en-US")} URLs in sitemap`, Math.max(lcols, 8));

    // weekly totals + deltas
    let lr = 4;
    sectionTitle(lws, lr, "Weekly totals", Math.max(lcols, 8));
    lr++;
    ["Week", "Dates", "URLs with data", "Clicks", "Δ clicks", "Impressions", "Δ impressions", "CTR (%)", "Avg pos"]
      .forEach((t, i) => headCell(lws.getCell(lr, i + 1), t));
    lr++;
    sr.weeks.forEach((wt, wi) => {
      const band = wi % 2 === 1;
      dataCell(lws.getCell(lr, 1), wt.label, null, { left: true, band });
      dataCell(lws.getCell(lr, 2), `${wt.startDate} → ${wt.endDate}`, null, { left: true, band });
      dataCell(lws.getCell(lr, 3), wt.matchedUrls, NUM, { band });
      dataCell(lws.getCell(lr, 4), wt.clicks, NUM, { band });
      if (wi === 0) dataCell(lws.getCell(lr, 5), "", null, { band });
      else {
        const d = wt.clicks - sr.weeks[wi - 1].clicks;
        fx(lws.getCell(lr, 5), `D${lr}-D${lr - 1}`, d, "+#,##0;-#,##0;0", { band, color: d > 0 ? GOOD : d < 0 ? BAD : undefined });
      }
      dataCell(lws.getCell(lr, 6), wt.impressions, NUM, { band });
      if (wi === 0) dataCell(lws.getCell(lr, 7), "", null, { band });
      else {
        const d = wt.impressions - sr.weeks[wi - 1].impressions;
        fx(lws.getCell(lr, 7), `F${lr}-F${lr - 1}`, d, "+#,##0;-#,##0;0", { band, color: d > 0 ? GOOD : d < 0 ? BAD : undefined });
      }
      fx(lws.getCell(lr, 8), `IFERROR(D${lr}/F${lr}*100,0)`, wt.ctr, PCT2, { band });
      dataCell(lws.getCell(lr, 9), wt.position, POS1, { band });
      lr++;
    });
    lr++;
    noteCell(lws, lr, "CTR = Clicks ÷ Impressions. Avg position is impressions-weighted. A blank cell in the URL table means the URL recorded no impressions that week.", Math.max(lcols, 8));
    lr += 2;

    // per-URL table
    const langUrls = urls.filter((u) => u.sitemap === sr.sitemap);
    sectionTitle(lws, lr, `URLs with Search Console data — ${langUrls.length.toLocaleString("en-US")} of ${sr.urlCount.toLocaleString("en-US")}`, Math.max(lcols, 8));
    lr++;
    const uh1 = lr, uh2 = lr + 1;
    lws.mergeCells(uh1, 1, uh2, 1); headCell(lws.getCell(uh1, 1), "URL");
    weeks.forEach((w, i) => {
      const c0 = 2 + i * 4;
      lws.mergeCells(uh1, c0, uh1, c0 + 3);
      headCell(lws.getCell(uh1, c0), w.label);
      ["Clicks", "Impr.", "CTR (%)", "Pos"].forEach((t, j) => headCell(lws.getCell(uh2, c0 + j), t));
    });
    lr = uh2 + 1;
    const urlFirstRow = lr;
    langUrls.forEach((u, i) => {
      const band = i % 2 === 1;
      dataCell(lws.getCell(lr, 1), u.url, null, { left: true, band });
      weeks.forEach((w, wi) => {
        const c0 = 2 + wi * 4;
        const pw = u.weeks[wi] || {};
        dataCell(lws.getCell(lr, c0), pw.found ? pw.clicks : null, NUM, { band });
        dataCell(lws.getCell(lr, c0 + 1), pw.found ? pw.impressions : null, NUM, { band });
        dataCell(lws.getCell(lr, c0 + 2), pw.found ? pw.ctr : null, PCT2, { band });
        dataCell(lws.getCell(lr, c0 + 3), pw.found ? pw.position : null, POS1, { band });
      });
      lr++;
    });
    if (langUrls.length) {
      lws.autoFilter = { from: { row: uh2, column: 1 }, to: { row: lr - 1, column: lcols } };
      lws.views = [{ state: "frozen", ySplit: uh2 }];
    }
    lws.getColumn(1).width = 64;
    for (let c = 2; c <= Math.max(lcols, 9); c++) lws.getColumn(c).width = 11;
    lws.getColumn(2).width = Math.max(lws.getColumn(2).width, 20);
  }

  return wb;
}

function smPath(u) {
  try { return new URL(u).pathname; } catch { return u; }
}
