// lib/csv.js
// Tiny dependency-free CSV reader/writer.
// Handles quoted fields, embedded commas/quotes/newlines, BOM, and CRLF.

/**
 * Parse CSV text into an array of rows, each row an array of string cells.
 * @param {string} text
 * @returns {string[][]}
 */
export function parseCsv(text) {
  if (text == null) return [];
  let s = String(text);
  if (s.charCodeAt(0) === 0xfeff) s = s.slice(1); // strip BOM

  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < s.length; i++) {
    const c = s[i];

    if (inQuotes) {
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i++; } // escaped quote ""
        else inQuotes = false;
      } else {
        field += c;
      }
      continue;
    }

    if (c === '"') { inQuotes = true; continue; }
    if (c === ",") { row.push(field); field = ""; continue; }
    if (c === "\r") { continue; } // handled with \n below / ignore lone CR
    if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; continue; }
    field += c;
  }
  // flush last field/row (unless file ended on a clean newline with nothing after)
  if (field.length || row.length) { row.push(field); rows.push(row); }

  // drop fully-empty trailing rows
  return rows.filter((r) => !(r.length === 1 && r[0].trim() === ""));
}

function escapeCell(v) {
  const s = v == null ? "" : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * Serialize rows (array of arrays) back to CSV text with CRLF line endings.
 * @param {Array<Array<string|number>>} rows
 * @returns {string}
 */
export function toCsv(rows) {
  return rows.map((r) => r.map(escapeCell).join(",")).join("\r\n");
}

/**
 * Extract {title, url} pairs from a parsed CSV where col A = Title, col B = URL.
 * Auto-skips a header row: if the first row's column B is not an http(s) URL,
 * it is treated as a header and dropped.
 * @param {string} text raw CSV
 * @returns {{ rows: Array<{title:string,url:string,line:number}>, skippedHeader: boolean }}
 */
export function parseTitleUrlCsv(text) {
  const grid = parseCsv(text);
  if (!grid.length) return { rows: [], skippedHeader: false };

  const isUrl = (v) => /^https?:\/\//i.test(String(v || "").trim());
  let start = 0;
  let skippedHeader = false;
  // header detection: first row col B isn't a URL -> header line
  if (!isUrl(grid[0][1])) { start = 1; skippedHeader = true; }

  const rows = [];
  for (let i = start; i < grid.length; i++) {
    const cells = grid[i];
    const title = (cells[0] || "").trim();
    const url = (cells[1] || "").trim();
    if (!title && !url) continue; // blank line
    rows.push({ title, url, line: i + 1 });
  }
  return { rows, skippedHeader };
}
