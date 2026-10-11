// api/share.js
// SAVE & SHARE snapshots so the team reviews the exact same output.
//   POST /api/share   { kind: "plan" | "brief", data }   -> { id, savedAt }
//   GET  /api/share?id=<id>                             -> { kind, savedAt, data }
//   kind "plan"  = a /api/plan response (Content Planner)
//   kind "brief" = { collected, ai, internalLinks } from /api/brief (Content Brief)
//
// Storage: Vercel Blob. Vercel → Storage → Create → Blob, connect to this project;
// BLOB_READ_WRITE_TOKEN is injected automatically. Requires: npm install @vercel/blob
//
// Blobs are written with public access but under an unguessable 64-bit id, and
// this API is the only reader (the raw blob URL never reaches the browser).
// Both routes sit behind the same access-key guard as /api/plan and /api/brief.

import { put, list } from "@vercel/blob";
import { randomBytes } from "node:crypto";
import { guard, preflight } from "../lib/guard.js";

const MAX_BYTES = 900_000;
const ID_RE = /^[a-f0-9]{16}$/;
const KINDS = new Set(["plan", "brief"]);

const json = (obj, status = 200, headers = {}) =>
  new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", ...headers } });

function validData(kind, data) {
  if (!data || typeof data !== "object") return false;
  if (kind === "plan") return !!(data.keyword && data.generatedAt);
  if (kind === "brief") return !!(data.collected && data.collected.keyword);
  return false;
}

export async function OPTIONS(request) {
  return preflight(request, "GET, POST, OPTIONS");
}

export async function POST(request) {
  const g = guard(request, { bucket: "share-save", limit: 60 });
  if (!g.ok) return g.response;
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    return json({ error: "Share storage is not configured (connect a Vercel Blob store).", code: "NO_STORAGE" }, 501, g.headers);
  }

  let body;
  try { body = await request.json(); } catch { return json({ error: "Invalid JSON body" }, 400, g.headers); }
  const kind = String((body && body.kind) || "");
  if (!KINDS.has(kind) || !validData(kind, body.data)) {
    return json({ error: "Provide { kind: 'plan' | 'brief', data } with the full tool output." }, 400, g.headers);
  }

  const savedAt = new Date().toISOString();
  const payload = JSON.stringify({ kind, savedAt, data: body.data });
  if (payload.length > MAX_BYTES) return json({ error: "Snapshot too large to save." }, 413, g.headers);

  const id = randomBytes(8).toString("hex"); // 16 hex chars = 64 bits
  try {
    await put(`shared/${id}.json`, payload, { access: "public", contentType: "application/json", addRandomSuffix: false });
  } catch (e) {
    return json({ error: "Could not save: " + String(e.message || e) }, 502, g.headers);
  }
  return json({ id, savedAt }, 200, g.headers);
}

export async function GET(request) {
  const g = guard(request, { bucket: "share-load", limit: 120 });
  if (!g.ok) return g.response;
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    return json({ error: "Share storage is not configured.", code: "NO_STORAGE" }, 501, g.headers);
  }

  const id = new URL(request.url).searchParams.get("id") || "";
  if (!ID_RE.test(id)) return json({ error: "Invalid share id." }, 400, g.headers);

  try {
    const { blobs } = await list({ prefix: `shared/${id}.json`, limit: 1 });
    if (!blobs || !blobs.length) return json({ error: "Not found — the link may be wrong or the snapshot was deleted." }, 404, g.headers);
    const r = await fetch(blobs[0].url, { cache: "no-store" });
    if (!r.ok) return json({ error: `Storage returned ${r.status}` }, 502, g.headers);
    return json(await r.json(), 200, g.headers);
  } catch (e) {
    return json({ error: "Could not load: " + String(e.message || e) }, 502, g.headers);
  }
}
