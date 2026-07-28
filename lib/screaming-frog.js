// lib/screaming-frog.js
// Parse a Screaming Frog SEO Spider export and classify each URL's index status
// WITHOUT any Search Console quota.
//
// Two signals:
//   • Crawl "Indexability" + "Indexability Status" — quota-free, covers every
//     crawled URL (Indexable / Non-Indexable: Noindex, Canonicalised, ...).
//   • If Screaming Frog is connected to the GSC URL Inspection API, the export
//     also carries a "Coverage" column = Google's actual verdict.
//
// Coverage present -> "gsc" basis; otherwise crawl "Indexability" -> "crawl".

import { parseCsv } from "./csv.js";
import { normalizeForMatch } from "./gsc.js";

const H = (s) => String(s || "").trim().toLowerCase();

/**
 * Parse a raw Screaming Frog CSV export.
 * @returns {{ basis: "gsc"|"crawl", entries: Array<object>, columns: object, error?: string }}
 */
export function parseScreamingFrogCsv(csvText) {
  const rows = parseCsv(csvText || "");
  if (!rows.length) return { basis: "crawl", entries: [], columns: {}, error: "Empty file." };

  let hi = 0;
  while (hi < rows.length && !rows[hi].some((c) => H(c))) hi++;
  const header = (rows[hi] || []).map(H);
  const eq = (...n) => header.findIndex((h) => n.includes(h));
  const incl = (...n) => header.findIndex((h) => n.some((x) => h.includes(x)));

  let iAddr = eq("address", "url");
  if (iAddr < 0) iAddr = incl("address");
  const iIndexability = eq("indexability");
  const iStatus = eq("indexability status");
  const iCode = eq("status code");
  const iCoverage = incl("coverage");
  if (iAddr < 0) return { basis: "crawl", entries: [], columns: {}, error: "No Address/URL column found. Export the Internal tab (or any export with an Address column)." };

  const basis = iCoverage >= 0 ? "gsc" : "crawl";
  const entries = [];
  for (let r = hi + 1; r < rows.length; r++) {
    const row = rows[r];
    const url = String(row[iAddr] || "").trim();
    if (!/^https?:\/\//i.test(url)) continue;
    entries.push({
      url,
      indexability: iIndexability >= 0 ? String(row[iIndexability] || "").trim() : "",
      indexabilityStatus: iStatus >= 0 ? String(row[iStatus] || "").trim() : "",
      statusCode: iCode >= 0 ? String(row[iCode] || "").trim() : "",
      coverage: iCoverage >= 0 ? String(row[iCoverage] || "").trim() : "",
    });
  }
  return { basis, entries, columns: { iAddr, iIndexability, iStatus, iCode, iCoverage } };
}

/** Classify one entry into { kind: "good"|"bad"|"unknown", label }. */
function classifySf(e, basis) {
  if (basis === "gsc" && e.coverage) {
    const c = e.coverage.toLowerCase();
    const bad = c.includes("not indexed") || c.includes("not on google") || c.includes("excluded");
    const good = !bad && (c.includes("indexed") || c.includes("on google"));
    return { kind: good ? "good" : bad ? "bad" : "unknown", label: e.coverage };
  }
  if (e.indexability) {
    const good = /^indexable$/i.test(e.indexability);
    return {
      kind: good ? "good" : "bad",
      label: good ? "Indexable" : (e.indexabilityStatus ? `Non-Indexable: ${e.indexabilityStatus}` : "Non-Indexable"),
    };
  }
  return { kind: "unknown", label: "Unknown" };
}

/**
 * Build exact + normalized lookup maps of url -> { kind, label }.
 * Accepts raw parsed entries (classify here) or a pre-classified compact map
 * { url: "kind|label" }.
 */
export function buildSfIndex({ entries, basis, compact }) {
  const exact = new Map();
  const norm = new Map();
  const put = (url, val) => {
    exact.set(url, val);
    const n = normalizeForMatch(url);
    if (!norm.has(n)) norm.set(n, val);
  };
  if (compact) {
    for (const [url, packed] of Object.entries(compact)) {
      const i = String(packed).indexOf("|");
      const kind = i >= 0 ? packed.slice(0, i) : "unknown";
      const label = i >= 0 ? packed.slice(i + 1) : String(packed);
      put(url, { kind, label });
    }
  } else {
    for (const e of entries || []) put(e.url, classifySf(e, basis));
  }
  return { exact, norm };
}

/** Meta for the workbook columns/section, driven by the data basis. */
export function sfIndexMeta(basis) {
  return basis === "gsc"
    ? { source: "screamingfrog-gsc", colHeader: "Index Status (GSC via Screaming Frog)",
        sectionTitle: "Index Status from Screaming Frog + Search Console (Google's verdict)",
        goodLabel: "Indexed", badLabel: "Not Indexed", missingLabel: "Not in Crawl",
        note: "Index status comes from Screaming Frog's connection to the Search Console URL Inspection API (Google's actual coverage state). URLs not present in the export are shown as Not in Crawl." }
    : { source: "screamingfrog-crawl", colHeader: "Indexability (Screaming Frog)",
        sectionTitle: "Indexability from Screaming Frog crawl (no quota)",
        goodLabel: "Indexable", badLabel: "Non-Indexable", missingLabel: "Not in Crawl",
        note: "Indexability is Screaming Frog's crawl assessment, not Google's live verdict: Indexable means the page is technically eligible (200, no noindex, self-canonical); Non-Indexable lists the blocking reason (Noindex, Canonicalised, Redirected, Client Error, Blocked by robots.txt). This covers every crawled URL with no API quota. URLs not present in the export are Not in Crawl." };
}
