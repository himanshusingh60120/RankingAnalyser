// api/crawl/jobs.js
// GET  /api/crawl/jobs            -> list recent jobs (for the UI)
// POST /api/crawl/jobs            -> create a crawl job (from the UI)
//
// A job describes what the local Screaming Frog agent should crawl. The agent
// polls /api/crawl/next to claim pending jobs.

import { isKvConfigured, kvGetJSON, kvSetJSON, kvLPush, kvLRange } from "../../lib/kv.js";

const JOBS_TTL = 60 * 60 * 24 * 30; // 30 days

export async function GET() {
  if (!isKvConfigured()) return kvErr();
  const ids = (await kvLRange("crawl:jobs", 0, 49)) || [];
  const jobs = [];
  for (const id of ids) {
    const j = await kvGetJSON(`crawl:job:${id}`);
    if (j) jobs.push(j);
  }
  return json({ jobs });
}

export async function POST(request) {
  if (!isKvConfigured()) return kvErr();
  let body;
  try { body = await request.json(); } catch { return json({ error: "Invalid JSON body." }, 400); }

  const target = String(body.target || body.crawlUrl || "").trim();
  if (!/^https?:\/\//i.test(target)) {
    return json({ error: "Provide a target URL to crawl (a site root or a sitemap URL)." }, 400);
  }

  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const job = {
    id,
    target,
    mode: body.mode === "sitemap" ? "sitemap" : "spider", // crawl a sitemap's URLs, or spider the site
    useUrlInspection: body.useUrlInspection === true,       // ask the agent to enable GSC URL Inspection
    label: String(body.label || "").slice(0, 120) || target,
    status: "pending",
    createdAt: new Date().toISOString(),
    chunks: 0,
    counts: null,
  };
  await kvSetJSON(`crawl:job:${id}`, job, JOBS_TTL);
  await kvLPush("crawl:jobs", id);
  return json({ job }, 201);
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj, null, 2), { status, headers: { "Content-Type": "application/json" } });
}
function kvErr() {
  return json({
    error: "No KV store connected.",
    hint: "In Vercel → Storage, create a KV (Upstash Redis) store and connect it to this project. That injects KV_REST_API_URL and KV_REST_API_TOKEN.",
  }, 503);
}
