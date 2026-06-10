// lib/gsc.js
// Google Search Console OAuth + Search Analytics query helpers.
// Uses the OAuth 2.0 web-server flow. No SDK needed — plain fetch calls.
//
// Required env vars (set in Vercel project settings):
//   GOOGLE_OAUTH_CLIENT_ID
//   GOOGLE_OAUTH_CLIENT_SECRET
//   GOOGLE_OAUTH_REDIRECT_URI   e.g. https://<app>.vercel.app/api/auth/callback
//   OAUTH_STATE_SECRET          any random string (CSRF state signing)
//
// Token handling: the access token + refresh token are returned to the caller
// (the browser) after callback. For an API-only service the simplest robust
// pattern is to hand the refresh_token back once and let the caller store it,
// then pass it to /api/analyze as `gscRefreshToken`. We never persist it
// server-side (Vercel functions are stateless; /tmp is ephemeral).

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
  return r.json(); // { access_token, refresh_token, expires_in, ... }
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
  if (!r.ok) throw new Error(`Token refresh failed: ${r.status}`);
  return r.json(); // { access_token, expires_in, ... }
}

/**
 * Query Search Analytics for a single page, grouped by query.
 * @param accessToken bearer token
 * @param siteUrl     property URL, e.g. "https://www.kingsresearch.com/"
 * @param pageUrl     exact page to filter on
 */
export async function queryPagePerformance(accessToken, siteUrl, pageUrl, days = 90) {
  const end = new Date();
  const start = new Date(Date.now() - days * 86400000);
  const body = {
    startDate: start.toISOString().slice(0, 10),
    endDate: end.toISOString().slice(0, 10),
    dimensions: ["query"],
    dimensionFilterGroups: [
      { filters: [{ dimension: "page", operator: "equals", expression: pageUrl }] },
    ],
    rowLimit: 1000,
  };
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
  const data = await r.json();
  return (data.rows || []).map((row) => ({
    query: row.keys[0],
    clicks: row.clicks || 0,
    impressions: row.impressions || 0,
    ctr: +((row.ctr || 0) * 100).toFixed(2),
    position: +(row.position || 0).toFixed(1),
  }));
}

/** Turn raw GSC rows into quick-win findings. */
export function analyzeGsc(rows) {
  const findings = [];
  if (!rows || !rows.length)
    return [{ severity: "info", category: "GSC", message: "No GSC rows in range." }];

  const striking = rows.filter((r) => r.position >= 5 && r.position <= 20);
  const lowCtr = rows.filter((r) => r.impressions >= 100 && r.ctr < 1.0);

  if (striking.length) {
    striking.sort((a, b) => b.impressions - a.impressions);
    findings.push({
      severity: "warning",
      category: "GSC Quick Wins",
      message: `${striking.length} queries rank position 5-20 — push these to page-1 top.`,
      detail: striking
        .slice(0, 8)
        .map((r) => `${r.query} (pos ${r.position})`)
        .join("; "),
    });
  }
  if (lowCtr.length) {
    lowCtr.sort((a, b) => b.impressions - a.impressions);
    findings.push({
      severity: "warning",
      category: "GSC CTR",
      message: `${lowCtr.length} queries get impressions but low CTR — rewrite title/meta.`,
      detail: lowCtr
        .slice(0, 8)
        .map((r) => `${r.query} (${r.impressions} impr, ${r.ctr}% CTR)`)
        .join("; "),
    });
  }
  if (!findings.length)
    findings.push({ severity: "info", category: "GSC", message: "No urgent quick-wins flagged." });
  return findings;
}
