// api/crawl/next.js
// POST /api/crawl/next   (agent only, Bearer AGENT_TOKEN)
// The local Screaming Frog agent calls this to claim the oldest pending job.
// Returns { job } or { job: null } when the queue is empty.

import { isKvConfigured, kvGetJSON, kvSetJSON, kvLRange } from "../../lib/kv.js";
import { requireAgent } from "../../lib/agent-auth.js";

export async function POST(request) {
  const auth = requireAgent(request);
  if (auth) return auth;
  if (!isKvConfigured()) return json({ error: "KV not configured." }, 503);

  // scan recent jobs oldest-first for a pending one, claim it atomically enough
  const ids = ((await kvLRange("crawl:jobs", 0, 99)) || []).slice().reverse();
  for (const id of ids) {
    const job = await kvGetJSON(`crawl:job:${id}`);
    if (job && job.status === "pending") {
      job.status = "running";
      job.claimedAt = new Date().toISOString();
      await kvSetJSON(`crawl:job:${id}`, job, 60 * 60 * 24 * 30);
      return json({ job });
    }
  }
  return json({ job: null });
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj, null, 2), { status, headers: { "Content-Type": "application/json" } });
}
