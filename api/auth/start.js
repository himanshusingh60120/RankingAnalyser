// api/auth/start.js
// GET /api/auth/start  -> redirects the user to Google's consent screen.
import { buildAuthUrl } from "../../lib/gsc.js";
import crypto from "node:crypto";

export function GET() {
  const secret = process.env.OAUTH_STATE_SECRET || "dev-secret";
  const nonce = crypto.randomBytes(16).toString("hex");
  const sig = crypto.createHmac("sha256", secret).update(nonce).digest("hex").slice(0, 16);
  const state = `${nonce}.${sig}`;
  return new Response(null, {
    status: 302,
    headers: { Location: buildAuthUrl(state) },
  });
}
