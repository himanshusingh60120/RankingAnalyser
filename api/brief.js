// api/brief.js
// SAVE & SHARE briefs so the research team reviews the exact same brief.
//   POST /api/brief   { brief }   -> { id, savedAt }   (brief = the /api/plan response)
//   GET  /api/brief?id=<id>       -> { savedAt, brief }
//
// Storage: Vercel Blob. Vercel dashboard → Storage → Create → Blob, connect it
// to this project; BLOB_READ_WRITE_TOKEN is injected automatically.
// Requires: npm install @vercel/blob
//
// Blobs are written with public access but under an unguessable 64-bit id, and
// this API is the only reader (the raw blob URL is never sent to the browser).
// Both routes sit behind the same access-key guard as /api/plan.

import { put, list } from "@vercel/blob";
import { randomBytes } from "node:crypto";
import { guard, preflight } from "../lib/guard.js";

const MAX_BYTES = 500_000;
const ID_RE = /^[a-f0-9]{16}$/;

const json = (obj, status = 200, headers = {}) =>
  new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", ...headers } });

export async function OPTIONS(request) {
  return preflight(request, "GET, POST, OPTIONS");
}

export async function POST(request) {
  const g = guard(request, { bucket: "brief-save", limit: 60 });
  if (!g.ok) return g.response;
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    return json({ error: "Brief storage is not configured (connect a Vercel Blob store).", code: "NO_STORAGE" }, 501, g.headers);
  }

  let body;
  try { body = await request.json(); } catch { return json({ error: "Invalid JSON body" }, 400, g.headers); }
  const brief = body && body.brief;
  if (!brief || typeof brief !== "object" || !brief.keyword || !brief.generatedAt) {
    return json({ error: "Provide { brief } — the full /api/plan response." }, 400, g.headers);
  }

  const savedAt = new Date().toISOString();
  const payload = JSON.stringify({ savedAt, brief });
  if (payload.length > MAX_BYTES) return json({ error: "Brief too large to save." }, 413, g.headers);

  const id = randomBytes(8).toString("hex"); // 16 hex chars = 64 bits
  try {
    await put(`briefs/${id}.json`, payload, {
      access: "public",
      contentType: "application/json",
      addRandomSuffix: false,
    });
  } catch (e) {
    return json({ error: "Could not save brief: " + String(e.message || e) }, 502, g.headers);
  }
  return json({ id, savedAt }, 200, g.headers);
}

export async function GET(request) {
  const g = guard(request, { bucket: "brief-load", limit: 120 });
  if (!g.ok) return g.response;
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    return json({ error: "Brief storage is not configured.", code: "NO_STORAGE" }, 501, g.headers);
  }

  const id = new URL(request.url).searchParams.get("id") || "";
  if (!ID_RE.test(id)) return json({ error: "Invalid brief id." }, 400, g.headers);

  try {
    const { blobs } = await list({ prefix: `briefs/${id}.json`, limit: 1 });
    if (!blobs || !blobs.length) {
      return json({ error: "Brief not found — the link may be wrong or the brief was deleted." }, 404, g.headers);
    }
    const r = await fetch(blobs[0].url, { cache: "no-store" });
    if (!r.ok) return json({ error: `Storage returned ${r.status}` }, 502, g.headers);
    return json(await r.json(), 200, g.headers);
  } catch (e) {
    return json({ error: "Could not load brief: " + String(e.message || e) }, 502, g.headers);
  }
}
