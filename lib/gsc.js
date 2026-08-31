// lib/gsc.js
// Google Search Console OAuth + Search Analytics helpers.
// Pulls page-level totals (clicks, impressions, CTR, avg position) AND the
// per-query breakdown for a single page on a property you own.
//
// Required env vars (Vercel → Project → Settings → Environment Variables):
//   GOOGLE_OAUTH_CLIENT_ID
//   GOOGLE_OAUTH_CLIENT_SECRET
//   GOOGLE_OAUTH_REDIRECT_URI   e.g. https://ranking-analyser.vercel.app/api/auth/callback
//   OAUTH_STATE_SECRET          any long random string (CSRF state signing)

const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const SCOPE = "https://www.googleapis.com/auth/webmasters.readonly";

export function buildAuthUrl(state) {
  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_OAUTH_CLIENT_ID,
    redirect_uri: process.env.GOOGLE_OAUTH_REDIRECT_URI,
    response_type: "code",
    scope: SCOPE,
    access_type: "offline",
    prompt: "consent",
    state,
  });
  return `${AUTH_ENDPOINT}?${params.toString()}`;
}

export async function exchangeCodeForTokens(code) {
  const body = new URLSearchParams({
    code,
    client_id: process.env.GOOGLE_OAUTH_CLIENT_ID,
    client_secret: process.env.GOOGLE_OAUTH_CLIENT_SECRET,
    redirect_uri: process.env.GOOGLE_OAUTH_REDIRECT_URI,
    grant_type: "authorization_code",
  });
  const r = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!r.ok) throw new Error(`Token exchange failed: ${r.status} ${await r.text()}`);
  return r.json();
}

export async function refreshAccessToken(refreshToken) {
  const body = new URLSearchParams({
    refresh_token: refreshToken,
    client_id: process.env.GOOGLE_OAUTH_CLIENT_ID,
    client_secret: process.env.GOOGLE_OAUTH_CLIENT_SECRET,
    grant_type: "refresh_token",
  });
  const r = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!r.ok) throw new Error(`Token refresh failed: ${r.status} ${await r.text()}`);
  return r.json();
}

async function gscQuery(accessToken, siteUrl, body) {
  const u = `https://searchconsole.googleapis.com/webmasters/v3/sites/${encodeURIComponent(
    siteUrl
  )}/searchAnalytics/query`;
  const r = await fetch(u, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const text = await r.text();
    if (r.status === 403) {
      throw new Error(
        `GSC denied access to "${siteUrl}" (403). The connected account can only ` +
        `read properties it is verified on, and the identifier must match Search ` +
        `Console exactly — "sc-domain:example.com" for a Domain property, or the ` +
        `full URL-prefix including scheme and trailing slash. Call /api/gsc-sites ` +
        `to see the exact list. Raw: ${text}`
      );
    }
    throw new Error(`GSC query failed: ${r.status} ${text}`);
  }
  return r.json();
}

// GSC buckets data by calendar day in the property's timezone, which for the
// Search Analytics API is always America/Los_Angeles ("PT"). Computing "today"
// in UTC (old behaviour) shifted the window by up to a day and could never
// reproduce the numbers shown in the GSC UI.
const GSC_TZ = "America/Los_Angeles";
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

function todayInGscTz() {
  // en-CA locale formats as YYYY-MM-DD
  return new Intl.DateTimeFormat("en-CA", { timeZone: GSC_TZ }).format(new Date());
}

/**
 * Resolve an explicit or relative date window.
 * - Pass { startDate, endDate } (YYYY-MM-DD) to replicate a GSC UI custom range EXACTLY.
 * - Or pass { days } for "last N full days" ending today (PT). N days inclusive,
 *   matching how the GSC UI counts its presets.
 * Accepts a bare number for backwards compatibility (treated as { days }).
 * @returns {{startDate: string, endDate: string}}
 */
export function resolveDateRange(opts = {}) {
  if (typeof opts === "number") opts = { days: opts };
  const wantStart = ISO_DAY.test(opts.startDate || "") ? opts.startDate : null;
  const wantEnd = ISO_DAY.test(opts.endDate || "") ? opts.endDate : null;

  let endDate = wantEnd || todayInGscTz();
  let startDate;
  if (wantStart) {
    startDate = wantStart;
  } else {
    const days = Number.isFinite(opts.days) && opts.days > 0 ? Math.floor(opts.days) : 28;
    const end = new Date(endDate + "T00:00:00Z");
    startDate = new Date(end.getTime() - (days - 1) * 86400000).toISOString().slice(0, 10);
  }
  if (startDate > endDate) [startDate, endDate] = [endDate, startDate];
  return { startDate, endDate };
}

// Map common country inputs to the ISO 3166-1 alpha-3 codes GSC expects.
const COUNTRY_ALIASES = {
  us: "usa", uk: "gbr", gb: "gbr", in: "ind", ca: "can", au: "aus",
  de: "deu", fr: "fra", jp: "jpn", br: "bra", cn: "chn", es: "esp",
  it: "ita", nl: "nld", mx: "mex", kr: "kor", ru: "rus", sg: "sgp",
  ae: "are", za: "zaf", id: "idn", ph: "phl", pk: "pak", ng: "nga",
  "united states": "usa", "united kingdom": "gbr", "india": "ind",
};

/** Normalize a country input ("US", "usa", "United States") to alpha-3 or null. */
export function normalizeCountry(c) {
  const v = String(c || "").trim().toLowerCase();
  if (!v) return null;
  if (COUNTRY_ALIASES[v]) return COUNTRY_ALIASES[v];
  if (/^[a-z]{3}$/.test(v)) return v;
  return null;
}

/**
 * Build the shared query options every metrics call uses.
 * dataState "all" includes FRESH (not-yet-finalized) data — this is what the
 * GSC UI shows ("Last update: N hours ago"). Without it the API silently drops
 * the most recent ~2-3 days and totals can't match the UI.
 */
function buildQueryOpts(daysOrOpts) {
  const o = typeof daysOrOpts === "number" ? { days: daysOrOpts } : (daysOrOpts || {});
  const { startDate, endDate } = resolveDateRange(o);
  const filters = [];
  const country = normalizeCountry(o.country);
  if (country) filters.push({ dimension: "country", operator: "equals", expression: country });
  // optional page-URL scoping (used for per-language chunked runs)
  if (o.pageIncludingRegex) filters.push({ dimension: "page", operator: "includingRegex", expression: o.pageIncludingRegex });
  if (o.pageExcludingRegex) filters.push({ dimension: "page", operator: "excludingRegex", expression: o.pageExcludingRegex });
  if (o.pageContains) filters.push({ dimension: "page", operator: "contains", expression: o.pageContains });
  const type = ["web", "image", "video", "news", "discover", "googleNews"].includes(o.searchType)
    ? o.searchType : "web";
  return { startDate, endDate, type, dataState: o.dataState || "all", extraFilters: filters };
}

/**
 * Page-level TOTALS: clicks, impressions, ctr (%), avg position.
 * `daysOrOpts` may be a number (days) or { days, startDate, endDate, country, searchType }.
 */
export async function queryPageTotals(accessToken, siteUrl, pageUrl, daysOrOpts = 90) {
  const { startDate, endDate, type, dataState, extraFilters } = buildQueryOpts(daysOrOpts);
  const data = await gscQuery(accessToken, siteUrl, {
    startDate,
    endDate,
    type,
    dataState,
    dimensions: [], // no dimensions = one aggregate row for the filtered page
    dimensionFilterGroups: [
      { filters: [
        { dimension: "page", operator: "equals", expression: pageUrl },
        ...extraFilters,
      ] },
    ],
    rowLimit: 1,
  });
  const row = (data.rows || [])[0];
  if (!row) return { clicks: 0, impressions: 0, ctr: 0, position: 0, hasData: false };
  return {
    clicks: row.clicks || 0,
    impressions: row.impressions || 0,
    ctr: +((row.ctr || 0) * 100).toFixed(2),
    position: +(row.position || 0).toFixed(1),
    hasData: true,
  };
}

/** Per-QUERY rows for the page: query, clicks, impressions, ctr (%), position. */
export async function queryPagePerformance(accessToken, siteUrl, pageUrl, daysOrOpts = 90) {
  const { startDate, endDate, type, dataState, extraFilters } = buildQueryOpts(daysOrOpts);
  const data = await gscQuery(accessToken, siteUrl, {
    startDate,
    endDate,
    type,
    dataState,
    dimensions: ["query"],
    dimensionFilterGroups: [
      { filters: [
        { dimension: "page", operator: "equals", expression: pageUrl },
        ...extraFilters,
      ] },
    ],
    rowLimit: 1000,
  });
  return (data.rows || []).map((row) => ({
    query: row.keys[0],
    clicks: row.clicks || 0,
    impressions: row.impressions || 0,
    ctr: +((row.ctr || 0) * 100).toFixed(2),
    position: +(row.position || 0).toFixed(1),
  }));
}

/** Turn raw GSC query rows into quick-win findings. */
export function analyzeGsc(rows) {
  const findings = [];
  if (!rows || !rows.length)
    return [{ severity: "info", category: "GSC", message: "No GSC query rows in range." }];

  const striking = rows.filter((r) => r.position >= 5 && r.position <= 20);
  const lowCtr = rows.filter((r) => r.impressions >= 100 && r.ctr < 1.0);

  if (striking.length) {
    striking.sort((a, b) => b.impressions - a.impressions);
    findings.push({
      severity: "warning",
      category: "GSC Quick Wins",
      message: `${striking.length} queries rank position 5-20 — push these to page-1 top.`,
      detail: striking.slice(0, 8).map((r) => `${r.query} (pos ${r.position})`).join("; "),
    });
  }
  if (lowCtr.length) {
    lowCtr.sort((a, b) => b.impressions - a.impressions);
    findings.push({
      severity: "warning",
      category: "GSC CTR",
      message: `${lowCtr.length} queries get impressions but low CTR — rewrite title/meta.`,
      detail: lowCtr.slice(0, 8).map((r) => `${r.query} (${r.impressions} impr, ${r.ctr}% CTR)`).join("; "),
    });
  }
  if (!findings.length)
    findings.push({ severity: "info", category: "GSC", message: "No urgent quick-wins flagged." });
  return findings;
}

/**
 * Metrics for MANY pages in one query. Pulls page-dimension rows for the whole
 * property, returns a Map keyed by exact page URL → { clicks, impressions, ctr, position }.
 * Used to enrich internal-link suggestions with their real GSC standings.
 */
export async function queryManyPageMetrics(accessToken, siteUrl, daysOrOpts = 90) {
  const { startDate, endDate, type, dataState, extraFilters } = buildQueryOpts(daysOrOpts);
  const PAGE = 25000;   // API max per request
  const MAX_PAGES = 8;  // safety ceiling: 200k page rows
  const map = new Map();

  for (let p = 0; p < MAX_PAGES; p++) {
    const data = await gscQuery(accessToken, siteUrl, {
      startDate,
      endDate,
      type,
      dataState,
      dimensions: ["page"],
      ...(extraFilters.length ? { dimensionFilterGroups: [{ filters: extraFilters }] } : {}),
      rowLimit: PAGE,
      startRow: p * PAGE,
    });
    const rows = data.rows || [];
    for (const row of rows) {
      const url = row.keys[0];
      map.set(url, {
        clicks: row.clicks || 0,
        impressions: row.impressions || 0,
        ctr: +((row.ctr || 0) * 100).toFixed(2),
        position: +(row.position || 0).toFixed(1),
      });
    }
    if (rows.length < PAGE) break; // last page reached
  }
  return map;
}

/**
 * Normalize a URL for fuzzy matching between a user's CSV and GSC's stored page
 * URLs. Lowercases the host, drops a leading "www.", and removes trailing
 * slashes (root kept). Path casing and query string are preserved. This lets
 * "https://www.site.com/page/" match GSC's "https://site.com/page" form.
 * @param {string} u
 * @returns {string}
 */
export function normalizeForMatch(u) {
  const raw = String(u || "").trim();
  try {
    const x = new URL(raw);
    const host = x.hostname.toLowerCase().replace(/^www\./, "");
    const path = x.pathname.replace(/\/+$/, "") || "/";
    return host + path + (x.search || "");
  } catch {
    return raw.toLowerCase().replace(/\/+$/, "");
  }
}

/**
 * Build a normalized-URL lookup from the property-wide metrics Map so CSV URLs
 * can be matched even when their form differs slightly from GSC's.
 * @param {Map<string, object>} metricsMap from queryManyPageMetrics
 * @returns {Map<string, object>} keyed by normalizeForMatch(url)
 */
export function indexMetricsByNormalizedUrl(metricsMap) {
  const idx = new Map();
  for (const [url, m] of metricsMap.entries()) {
    idx.set(normalizeForMatch(url), m);
  }
  return idx;
}

/* ==================================================================== *
 * Property discovery — one token, every property the account can read
 * ====================================================================
 * A refresh token is issued to a Google ACCOUNT, not to a single site.
 * The webmasters.readonly scope this app already requests covers
 * sites.list plus searchAnalytics.query on every property that account is
 * verified on, so an existing token works across all of them with no
 * re-consent. The only thing that was site-specific was GSC_SITE_URL —
 * the helpers below replace that hard default with real discovery.
 */

const SITES_ENDPOINT = "https://searchconsole.googleapis.com/webmasters/v3/sites";

/**
 * List every Search Console property the token's account can see.
 * @returns {Promise<Array<{siteUrl:string, permissionLevel:string, type:string, canQuery:boolean}>>}
 */
export async function listSites(accessToken) {
  const r = await fetch(SITES_ENDPOINT, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!r.ok) throw new Error(`Site list failed: ${r.status} ${await r.text()}`);
  const data = await r.json();
  return (data.siteEntry || [])
    .map((s) => ({
      siteUrl: s.siteUrl,
      permissionLevel: s.permissionLevel,
      type: /^sc-domain:/i.test(s.siteUrl) ? "domain" : "url-prefix",
      // siteUnverifiedUser has the property listed but cannot read its data
      canQuery: s.permissionLevel !== "siteUnverifiedUser",
    }))
    .sort((a, b) => a.siteUrl.localeCompare(b.siteUrl));
}

/** Bare host for a property id or page URL: "https://www.x.com/fr/" -> "x.com" */
export function siteHost(idOrUrl) {
  const raw = String(idOrUrl || "").trim();
  if (!raw) return "";
  if (/^sc-domain:/i.test(raw)) return raw.slice(10).toLowerCase().replace(/^www\./, "");
  try {
    return new URL(raw).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return raw.toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0];
  }
}

/** Path prefix of a URL-prefix property ("/fr/"), or null for domain properties. */
function propertyPrefix(siteUrl) {
  if (/^sc-domain:/i.test(siteUrl)) return null;
  try {
    const p = new URL(siteUrl).pathname.replace(/\/+$/, "");
    return p ? p + "/" : "/";
  } catch {
    return null;
  }
}

/** Would this property hold data for this page URL? */
export function siteCoversUrl(site, pageUrl) {
  const sUrl = typeof site === "string" ? site : site.siteUrl;
  const host = siteHost(pageUrl);
  const shost = siteHost(sUrl);
  if (!host || !shost) return false;
  if (/^sc-domain:/i.test(sUrl)) {
    // a Domain property covers the apex and every subdomain
    return host === shost || host.endsWith("." + shost);
  }
  if (host !== shost) return false;
  const prefix = propertyPrefix(sUrl);
  if (!prefix || prefix === "/") return true;
  try {
    return (new URL(pageUrl).pathname.replace(/\/+$/, "") + "/").startsWith(prefix);
  } catch {
    return false;
  }
}

/**
 * Match a loosely-typed property against the account's real list.
 * Tolerates the usual mismatches: "example.com", missing scheme, missing or
 * extra "www.", a missing trailing slash, or a URL-prefix string typed for
 * what is actually a Domain property.
 */
export function resolveSiteUrl(requested, sites = []) {
  const want = String(requested || "").trim();
  if (!want) return { siteUrl: null, match: "none" };

  const exact = sites.find((s) => s.siteUrl === want);
  if (exact) return { siteUrl: exact.siteUrl, match: "exact", site: exact };

  const host = siteHost(want);
  const sameHost = sites.filter((s) => siteHost(s.siteUrl) === host);
  if (!sameHost.length) return { siteUrl: null, match: "unknown" };

  // Prefer a Domain property (broadest coverage), else the shortest prefix.
  const domain = sameHost.find((s) => s.type === "domain" && s.canQuery);
  const usable = sameHost.filter((s) => s.canQuery);
  const pick =
    domain || usable.slice().sort((a, b) => a.siteUrl.length - b.siteUrl.length)[0] || sameHost[0];

  return {
    siteUrl: pick.siteUrl,
    match: "host",
    site: pick,
    ...(sameHost.length > 1 ? { alternatives: sameHost.map((s) => s.siteUrl) } : {}),
  };
}

/**
 * Given a batch of page URLs, work out which property they belong to.
 * Scores every readable property by how many of the URLs it covers.
 */
export function pickSiteForUrls(urls = [], sites = []) {
  const sample = urls.filter(Boolean).slice(0, 500);
  if (!sample.length) return null;

  const scored = sites
    .filter((s) => s.canQuery)
    .map((s) => ({ site: s, hits: sample.filter((u) => siteCoversUrl(s, u)).length }))
    .filter((x) => x.hits > 0)
    .sort((a, b) =>
      b.hits - a.hits ||
      // tie-break: Domain property first (it aggregates www/non-www and http/https)
      (a.site.type === "domain" ? -1 : b.site.type === "domain" ? 1 : 0) ||
      a.site.siteUrl.length - b.site.siteUrl.length
    );

  if (!scored.length) return null;
  const best = scored[0];
  return {
    site: best.site,
    hits: best.hits,
    sampled: sample.length,
    coverage: +((best.hits / sample.length) * 100).toFixed(1),
    alternatives: scored.slice(1, 4).map((x) => x.site.siteUrl),
  };
}

/**
 * Decide which property a request should run against.
 * Order: explicit request → inferred from the URLs in the request →
 * server default → the account's only property.
 *
 * Inference deliberately outranks GSC_SITE_URL: when someone uploads a CSV of
 * another site's URLs, the data itself is a better signal than a server-wide
 * default, and the old behaviour returned zero matches for every row.
 */
export function resolveSiteForRequest({
  requested,
  envSite,
  sites = [],
  urls = [],
  autoDetect = true,
}) {
  const known = sites.length > 0;

  if (requested) {
    if (!known) return { siteUrl: requested, reason: "requested", verified: false };
    const r = resolveSiteUrl(requested, sites);
    if (r.siteUrl) {
      return {
        siteUrl: r.siteUrl,
        reason: r.match === "exact" ? "requested" : `requested "${requested}" matched to this property`,
        verified: true,
        site: r.site,
        ...(r.alternatives ? { alternatives: r.alternatives } : {}),
      };
    }
    return { siteUrl: null, reason: "no-access", requested };
  }

  if (autoDetect && known && urls.length) {
    const guess = pickSiteForUrls(urls, sites);
    if (guess) {
      return {
        siteUrl: guess.site.siteUrl,
        reason: `auto-detected from the URLs supplied (${guess.coverage}% of them live on this property)`,
        verified: true,
        site: guess.site,
        coverage: guess.coverage,
        ...(guess.alternatives.length ? { alternatives: guess.alternatives } : {}),
      };
    }
  }

  if (envSite) {
    if (!known) return { siteUrl: envSite, reason: "server default (GSC_SITE_URL)", verified: false };
    const r = resolveSiteUrl(envSite, sites);
    if (r.siteUrl) {
      return { siteUrl: r.siteUrl, reason: "server default (GSC_SITE_URL)", verified: true, site: r.site };
    }
  }

  const usable = sites.filter((s) => s.canQuery);
  if (usable.length === 1) {
    return {
      siteUrl: usable[0].siteUrl,
      reason: "the only property this account can read",
      verified: true,
      site: usable[0],
    };
  }

  return { siteUrl: null, reason: "ambiguous" };
}
