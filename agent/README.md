[README (1).md](https://github.com/user-attachments/files/30425839/README.1.md)
# Screaming Frog crawl agent

This little agent runs on the machine that has **Screaming Frog SEO Spider (paid
license, CLI enabled)**. It polls your Vercel app for crawl jobs, runs Screaming
Frog headless, and uploads the index status back. Vercel is the control plane —
you start and monitor crawls there; this agent does the actual crawling.

```
  Vercel UI  ──create job──►  KV queue  ◄──poll── this agent ──runs──► Screaming Frog CLI
                                  ▲                                          │
                                  └────────────── uploads results ──────────┘
        report "Use crawl data" ──reads──►  index status for every URL (no 2,000/day cap)
```

## One-time setup

### 1. On Vercel
1. **Storage → create a KV store** (Upstash Redis; free tier is fine) and
   connect it to the project. This injects `KV_REST_API_URL` and
   `KV_REST_API_TOKEN` automatically.
2. **Settings → Environment Variables → add `AGENT_TOKEN`** — a long random
   string. Generate one with:
   ```
   node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"
   ```
3. Redeploy so the new env vars take effect.

### 2. On the Screaming Frog machine
1. Install Node 18+ (for built-in `fetch`). No `npm install` needed.
2. Copy this repo's `agent/` folder to the machine (or just `sf-agent.mjs` and
   `.env.example`).
3. Copy `.env.example` → `.env` and fill in:
   - `VERCEL_BASE_URL` — your deployed app URL, no trailing slash
   - `AGENT_TOKEN` — the **same** string you set in Vercel
   - `SF_CLI_PATH` — full path to the Screaming Frog CLI executable
   - `SF_CONFIG_PATH` — (optional) a saved `.seospiderconfig` (see below)
4. Test it:
   ```
   node agent/sf-agent.mjs          # processes one job then exits
   node agent/sf-agent.mjs --loop   # polls forever
   ```

### 3. (Optional) Google's actual verdict via URL Inspection
Screaming Frog's own **Indexability** (Indexable / Non-Indexable + reason) has
**no quota** and covers every URL — that's the default and usually enough.

If you want Google's real coverage state ("Crawled - currently not indexed"),
enable it inside a saved config (it can't be toggled from the CLI):
1. Open the Screaming Frog desktop app.
2. **Configuration → API Access → Google Search Console** → connect the account.
3. Tick **URL Inspection** and **Enable URL Inspection**.
4. **File → Save Configuration** to a `.seospiderconfig` and point
   `SF_CONFIG_PATH` at it.

Note: this path is still bound by Google's **2,000 URL Inspections/day** — the
crawl itself is unlimited, only the Google verdict column is capped.

## Running it on a schedule (Windows Task Scheduler)

Create a Basic Task that runs at your chosen interval with:

- **Program/script:** `node`
- **Arguments:** `C:\path\to\agent\sf-agent.mjs`
- **Start in:** `C:\path\to\agent`

Or keep it always-on with `node sf-agent.mjs --loop` under a service wrapper
(e.g. NSSM). On macOS/Linux use `cron` or a `launchd`/`systemd` unit calling the
same command.

## How it flows day to day
1. In the tool, set the **Crawl target** and click **Start crawl**.
2. The agent's next poll claims the job, runs Screaming Frog headless, parses the
   Internal export, and uploads the index status in chunks.
3. The crawl card shows the job going `pending → running → done` with counts.
4. In the report, tick **"Use the latest Screaming Frog crawl"** — every URL's
   Index Status column is filled from that crawl, no daily limit.

## Troubleshooting
- **"No KV store connected"** — finish step 1 (KV) and redeploy.
- **401 from the agent** — `AGENT_TOKEN` in `.env` doesn't match Vercel's.
- **"No CSV export found"** — the crawl produced no Internal export; check the SF
  CLI path and that the license enables CLI use.
- **Upload too large** — lower `CHUNK_SIZE` in `.env` (default 4000).
