// api/health.js  -> GET /api/health
import { COMPETITOR_SITES } from "../lib/competitors.js";
export function GET() {
  return new Response(
    JSON.stringify({
      ok: true,
      service: "seo-xray-api",
      competitors: COMPETITOR_SITES,
      time: new Date().toISOString(),
    }, null, 2),
    { headers: { "Content-Type": "application/json" } }
  );
}
