// api/crawl.js
// Single crawl endpoint (merged to stay under Vercel Hobby's 12-function limit).
// Routes by ?action= :
//   GET  /api/crawl?action=status   -> UI: KV state + recent jobs
//   GET  /api/crawl?action=jobs     -> UI: list jobs
//   POST /api/crawl?action=jobs     -> UI: create a crawl job
//   POST /api/crawl?action=next     -> agent: claim next pending job (Bearer AGENT_TOKEN)
//   POST /api/crawl?action=ingest   -> agent: upload parsed rows in chunks (Bearer AGENT_TOKEN)

import { isKvConfigured, kvStatus, kvGetJSON, kvSetJSON, kvLPush, kvLRange } from "../lib/kv.js";
import { requireAgent } from "../lib/agent-auth.js";
import { parseCrawlRows } from "../lib/crawl-parse.js";

const TTL = 60 * 60 * 24 * 30; // 30 days

export async function GET(request) {
  try {
    const action = new URL(request.url).searchParams.get("action") || "status";
    if (action === "jobs") {
      if (!isKvConfigured()) return kvErr(kvStatus().reason);
      const ids = (await kvLRange("crawl:jobs", 0, 49)) || [];
      const jobs = [];
      for (const id of ids) { const j = await kvGetJSON(`crawl:job:${id}`); if (j) jobs.push(j); }
      return json({ jobs });
    }
    // default: status
    if (!isKvConfigured()) {
      return json({ configured: false, detail: kvStatus().reason,
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
  } catch (e) {
    return json({ error: "crawl GET failed", detail: String(e && e.message || e) }, 500);
  }
}

export async function POST(request) {
  try {
    const action = new URL(request.url).searchParams.get("action") || "";
    if (action === "next") return claimNext(request);
    if (action === "ingest") return ingest(request);
    if (action === "jobs") return createJob(request);
    return json({ error: `Unknown action "${action}". Use next | ingest | jobs.` }, 400);
  } catch (e) {
    return json({ error: "crawl POST failed", detail: String(e && e.message || e) }, 500);
  }
}

async function createJob(request) {
  if (!isKvConfigured()) return kvErr(kvStatus().reason);
  let body; try { body = await request.json(); } catch { return json({ error: "Invalid JSON body." }, 400); }
  const target = String(body.target || body.crawlUrl || "").trim();
  if (!/^https?:\/\//i.test(target)) return json({ error: "Provide a target URL to crawl (a site root or a sitemap URL)." }, 400);
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const job = { id, target, mode: body.mode === "sitemap" ? "sitemap" : "spider",
    useUrlInspection: body.useUrlInspection === true,
    label: String(body.label || "").slice(0, 120) || target,
    status: "pending", createdAt: new Date().toISOString(), chunks: 0, counts: null };
  await kvSetJSON(`crawl:job:${id}`, job, TTL);
  await kvLPush("crawl:jobs", id);
  return json({ job }, 201);
}

async function claimNext(request) {
  const auth = requireAgent(request); if (auth) return auth;
  if (!isKvConfigured()) return json({ error: "KV not configured.", detail: kvStatus().reason }, 503);
  const ids = ((await kvLRange("crawl:jobs", 0, 99)) || []).slice().reverse();
  for (const id of ids) {
    const job = await kvGetJSON(`crawl:job:${id}`);
    if (job && job.status === "pending") {
      job.status = "running"; job.claimedAt = new Date().toISOString();
      await kvSetJSON(`crawl:job:${id}`, job, TTL);
      return json({ job });
    }
  }
  return json({ job: null });
}

async function ingest(request) {
  const auth = requireAgent(request); if (auth) return auth;
  if (!isKvConfigured()) return json({ error: "KV not configured." }, 503);
  let body; try { body = await request.json(); } catch { return json({ error: "Invalid JSON body." }, 400); }
  const jobId = String(body.jobId || "");
  const chunkIndex = Number(body.chunkIndex);
  if (!jobId || !Number.isInteger(chunkIndex) || chunkIndex < 0)
    return json({ error: "jobId and a non-negative integer chunkIndex are required." }, 400);
  const job = await kvGetJSON(`crawl:job:${jobId}`);
  if (!job) return json({ error: `Unknown job ${jobId}.` }, 404);

  const rows = Array.isArray(body.rows) ? body.rows : [];
  const parsed = parseCrawlRows(rows);
  const compact = parsed.map((p) => ({ n: p.norm, u: p.url, i: p.indexed, l: p.label, s: p.statusCode }));
  await kvSetJSON(`crawl:chunk:${jobId}:${chunkIndex}`, compact, TTL);

  job.chunks = Math.max(job.chunks || 0, chunkIndex + 1);
  job.receivedRows = (job.receivedRows || 0) + compact.length;
  job.updatedAt = new Date().toISOString();

  if (body.done === true) {
    let indexed = 0, notIndexed = 0, unknown = 0;
    const chunkKeys = [];
    for (let i = 0; i < job.chunks; i++) {
      const key = `crawl:chunk:${jobId}:${i}`;
      chunkKeys.push(key);
      const c = (await kvGetJSON(key)) || [];
      for (const r of c) { if (r.i === true) indexed++; else if (r.i === false) notIndexed++; else unknown++; }
    }
    job.status = "done"; job.finishedAt = new Date().toISOString();
    job.counts = { total: indexed + notIndexed + unknown, indexed, notIndexed, unknown };
    job.chunkKeys = chunkKeys;
    await kvSetJSON(`crawl:job:${jobId}`, job, TTL);
    await kvSetJSON("crawl:latest", { jobId, target: job.target, chunkKeys, counts: job.counts, finishedAt: job.finishedAt }, TTL);
    return json({ ok: true, job });
  }
  await kvSetJSON(`crawl:job:${jobId}`, job, TTL);
  return json({ ok: true, chunks: job.chunks, receivedRows: job.receivedRows });
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj, null, 2), { status, headers: { "Content-Type": "application/json" } });
}
function kvErr(detail) {
  return json({ error: "No KV store connected.", detail: detail || undefined,
    hint: "In Vercel → Storage, create an Upstash for Redis store and connect it to this project, then redeploy." }, 503);
}
