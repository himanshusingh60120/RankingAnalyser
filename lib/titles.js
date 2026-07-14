// lib/titles.js
// Extract the real page <title> directly from a URL, so bulk CSVs don't need
// a (possibly stale or missing) Title column — the URL is enough.

import { fetchPage } from "./fetcher.js";

const ENTITIES = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  ndash: "\u2013", mdash: "\u2014", rsquo: "\u2019", lsquo: "\u2018",
  rdquo: "\u201d", ldquo: "\u201c", hellip: "\u2026", copy: "\u00a9",
  reg: "\u00ae", trade: "\u2122",
};

function decodeEntities(s) {
  return String(s)
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&([a-z]+);/gi, (m, name) => ENTITIES[name.toLowerCase()] ?? m);
}

function clean(s) {
  return decodeEntities(String(s).replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

/**
 * Pull the best available title out of raw HTML:
 * <title> → og:title → first <h1>. Returns null if none found.
 * @param {string} html
 * @returns {string|null}
 */
export function extractTitleFromHtml(html) {
  if (!html) return null;

  let m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (m) { const t = clean(m[1]); if (t) return t; }

  m =
    html.match(/<meta[^>]+property=["']og:title["'][^>]*content=["']([^"']*)["']/i) ||
    html.match(/<meta[^>]+content=["']([^"']*)["'][^>]*property=["']og:title["']/i);
  if (m) { const t = clean(m[1]); if (t) return t; }

  m = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  if (m) { const t = clean(m[1]); if (t) return t; }

  return null;
}

/**
 * Fetch a URL and extract its title.
 * @returns {Promise<{title: string|null, status: number, error?: string}>}
 */
export async function fetchTitle(url, { timeoutMs = 15000 } = {}) {
  const res = await fetchPage(url, { timeoutMs, retries: 1 });
  if (res.error) return { title: null, status: res.status, error: res.error };
  if (res.blocked) return { title: null, status: res.status, error: `blocked (${res.status})` };
  const title = extractTitleFromHtml(res.html);
  return { title, status: res.status };
}
