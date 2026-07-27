// api/crawl/ingest.js
// POST /api/crawl/ingest   (agent only, Bearer AGENT_TOKEN)
// The agent uploads parsed crawl rows in chunks (to stay under body limits).
//
// Body: {
//   jobId: string,
//   chunkIndex: number,               // 0-based
//   done: boolean,                    // true on the final chunk
//   rows: [{ url, statusCode, indexability, indexabilityStatus, coverage }, ...]
// }
//
// Rows are normalized and stored as chunked JSON under crawl:chunk:<jobId>:<n>.
// When done, crawl:latest points at this job with its chunk list + counts so
// the report can load the index status for every crawled URL.

import { isKvConfigured, kvGetJSON, kvSetJSON } from "../../lib/kv.js";
import { requireAgent } from "../../lib/agent-auth.js";
import { parseCrawlRows } from "../../lib/crawl-parse.js";

const TTL = 60 * 60 * 24 * 30;

export async function POST(request) {
  const auth = requireAgent(request);
  if (auth) return auth;
  if (!isKvConfigured()) return json({ error: "KV not configured." }, 503);

  let body;
  try { body = await request.json(); } catch { return json({ error: "Invalid JSON body." }, 400); }

  const jobId = String(body.jobId || "");
  const chunkIndex = Number(body.chunkIndex);
  if (!jobId || !Number.isInteger(chunkIndex) || chunkIndex < 0) {
    return json({ error: "jobId and a non-negative integer chunkIndex are required." }, 400);
  }
  const job = await kvGetJSON(`crawl:job:${jobId}`);
  if (!job) return json({ error: `Unknown job ${jobId}.` }, 404);

  const rows = Array.isArray(body.rows) ? body.rows : [];
  const parsed = parseCrawlRows(rows);
  // store compact records only
  const compact = parsed.map((p) => ({
    n: p.norm, u: p.url, i: p.indexed, l: p.label, s: p.statusCode,
  }));
  await kvSetJSON(`crawl:chunk:${jobId}:${chunkIndex}`, compact, TTL);

  job.chunks = Math.max(job.chunks || 0, chunkIndex + 1);
  job.receivedRows = (job.receivedRows || 0) + compact.length;
  job.updatedAt = new Date().toISOString();

  if (body.done === true) {
    // tally
    let indexed = 0, notIndexed = 0, unknown = 0;
    const chunkKeys = [];
    for (let i = 0; i < job.chunks; i++) {
      const key = `crawl:chunk:${jobId}:${i}`;
      chunkKeys.push(key);
      const c = (await kvGetJSON(key)) || [];
      for (const r of c) {
        if (r.i === true) indexed++;
        else if (r.i === false) notIndexed++;
        else unknown++;
      }
    }
    job.status = "done";
    job.finishedAt = new Date().toISOString();
    job.counts = { total: indexed + notIndexed + unknown, indexed, notIndexed, unknown };
    job.chunkKeys = chunkKeys;
    await kvSetJSON(`crawl:job:${jobId}`, job, TTL);
    await kvSetJSON("crawl:latest", {
      jobId, target: job.target, chunkKeys, counts: job.counts, finishedAt: job.finishedAt,
    }, TTL);
    return json({ ok: true, job });
  }

  await kvSetJSON(`crawl:job:${jobId}`, job, TTL);
  return json({ ok: true, chunks: job.chunks, receivedRows: job.receivedRows });
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj, null, 2), { status, headers: { "Content-Type": "application/json" } });
}
