// api/gsc-sites.js
// GET  /api/gsc-sites            — uses the server's GSC_REFRESH_TOKEN
// GET  /api/gsc-sites?token=...  — uses a supplied refresh token
// POST /api/gsc-sites  { "gscRefreshToken": "..." }
//
// Lists every Search Console property the connected Google account can read.
// The refresh token belongs to the account, not to one site: the
// webmasters.readonly scope already grants sites.list + searchAnalytics.query
// on every property that account is verified on. Nothing needs re-authorising.
//
// Response:
//   {
//     "account": "hsingh@example.com" | null,
//     "count": 7,
//     "defaultSiteUrl": "https://www.example.com/",   // from GSC_SITE_URL, if set
//     "sites": [
//       { "siteUrl": "sc-domain:example.com", "permissionLevel": "siteOwner",
//         "type": "domain", "canQuery": true }
//     ]
//   }

import { refreshAccessToken, listSites } from "../lib/gsc.js";

export async function GET(request) {
  const u = new URL(request.url);
  return respond(u.searchParams.get("token"));
}

export async function POST(request) {
  let body = {};
  try {
    body = await request.json();
  } catch {
    /* empty body is fine — fall back to the server token */
  }
  return respond(body.gscRefreshToken);
}

async function respond(suppliedToken) {
  const refreshToken =
    (suppliedToken || "").trim() || process.env.GSC_REFRESH_TOKEN || null;

  if (!refreshToken) {
    return json({
      error: "No Search Console refresh token available.",
      hint: "Set GSC_REFRESH_TOKEN, or pass one. Get a token from /api/auth/start.",
      sites: [],
    }, 400);
  }

  let tokens;
  try {
    tokens = await refreshAccessToken(refreshToken);
  } catch (e) {
    return json({
      error: "Search Console token refresh failed.",
      detail: String(e.message || e),
      hint: "The refresh token may have been revoked. Get a new one from /api/auth/start.",
      sites: [],
    }, 502);
  }

  let sites;
  try {
    sites = await listSites(tokens.access_token);
  } catch (e) {
    return json({
      error: "Could not list Search Console properties.",
      detail: String(e.message || e),
      sites: [],
    }, 502);
  }

  const readable = sites.filter((s) => s.canQuery);

  return json({
    account: accountFromIdToken(tokens.id_token),
    count: sites.length,
    readable: readable.length,
    defaultSiteUrl: process.env.GSC_SITE_URL || null,
    sites,
    note: sites.length
      ? "Any of these can be passed as gscSiteUrl. Use the identifier exactly as shown — " +
        "Domain properties are \"sc-domain:example.com\", URL-prefix properties include the " +
        "scheme and trailing slash."
      : "This account has no Search Console properties. Add it as a user in Search Console " +
        "(Settings → Users and permissions) on each property you want to read.",
    ...(sites.length && !readable.length
      ? { warning: "Every property is listed as siteUnverifiedUser — visible, but not readable. Ask an owner for at least Restricted access." }
      : {}),
  });
}

// The id_token is a plain JWT; read the email claim for display only.
// Not used for any authorisation decision.
function accountFromIdToken(idToken) {
  if (!idToken || typeof idToken !== "string") return null;
  const parts = idToken.split(".");
  if (parts.length < 2) return null;
  try {
    const pad = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const payload = JSON.parse(Buffer.from(pad, "base64").toString("utf8"));
    return payload.email || null;
  } catch {
    return null;
  }
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
