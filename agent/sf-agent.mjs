#!/usr/bin/env node
// agent/sf-agent.mjs
//
// Runs on the machine that has Screaming Frog SEO Spider (paid license, CLI
// enabled). Polls your Vercel app for crawl jobs, runs Screaming Frog headless,
// parses the export, and uploads the index status back to Vercel in chunks.
//
// Vercel is the control plane: you create/trigger jobs and read results there;
// this agent is the muscle that runs the actual crawl locally.
//
// Setup: copy .env.example -> .env and fill it in, then:
//   node agent/sf-agent.mjs            # run once, process one job and exit
//   node agent/sf-agent.mjs --loop     # poll forever (every POLL_SECONDS)
//
// Requires Node 18+ (built-in fetch). No npm install needed.

import { spawn } from "node:child_process";
import { readFile, readdir, mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ---- config from environment ----
const CFG = {
  base: env("VERCEL_BASE_URL"),                 // e.g. https://ranking-analyser.vercel.app
  token: env("AGENT_TOKEN"),                    // must match the Vercel env var
  sfCli: env("SF_CLI_PATH"),                    // full path to the Screaming Frog CLI executable
  sfConfig: process.env.SF_CONFIG_PATH || "",   // optional .seospiderconfig
  outDir: process.env.SF_OUTPUT_DIR || "",      // optional; a temp dir is used if empty
  chunkSize: Number(process.env.CHUNK_SIZE || 4000),
  pollSeconds: Number(process.env.POLL_SECONDS || 60),
};

function env(name) {
  const v = process.env[name];
  if (!v) { console.error(`Missing required env var ${name}. Copy agent/.env.example to .env and fill it in.`); process.exit(1); }
  return v;
}

const api = (path, opts = {}) =>
  fetch(`${CFG.base}${path}`, {
    ...opts,
    headers: { Authorization: `Bearer ${CFG.token}`, "Content-Type": "application/json", ...(opts.headers || {}) },
  });

async function claimJob() {
  const res = await api("/api/crawl-next", { method: "POST", body: "{}" });
  if (!res.ok) throw new Error(`claim failed: ${res.status} ${await res.text()}`);
  return (await res.json()).job;
}

// Run Screaming Frog headless and return the folder it wrote exports to.
async function runCrawl(job) {
  const out = CFG.outDir || (await mkdtemp(join(tmpdir(), "sfcrawl-")));
  const args = [];
  if (job.mode === "sitemap") { args.push("--crawl-list"); } // treated below
  // Screaming Frog flags. --crawl for a spider crawl; sitemaps are crawled by
  // pointing --crawl at the sitemap URL with "crawl these sitemaps" config, or
  // simply spidering the site root. We spider the target here.
  args.length = 0;
  args.push("--crawl", job.target, "--headless", "--overwrite",
            "--output-folder", out,
            "--export-tabs", "Internal:All");
  if (CFG.sfConfig && existsSync(CFG.sfConfig)) args.push("--config", CFG.sfConfig);
  // If the job wants Google's verdict, your saved .seospiderconfig must have
  // GSC URL Inspection enabled (see agent/README.md) — it can't be toggled via CLI.

  console.log(`[crawl] ${CFG.sfCli} ${args.join(" ")}`);
  await new Promise((resolve, reject) => {
    const p = spawn(CFG.sfCli, args, { stdio: "inherit" });
    p.on("error", reject);
    p.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`Screaming Frog exited ${code}`))));
  });
  return out;
}

// Find the Internal export CSV in the output folder.
async function findExport(dir) {
  const files = await readdir(dir);
  const csv = files.find((f) => /internal.*\.csv$/i.test(f)) || files.find((f) => f.toLowerCase().endsWith(".csv"));
  if (!csv) throw new Error(`No CSV export found in ${dir}`);
  return join(dir, csv);
}

// Minimal CSV parse (handles quoted fields) -> array of row objects.
function parseCsv(text) {
  const rows = [];
  let i = 0, field = "", record = [], inQ = false;
  const pushF = () => { record.push(field); field = ""; };
  const pushR = () => { if (record.length) rows.push(record); record = []; };
  while (i < text.length) {
    const c = text[i];
    if (inQ) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false; }
      else field += c;
    } else if (c === '"') inQ = true;
    else if (c === ",") pushF();
    else if (c === "\n") { pushF(); pushR(); }
    else if (c === "\r") { /* skip */ }
    else field += c;
    i++;
  }
  if (field.length || record.length) { pushF(); pushR(); }
  if (!rows.length) return [];
  const header = rows.shift();
  return rows.map((r) => Object.fromEntries(header.map((h, idx) => [h, r[idx] ?? ""])));
}

async function uploadChunks(job, rowObjs) {
  // keep only the columns the server needs, to stay small
  const keep = (r) => {
    const g = (names) => {
      for (const n of names) {
        const k = Object.keys(r).find((x) => x.trim().toLowerCase() === n);
        if (k && String(r[k]).trim() !== "") return String(r[k]).trim();
      }
      return "";
    };
    return {
      url: g(["address", "url"]),
      statusCode: g(["status code"]),
      indexability: g(["indexability"]),
      indexabilityStatus: g(["indexability status"]),
      coverage: g(["coverage", "search console coverage"]),
    };
  };
  const rows = rowObjs.map(keep).filter((r) => /^https?:\/\//i.test(r.url));
  const total = Math.max(1, Math.ceil(rows.length / CFG.chunkSize));
  for (let c = 0; c < total; c++) {
    const slice = rows.slice(c * CFG.chunkSize, (c + 1) * CFG.chunkSize);
    const done = c === total - 1;
    const res = await api("/api/crawl-ingest", {
      method: "POST",
      body: JSON.stringify({ jobId: job.id, chunkIndex: c, done, rows: slice }),
    });
    if (!res.ok) throw new Error(`ingest chunk ${c} failed: ${res.status} ${await res.text()}`);
    console.log(`[upload] chunk ${c + 1}/${total} (${slice.length} rows)${done ? " — done" : ""}`);
  }
  console.log(`[done] uploaded ${rows.length} URLs for job ${job.id}`);
}

async function processOne() {
  const job = await claimJob();
  if (!job) { console.log("No pending jobs."); return false; }
  console.log(`[job] ${job.id} — crawling ${job.target}`);
  let dir;
  try {
    dir = await runCrawl(job);
    const csvPath = await findExport(dir);
    const text = await readFile(csvPath, "utf8");
    const rows = parseCsv(text);
    console.log(`[parse] ${rows.length} rows from ${csvPath}`);
    await uploadChunks(job, rows);
  } finally {
    if (dir && !CFG.outDir) await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
  return true;
}

const loop = process.argv.includes("--loop");
if (loop) {
  console.log(`Agent polling ${CFG.base} every ${CFG.pollSeconds}s. Ctrl+C to stop.`);
  for (;;) {
    try { await processOne(); } catch (e) { console.error("[error]", e.message); }
    await new Promise((r) => setTimeout(r, CFG.pollSeconds * 1000));
  }
} else {
  try { await processOne(); } catch (e) { console.error("[error]", e.message); process.exit(1); }
}
