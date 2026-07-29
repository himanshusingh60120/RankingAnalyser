#!/usr/bin/env node
// agent/sf-agent.mjs
//
// Runs on the machine that has Screaming Frog SEO Spider (paid license, CLI
// enabled). Polls your Vercel app for crawl jobs, runs Screaming Frog headless,
// parses the export, and uploads index status + status codes back to Vercel.
//
//   node sf-agent.mjs            # process one job and exit
//   node sf-agent.mjs --loop     # poll forever (every POLL_SECONDS)
//
// Requires Node 18+ (built-in fetch). No npm install needed.
//
// JOB MODES:
//   sitemap  -> fetch EVERY URL from the sitemap (or sitemap index, all
//               languages) and crawl exactly those URLs via List mode
//               (--crawl-list). This is what you want for "crawl my sitemap
//               URLs, get 301s/404s + indexability". No GUI config needed.
//   spider   -> classic --crawl <url> spider that follows links.

import { spawn } from "node:child_process";
import { readFile, writeFile, readdir, mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CFG = {
  base: env("VERCEL_BASE_URL"),
  token: env("AGENT_TOKEN"),
  sfCli: env("SF_CLI_PATH"),
  sfConfig: process.env.SF_CONFIG_PATH || "",
  outDir: process.env.SF_OUTPUT_DIR || "",
  chunkSize: Number(process.env.CHUNK_SIZE || 4000),
  pollSeconds: Number(process.env.POLL_SECONDS || 60),
};

function env(name) {
  const v = process.env[name];
  if (!v) { console.error(`Missing required env var ${name}.`); process.exit(1); }
  return v;
}

const api = (path, opts = {}) =>
  fetch(`${CFG.base}${path}`, {
    ...opts,
    headers: { Authorization: `Bearer ${CFG.token}`, "Content-Type": "application/json", ...(opts.headers || {}) },
  });

async function claimJob() {
  const res = await api("/api/crawl?action=next", { method: "POST", body: "{}" });
  if (!res.ok) throw new Error(`claim failed: ${res.status} ${await res.text()}`);
  return (await res.json()).job;
}

// ---- Sitemap expansion -------------------------------------------------------
// Recursively fetch a sitemap or sitemap index and return all page <loc> URLs.
async function fetchText(url) {
  const res = await fetch(url, { headers: { "User-Agent": "RankingAnalyser-Agent/1.0" } });
  if (!res.ok) throw new Error(`fetch ${url} -> ${res.status}`);
  return res.text();
}

function extractLocs(xml) {
  const locs = [];
  const re = /<loc>\s*([^<\s]+)\s*<\/loc>/gi;
  let m;
  while ((m = re.exec(xml))) locs.push(m[1].trim());
  return locs;
}

async function expandSitemap(url, seen = new Set(), pages = []) {
  if (seen.has(url)) return pages;
  seen.add(url);
  let xml;
  try { xml = await fetchText(url); }
  catch (e) { console.error(`[sitemap] skip ${url}: ${e.message}`); return pages; }

  const isIndex = /<sitemapindex/i.test(xml);
  const locs = extractLocs(xml);
  if (isIndex) {
    console.log(`[sitemap] index ${url} -> ${locs.length} child sitemaps`);
    for (const child of locs) await expandSitemap(child, seen, pages);
  } else {
    console.log(`[sitemap] ${url} -> ${locs.length} urls`);
    for (const u of locs) pages.push(u);
  }
  return pages;
}

// ---- Run Screaming Frog ------------------------------------------------------
async function runCrawl(job) {
  const out = CFG.outDir || (await mkdtemp(join(tmpdir(), "sfcrawl-")));
  const wantSitemap = job.mode === "sitemap" || /sitemap[^/]*\.xml($|\?)/i.test(job.target);

  let args;
  let listFile = "";
  if (wantSitemap) {
    // Expand the sitemap(s) to a URL list, then crawl exactly those URLs.
    const pages = [...new Set(await expandSitemap(job.target))];
    if (!pages.length) throw new Error(`No URLs found in sitemap ${job.target}`);
    listFile = join(out, "urls.txt");
    await writeFile(listFile, pages.join("\n"), "utf8");
    console.log(`[sitemap] total ${pages.length} URLs -> ${listFile}`);
    args = [
      "--crawl-list", listFile,
      "--headless", "--overwrite",
      "--output-folder", out,
      "--export-tabs", "Internal:All",
    ];
  } else {
    args = [
      "--crawl", job.target,
      "--headless", "--overwrite",
      "--output-folder", out,
      "--export-tabs", "Internal:All",
    ];
  }
  if (CFG.sfConfig && existsSync(CFG.sfConfig)) args.push("--config", CFG.sfConfig);

  console.log(`[crawl] ${CFG.sfCli} ${args.join(" ")}`);
  await new Promise((resolve, reject) => {
    const p = spawn(CFG.sfCli, args, { stdio: "inherit" });
    p.on("error", reject);
    p.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`Screaming Frog exited ${code}`))));
  });
  return out;
}

async function findExport(dir) {
  const files = await readdir(dir);
  const csv = files.find((f) => /internal.*\.csv$/i.test(f)) || files.find((f) => f.toLowerCase().endsWith(".csv"));
  if (!csv) throw new Error(`No CSV export found in ${dir}`);
  return join(dir, csv);
}

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
      status: g(["status"]),
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
    const res = await api("/api/crawl?action=ingest", {
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
  console.log(`[job] ${job.id} — ${job.mode || "spider"} — ${job.target}`);
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
