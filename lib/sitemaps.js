// lib/sitemaps.js
// Fetch + parse XML sitemaps (both <sitemapindex> and <urlset>), and infer the
// hreflang / language a sitemap or page URL belongs to. Used by the weekly
// hreflang report: the sitemap index is the source of truth for which language
// versions exist, and each child sitemap's URLs are matched against GSC data.

import * as cheerio from "cheerio";
import { fetchPage } from "./fetcher.js";

// Language codes we recognize in sitemap filenames and URL path segments.
// Two-letter ISO 639-1 plus a few common regional forms.
const LANG_CODES = new Set([
  "en","ja","jp","ko","kr","de","fr","es","it","pt","nl","pl","ru","tr","ar",
  "zh","cn","tw","hi","id","th","vi","sv","no","da","fi","cs","el","he","hu",
  "ro","uk","ms","bn","fa","ur","ta","te","ml","mr",
]);
const LANG_NAMES = {
  en: "English", ja: "Japanese", jp: "Japanese", ko: "Korean", kr: "Korean",
  de: "German", fr: "French", es: "Spanish", it: "Italian", pt: "Portuguese",
  nl: "Dutch", pl: "Polish", ru: "Russian", tr: "Turkish", ar: "Arabic",
  zh: "Chinese", cn: "Chinese", tw: "Chinese (TW)", hi: "Hindi",
  id: "Indonesian", th: "Thai", vi: "Vietnamese", sv: "Swedish",
  no: "Norwegian", da: "Danish", fi: "Finnish", cs: "Czech", el: "Greek",
  he: "Hebrew", hu: "Hungarian", ro: "Romanian", uk: "Ukrainian",
  ms: "Malay", bn: "Bengali", fa: "Persian", ur: "Urdu", ta: "Tamil",
  te: "Telugu", ml: "Malayalam", mr: "Marathi",
};

/**
 * Guess the hreflang/language of a URL (sitemap or page).
 * Checks: filename tokens (sitemap-ja.xml, ja_sitemap.xml, sitemap_fr-1.xml)
 * and the first path segment (/ja/report/...). Falls back to "x-default".
 * @param {string} url
 * @returns {{ code: string, label: string }}
 */
export function detectLang(url) {
  try {
    const u = new URL(url);
    const segs = u.pathname.split("/").filter(Boolean);

    // first path segment: /ja/..., /pt-br/...
    if (segs.length) {
      const first = segs[0].toLowerCase();
      const base = first.split("-")[0];
      if (LANG_CODES.has(first) || (LANG_CODES.has(base) && /^[a-z]{2}-[a-z]{2}$/.test(first))) {
        const code = LANG_CODES.has(first) ? first : base;
        return { code: first, label: LANG_NAMES[code] || first };
      }
    }
    // filename tokens: sitemap-ja.xml, ja-sitemap.xml, sitemap_fr_2.xml
    const file = (segs[segs.length - 1] || "").toLowerCase().replace(/\.(xml|gz)$/g, "");
    for (const tok of file.split(/[-_.]/)) {
      if (LANG_CODES.has(tok)) return { code: tok, label: LANG_NAMES[tok] || tok };
    }
  } catch { /* fall through */ }
  return { code: "x-default", label: "Default / English" };
}

/**
 * Fetch and parse one sitemap URL.
 * @returns {Promise<{
 *   ok: boolean, status: number, kind: "index"|"urlset"|"unknown",
 *   sitemaps: Array<{loc: string, lastmod: string|null}>,
 *   urls: Array<{loc: string, lastmod: string|null}>,
 *   error?: string
 * }>}
 */
export async function fetchSitemap(url) {
  const res = await fetchPage(url, { timeoutMs: 25000, retries: 2 });
  if (!res.html || res.status >= 400 || res.status === 0) {
    return {
      ok: false, status: res.status, kind: "unknown", sitemaps: [], urls: [],
      error: res.error || (res.blocked ? `Blocked (HTTP ${res.status})` : `HTTP ${res.status}`),
    };
  }
  return { status: res.status, ...parseSitemapXml(res.html) };
}

/**
 * Parse raw sitemap XML text. Pure function (exported for tests).
 * @param {string} xml
 */
export function parseSitemapXml(xml) {
  try {
    const $ = cheerio.load(xml, { xmlMode: true });
    const sitemaps = [];
    const urls = [];
    $("sitemapindex > sitemap").each((_, el) => {
      const loc = $(el).find("loc").first().text().trim();
      if (loc) sitemaps.push({ loc, lastmod: $(el).find("lastmod").first().text().trim() || null });
    });
    $("urlset > url").each((_, el) => {
      const loc = $(el).find("loc").first().text().trim();
      if (loc) urls.push({ loc, lastmod: $(el).find("lastmod").first().text().trim() || null });
    });
    // Some generators skip the wrapper element names — fall back to bare tags.
    if (!sitemaps.length && !urls.length) {
      $("sitemap").each((_, el) => {
        const loc = $(el).find("loc").first().text().trim();
        if (loc) sitemaps.push({ loc, lastmod: null });
      });
      if (!sitemaps.length) $("url").each((_, el) => {
        const loc = $(el).find("loc").first().text().trim();
        if (loc) urls.push({ loc, lastmod: null });
      });
    }
    const kind = sitemaps.length ? "index" : urls.length ? "urlset" : "unknown";
    return { ok: kind !== "unknown", kind, sitemaps, urls,
             ...(kind === "unknown" ? { error: "No <sitemap> or <url> entries found." } : {}) };
  } catch (e) {
    return { ok: false, kind: "unknown", sitemaps: [], urls: [],
             error: `XML parse failed: ${String(e.message || e)}` };
  }
}

/**
 * Collect every page URL from a list of sitemap URLs. If an entry turns out to
 * be a nested index, recurse ONE level into its children.
 * @param {string[]} sitemapUrls
 * @param {{maxUrls?: number, maxChildren?: number}} opts
 * @returns {Promise<{ perSitemap: Array<{sitemap:string, lang:object, urls:string[], error?:string}>, truncated: boolean }>}
 */
export async function collectSitemapUrls(sitemapUrls, { maxUrls = 60000, maxChildren = 60 } = {}) {
  const perSitemap = [];
  let total = 0;
  let truncated = false;

  for (const smUrl of sitemapUrls) {
    const entry = { sitemap: smUrl, lang: detectLang(smUrl), urls: [] };
    if (total >= maxUrls) { truncated = true; entry.error = "Skipped — URL cap reached."; perSitemap.push(entry); continue; }

    const parsed = await fetchSitemap(smUrl);
    if (!parsed.ok) { entry.error = parsed.error || "Fetch failed."; perSitemap.push(entry); continue; }

    if (parsed.kind === "urlset") {
      for (const u of parsed.urls) {
        if (total >= maxUrls) { truncated = true; break; }
        entry.urls.push(u.loc); total++;
      }
    } else {
      // nested index — pull each child urlset (one level deep)
      const children = parsed.sitemaps.slice(0, maxChildren);
      if (parsed.sitemaps.length > maxChildren) entry.error = `Nested index: only first ${maxChildren} children read.`;
      for (const child of children) {
        if (total >= maxUrls) { truncated = true; break; }
        const cp = await fetchSitemap(child.loc);
        if (!cp.ok || cp.kind !== "urlset") continue;
        for (const u of cp.urls) {
          if (total >= maxUrls) { truncated = true; break; }
          entry.urls.push(u.loc); total++;
        }
      }
    }
    perSitemap.push(entry);
  }
  return { perSitemap, truncated };
}
