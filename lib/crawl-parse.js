// lib/crawl-parse.js
// Normalizes Screaming Frog crawl rows into a compact index-status record the
// report can read. Works whether or not GSC URL Inspection was enabled in the
// crawl: if the "Coverage" column is present it carries Google's real verdict;
// otherwise Screaming Frog's own Indexability is used.
//
// Recognized column names (case-insensitive, trimmed):
//   Address                        -> url
//   Status Code                    -> statusCode
//   Indexability                   -> "Indexable" | "Non-Indexable"
//   Indexability Status            -> reason ("noindex", "Canonicalised", ...)
//   Coverage                       -> GSC verdict (URL Inspection), if present
//   (also accepts "Search Console Coverage" / "GSC Coverage")

import { normalizeForMatch } from "./gsc.js";

const pick = (row, names) => {
  for (const n of names) {
    const key = Object.keys(row).find((k) => k.trim().toLowerCase() === n);
    if (key != null && row[key] != null && String(row[key]).trim() !== "") return String(row[key]).trim();
  }
  return "";
};

const COVERAGE_INDEXED = /(^|[^t])\bindexed\b/i; // "…indexed" but not "not indexed"
function coverageIsIndexed(coverage) {
  const c = coverage.toLowerCase();
  if (!c) return null;
  if (c.includes("not indexed") || c.includes("not on google") || c.includes("excluded")) return false;
  if (c.includes("indexed") || c.includes("on google") || c.includes("submitted and indexed")) return true;
  return null;
}

/**
 * @param {Array<Object>} rows  parsed CSV rows (objects keyed by header)
 * @returns {Array<{url,norm,statusCode,indexability,indexabilityStatus,coverage,indexed,label}>}
 */
export function parseCrawlRows(rows) {
  const out = [];
  for (const row of rows) {
    const url = pick(row, ["address", "url"]);
    if (!/^https?:\/\//i.test(url)) continue;
    const statusCode = pick(row, ["status code", "status"]);
    const indexability = pick(row, ["indexability"]);
    const indexabilityStatus = pick(row, ["indexability status", "indexability_status"]);
    const coverage = pick(row, ["coverage", "search console coverage", "gsc coverage"]);

    // Decide indexed + a human label. Prefer GSC coverage when present.
    let indexed = null, label = "";
    const cov = coverageIsIndexed(coverage);
    if (cov !== null) {
      indexed = cov;
      label = coverage;
    } else if (indexability) {
      indexed = /^indexable$/i.test(indexability);
      label = indexed ? "Indexable" : (indexabilityStatus ? `Non-Indexable: ${indexabilityStatus}` : "Non-Indexable");
    } else {
      label = "Unknown";
    }

    out.push({
      url, norm: normalizeForMatch(url),
      statusCode, indexability, indexabilityStatus, coverage,
      indexed, label,
    });
  }
  return out;
}
