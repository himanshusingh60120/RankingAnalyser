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
  if (!r.ok) throw new Error(`GSC query failed: ${r.status} ${await r.text()}`);
  return r.json();
}

function dateRange(days) {
  const end = new Date();
  const start = new Date(Date.now() - days * 86400000);
  return { startDate: start.toISOString().slice(0, 10), endDate: end.toISOString().slice(0, 10) };
}

/** Page-level TOTALS: clicks, impressions, ctr (%), avg position. */
export async function queryPageTotals(accessToken, siteUrl, pageUrl, days = 90) {
  const { startDate, endDate } = dateRange(days);
  const data = await gscQuery(accessToken, siteUrl, {
    startDate,
    endDate,
    dimensions: [], // no dimensions = one aggregate row for the filtered page
    dimensionFilterGroups: [
      { filters: [{ dimension: "page", operator: "equals", expression: pageUrl }] },
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
export async function queryPagePerformance(accessToken, siteUrl, pageUrl, days = 90) {
  const { startDate, endDate } = dateRange(days);
  const data = await gscQuery(accessToken, siteUrl, {
    startDate,
    endDate,
    dimensions: ["query"],
    dimensionFilterGroups: [
      { filters: [{ dimension: "page", operator: "equals", expression: pageUrl }] },
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
export async function queryManyPageMetrics(accessToken, siteUrl, days = 90) {
  const { startDate, endDate } = dateRange(days);
  const data = await gscQuery(accessToken, siteUrl, {
    startDate,
    endDate,
    dimensions: ["page"],
    rowLimit: 25000,
  });
  const map = new Map();
  for (const row of data.rows || []) {
    const url = row.keys[0];
    map.set(url, {
      clicks: row.clicks || 0,
      impressions: row.impressions || 0,
      ctr: +((row.ctr || 0) * 100).toFixed(2),
      position: +(row.position || 0).toFixed(1),
    });
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
