// api/crawl/status.js
// GET /api/crawl/status  -> { latest, jobs } for the UI to display crawl state.

import { isKvConfigured, kvGetJSON, kvLRange } from "../../lib/kv.js";

export async function GET() {
  if (!isKvConfigured()) {
    return json({ configured: false,
      hint: "Connect a Vercel KV (Upstash) store to enable crawl-based index status." });
  }
  const latest = await kvGetJSON("crawl:latest");
  const ids = (await kvLRange("crawl:jobs", 0, 19)) || [];
  const jobs = [];
  for (const id of ids) {
    const j = await kvGetJSON(`crawl:job:${id}`);
    if (j) jobs.push({ id: j.id, label: j.label, target: j.target, status: j.status,
                       createdAt: j.createdAt, finishedAt: j.finishedAt, counts: j.counts });
  }
  return json({ configured: true, latest, jobs });
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj, null, 2), { status, headers: { "Content-Type": "application/json" } });
}
