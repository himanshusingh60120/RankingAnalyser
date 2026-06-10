// api/auth/callback.js
// GET /api/auth/callback?code=...&state=...
// Exchanges the code, validates state, returns the refresh_token to the caller.
// The caller stores the refresh_token and passes it to /api/analyze later.
import { exchangeCodeForTokens } from "../../lib/gsc.js";
import crypto from "node:crypto";

export async function GET(request) {
  const u = new URL(request.url);
  const code = u.searchParams.get("code");
  const state = u.searchParams.get("state") || "";
  if (!code) return j({ error: "Missing code" }, 400);

  // validate state signature
  const [nonce, sig] = state.split(".");
  const secret = process.env.OAUTH_STATE_SECRET || "dev-secret";
  const expect = crypto.createHmac("sha256", secret).update(nonce || "").digest("hex").slice(0, 16);
  if (!nonce || sig !== expect) return j({ error: "Invalid state" }, 400);

  try {
    const tokens = await exchangeCodeForTokens(code);
    return j({
      ok: true,
      message:
        "Authorized. Store refresh_token securely and pass it to /api/analyze " +
        "as gscRefreshToken along with gscSiteUrl.",
      refresh_token: tokens.refresh_token || null,
      scope: tokens.scope,
      note: tokens.refresh_token
        ? undefined
        : "No refresh_token returned — revoke prior access at myaccount.google.com and retry (prompt=consent forces it).",
    });
  } catch (e) {
    return j({ error: String(e.message || e) }, 502);
  }
}

function j(o, s = 200) {
  return new Response(JSON.stringify(o, null, 2), {
    status: s,
    headers: { "Content-Type": "application/json" },
  });
}
