// apps-script/Code.gs
// Ranking X-Ray — Google Drive storage + weekly rank tracking.
// Paste this into the tracking Google Sheet: Extensions → Apps Script.
// It runs as YOUR Google account. That's what lets the tool write: Google's APIs need a signed-in
// identity to create files, even in folders shared "anyone with the link can edit".
//
// One-time setup: select "setup" → Run → allow access.
// Then Deploy → New deployment → Web app → Execute as: Me · Who has access: Anyone → copy the /exec URL.
// If you edit this file later: Deploy → Manage deployments → Edit → Version: New version → Deploy.

const FOLDER_ID = "1jVJCtd3vS3mZnmcqSPt3XOOLovFsQR7R";
const SHEET_ID = "1sJpeW6n07ELufCXTxxuADbXdXt6bq8a696hTWcMBrOo";
const APP_URL = "https://ranking-analyser.vercel.app";
const TZ = "Asia/Kolkata";

const BRIEFS = "Briefs";
const RANKS = "Rank history";
const TRACKED = ["MarketsandMarkets", "MRFR", "Precedence Research", "Future Market Insights", "Fortune Business Insights"];

const BRIEF_HEADERS = [
  "Brief ID", "Created (IST)", "Keyword", "Country", "Country code", "Page type",
  "Your page URL", "Your rank at brief", "Latest rank", "Change", "Last rank check",
  "Track ranks", "Status", "Analyst", "Due date",
  "Brief (Google Doc)", "Open in tool", "Data (JSON)", "Existing pages", "Notes",
];
const RANK_HEADERS = ["Checked (IST)", "Brief ID", "Keyword", "Country", "Your rank", "Your ranking URL"]
  .concat(TRACKED, ["#1 result"]);

/* ---------------- menu & setup ---------------- */

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu("Ranking X-Ray")
    .addItem("Set up / repair sheet", "setup")
    .addItem("Check ranks now", "checkRanksNow")
    .addToUi();
}

function setup() {
  const props = PropertiesService.getScriptProperties();
  if (!props.getProperty("SECRET")) props.setProperty("SECRET", Utilities.getUuid().replace(/-/g, ""));

  const book = ss_();
  book.setSpreadsheetTimeZone(TZ);
  const b = ensureSheet_(BRIEFS, BRIEF_HEADERS);
  const r = ensureSheet_(RANKS, RANK_HEADERS);

  styleSheet_(b, ["Created (IST)", "Last rank check"], {
    "Brief ID": 150, "Created (IST)": 140, "Keyword": 230, "Country": 130, "Country code": 90, "Page type": 90,
    "Your page URL": 230, "Your rank at brief": 110, "Latest rank": 100, "Change": 120, "Last rank check": 140,
    "Track ranks": 95, "Status": 110, "Analyst": 130, "Due date": 110,
    "Brief (Google Doc)": 230, "Open in tool": 230, "Data (JSON)": 160, "Existing pages": 300, "Notes": 260,
  });
  styleSheet_(r, ["Checked (IST)"], {
    "Checked (IST)": 140, "Brief ID": 150, "Keyword": 230, "Country": 130, "Your rank": 90, "Your ranking URL": 280,
    "#1 result": 320,
  });

  const m = headerMap_(b);
  const rows = Math.max(1, b.getMaxRows() - 1);
  b.getRange(2, m["Track ranks"] + 1, rows)
    .setDataValidation(SpreadsheetApp.newDataValidation().requireValueInList(["Yes", "No"], true).build());
  b.getRange(2, m["Status"] + 1, rows)
    .setDataValidation(SpreadsheetApp.newDataValidation()
      .requireValueInList(["Brief ready", "Writing", "In review", "Published", "On hold"], true).build());
  b.getRange(2, m["Due date"] + 1, rows).setNumberFormat("dd-mmm-yyyy");

  const changeRange = b.getRange(2, m["Change"] + 1, rows);
  b.setConditionalFormatRules([
    SpreadsheetApp.newConditionalFormatRule().whenTextStartsWith("▲").setFontColor("#0f7a5c").setBold(true).setRanges([changeRange]).build(),
    SpreadsheetApp.newConditionalFormatRule().whenTextStartsWith("▼").setFontColor("#b23b2e").setBold(true).setRanges([changeRange]).build(),
  ]);

  if (!ScriptApp.getProjectTriggers().some((t) => t.getHandlerFunction() === "weeklyRankCheck")) {
    ScriptApp.newTrigger("weeklyRankCheck").timeBased().onWeekDay(ScriptApp.WeekDay.MONDAY).atHour(9).create();
  }
  DriveApp.getFolderById(FOLDER_ID); // confirms Drive folder access during authorisation

  const msg = "Setup complete.\n\nCopy this value into Vercel as STORAGE_SECRET:\n\n" + props.getProperty("SECRET");
  try { SpreadsheetApp.getUi().alert(msg); } catch (e) { Logger.log(msg); }
}

/* ---------------- web app (called by the tool) ---------------- */

function doGet() {
  return out_({ ok: true, service: "ranking-xray-storage" });
}

function doPost(e) {
  try {
    const body = JSON.parse((e && e.postData && e.postData.contents) || "{}");
    const want = PropertiesService.getScriptProperties().getProperty("SECRET");
    if (!want || body.secret !== want) {
      return out_({ error: "Unauthorized — STORAGE_SECRET in Vercel doesn't match. Run 'setup' and copy the secret again." });
    }
    if (body.action === "save") return out_(saveBrief_(body));
    if (body.action === "list") return out_(listBriefs_(Number(body.limit) || 50));
    if (body.action === "get") return out_(getBrief_(body.id));
    return out_({ error: "Unknown action" });
  } catch (err) {
    return out_({ error: String((err && err.message) || err) });
  }
}

function saveBrief_(b) {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const m = b.meta || {};
    const now = new Date();
    const id = "KB-" + Utilities.formatDate(now, TZ, "yyMMdd-HHmm") + "-" + Math.random().toString(36).slice(2, 6).toUpperCase();
    const folder = monthFolder_(DriveApp.getFolderById(FOLDER_ID), now);
    const name = Utilities.formatDate(now, TZ, "yyyy-MM-dd") + " · " + (m.keyword || "brief") + " · " +
      String(m.gl || "").toUpperCase() + " · " + id;

    const jsonFile = folder.createFile(name + ".json", JSON.stringify(b.brief || {}), "application/json");
    let docUrl = "";
    try {
      docUrl = createDoc_(folder.getId(), name, b.html || "<p>(empty)</p>");
    } catch (e) {
      docUrl = folder.createFile(name + ".html", b.html || "", MimeType.HTML).getUrl();
    }
    const openUrl = String(b.appUrl || APP_URL).replace(/\/$/, "") + "/brief?id=" + encodeURIComponent(id);
    const rank = m.ourRank ? Number(m.ourRank) : "Not in top 20";

    appendByHeader_(ensureSheet_(BRIEFS, BRIEF_HEADERS), {
      "Brief ID": id, "Created (IST)": now, "Keyword": m.keyword || "", "Country": m.country || "",
      "Country code": m.gl || "", "Page type": m.contentType || "", "Your page URL": m.ourUrl || "",
      "Your rank at brief": rank, "Latest rank": rank, "Change": "—", "Last rank check": now,
      "Track ranks": "Yes", "Status": "Brief ready",
      "Brief (Google Doc)": docUrl, "Open in tool": openUrl, "Data (JSON)": jsonFile.getUrl(),
      "Existing pages": m.dupes || "",
    });
    return { ok: true, id: id, docUrl: docUrl, openUrl: openUrl, jsonUrl: jsonFile.getUrl(), sheetUrl: ss_().getUrl() };
  } finally {
    lock.releaseLock();
  }
}

function listBriefs_(limit) {
  const sh = ensureSheet_(BRIEFS, BRIEF_HEADERS);
  const last = sh.getLastRow();
  if (last < 2) return { ok: true, briefs: [], sheetUrl: ss_().getUrl() };
  const vals = sh.getRange(1, 1, last, sh.getLastColumn()).getValues();
  const H = vals[0];
  const rows = vals.slice(1).map((r) => {
    const o = {};
    H.forEach((h, i) => { o[h] = r[i] instanceof Date ? r[i].toISOString() : r[i]; });
    return o;
  }).filter((o) => o["Brief ID"]);
  return { ok: true, briefs: rows.reverse().slice(0, limit), sheetUrl: ss_().getUrl() };
}

function getBrief_(id) {
  if (!id) return { error: "Missing id" };
  const row = listBriefs_(100000).briefs.find((r) => r["Brief ID"] === id);
  if (!row) return { error: "Brief not found: " + id };
  const fid = fileIdFromUrl_(row["Data (JSON)"]);
  if (!fid) return { error: "This brief has no data file." };
  const brief = JSON.parse(DriveApp.getFileById(fid).getBlob().getDataAsString());
  return { ok: true, id: id, row: row, brief: brief };
}

// Converts the brief's HTML into a real Google Doc inside the folder.
function createDoc_(folderId, name, html) {
  const boundary = "rankxray" + Date.now();
  const page = /<html/i.test(html) ? html : "<html><head><meta charset='utf-8'></head><body>" + html + "</body></html>";
  const meta = { name: name, mimeType: "application/vnd.google-apps.document", parents: [folderId] };
  const payload =
    "--" + boundary + "\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n" + JSON.stringify(meta) +
    "\r\n--" + boundary + "\r\nContent-Type: text/html; charset=UTF-8\r\n\r\n" + page +
    "\r\n--" + boundary + "--";
  const res = UrlFetchApp.fetch(
    "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,webViewLink",
    {
      method: "post",
      contentType: "multipart/related; boundary=" + boundary,
      payload: Utilities.newBlob(payload).getBytes(),
      headers: { Authorization: "Bearer " + ScriptApp.getOAuthToken() },
      muteHttpExceptions: true,
    }
  );
  if (res.getResponseCode() >= 300) throw new Error("Doc creation failed: " + res.getContentText().slice(0, 200));
  return JSON.parse(res.getContentText()).webViewLink;
}

/* ---------------- weekly rank tracking ---------------- */

function weeklyRankCheck() {
  runRankCheck_();
}

function checkRanksNow() {
  const n = runRankCheck_();
  try { ss_().toast("Checked " + n + " brief(s).", "Ranking X-Ray"); } catch (e) { /* not in sheet UI */ }
}

function runRankCheck_() {
  const secret = PropertiesService.getScriptProperties().getProperty("SECRET");
  const sh = ensureSheet_(BRIEFS, BRIEF_HEADERS);
  const rk = ensureSheet_(RANKS, RANK_HEADERS);
  const last = sh.getLastRow();
  if (last < 2) return 0;
  const vals = sh.getRange(1, 1, last, sh.getLastColumn()).getValues();
  const m = {};
  vals[0].forEach((h, i) => { m[h] = i; });

  const cache = {};
  const started = Date.now();
  let checked = 0;
  for (let i = 1; i < vals.length; i++) {
    if (Date.now() - started > 5 * 60 * 1000) break; // Apps Script runs are capped at 6 minutes
    const row = vals[i];
    if (String(row[m["Track ranks"]]).trim().toLowerCase() !== "yes") continue;
    const kw = String(row[m["Keyword"]] || "").trim();
    const gl = String(row[m["Country code"]] || "us").trim() || "us";
    if (!kw) continue;

    const key = kw.toLowerCase() + "|" + gl;
    if (!cache[key]) {
      const res = UrlFetchApp.fetch(APP_URL + "/api/brief", {
        method: "post",
        contentType: "application/json",
        muteHttpExceptions: true,
        payload: JSON.stringify({ stage: "ranks", secret: secret, keyword: kw, gl: gl }),
      });
      try { cache[key] = JSON.parse(res.getContentText()); } catch (e) { cache[key] = { error: "Bad response" }; }
    }
    const r = cache[key];
    if (!r || r.error) continue;

    const now = new Date();
    const pos = r.ourPosition ? Number(r.ourPosition) : "Not in top 20";
    const competitorRanks = {};
    TRACKED.forEach((n) => { competitorRanks[n] = r.tracked && r.tracked[n] ? Number(r.tracked[n]) : "—"; });
    appendByHeader_(rk, Object.assign({
      "Checked (IST)": now, "Brief ID": row[m["Brief ID"]], "Keyword": kw, "Country": row[m["Country"]],
      "Your rank": pos, "Your ranking URL": r.ourUrl || "", "#1 result": r.top1 || "",
    }, competitorRanks));

    sh.getRange(i + 1, m["Latest rank"] + 1).setValue(pos);
    sh.getRange(i + 1, m["Change"] + 1).setValue(changeText_(row[m["Your rank at brief"]], pos));
    sh.getRange(i + 1, m["Last rank check"] + 1).setValue(now);
    checked++;
  }
  return checked;
}

function changeText_(before, now) {
  const b = Number(before) || 0;
  const n = Number(now) || 0;
  if (!b && !n) return "—";
  if (!b) return "▲ New: #" + n;
  if (!n) return "▼ Left top 20";
  const d = b - n;
  return d > 0 ? "▲ " + d : d < 0 ? "▼ " + (-d) : "No change";
}

/* ---------------- helpers ---------------- */

function ss_() {
  return SpreadsheetApp.openById(SHEET_ID);
}

function out_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}

function ensureSheet_(name, headers) {
  const book = ss_();
  let sh = book.getSheetByName(name);
  if (!sh) {
    const blank = book.getSheets().find((s) => s.getLastRow() === 0 && /^sheet\s?1$/i.test(s.getName()));
    sh = blank && name === BRIEFS ? blank.setName(name) : book.insertSheet(name);
  }
  const lastCol = sh.getLastColumn();
  const current = lastCol ? sh.getRange(1, 1, 1, lastCol).getValues()[0] : [];
  if (!current.length || !current[0]) {
    sh.getRange(1, 1, 1, headers.length).setValues([headers]);
  } else {
    const missing = headers.filter((h) => current.indexOf(h) === -1);
    if (missing.length) sh.getRange(1, current.length + 1, 1, missing.length).setValues([missing]);
  }
  return sh;
}

function headerMap_(sh) {
  const h = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  const m = {};
  h.forEach((name, i) => { m[name] = i; });
  return m;
}

function appendByHeader_(sh, obj) {
  const m = headerMap_(sh);
  const row = new Array(sh.getLastColumn()).fill("");
  Object.keys(obj).forEach((k) => { if (m[k] !== undefined) row[m[k]] = obj[k]; });
  sh.appendRow(row);
}

function styleSheet_(sh, dateCols, widths) {
  const lastCol = sh.getLastColumn();
  sh.setFrozenRows(1);
  sh.getRange(1, 1, 1, lastCol)
    .setFontWeight("bold").setBackground("#0f7a5c").setFontColor("#ffffff")
    .setWrap(true).setVerticalAlignment("middle");
  sh.setRowHeight(1, 36);
  const m = headerMap_(sh);
  const rows = Math.max(1, sh.getMaxRows() - 1);
  dateCols.forEach((n) => { if (m[n] !== undefined) sh.getRange(2, m[n] + 1, rows).setNumberFormat("dd-mmm-yyyy hh:mm"); });
  Object.keys(widths).forEach((n) => { if (m[n] !== undefined) sh.setColumnWidth(m[n] + 1, widths[n]); });
}

function monthFolder_(parent, now) {
  const name = Utilities.formatDate(now, TZ, "yyyy-MM");
  const it = parent.getFoldersByName(name);
  return it.hasNext() ? it.next() : parent.createFolder(name);
}

function fileIdFromUrl_(u) {
  const s = String(u || "");
  const m = s.match(/\/d\/([a-zA-Z0-9_-]+)/) || s.match(/[?&]id=([a-zA-Z0-9_-]+)/);
  return m ? m[1] : null;
}
