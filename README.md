# Ranking X-Ray

Internal SEO tool for Kings Research — live at **https://ranking-analyser.vercel.app**.
Four tools that follow a report page from the brief to tracking its rankings:

| # | Tool | Page | Use it when | API |
|---|---|---|---|---|
| 1 | **Content Brief** | `/brief` | Before you write | `POST /api/brief` |
| 2 | **Content Planner** | `/planner` | A draft is written, before publishing | `POST /api/plan` |
| 3 | **Ranking X-Ray** | `/` | The page is live — why do competitors rank above it? | `POST /api/analyze` |
| 4 | **Search Console** | `/bulk` | After publishing — clicks, hreflang, indexing | `/api/sitemaps`, `/api/hreflang-report`, `/api/hreflang-assemble`, `/api/bulk-compare`, `/api/crawl` |

Every brief is saved to Google Drive and a tracking Google Sheet, which re-checks Google
rankings every week (see [Tracking sheet](#tracking-sheet-apps-script)).

---

## Contents

1. [How it's built](#how-its-built)
2. [Competitors we track](#competitors-we-track)
3. [Content Brief — how it works](#content-brief--how-it-works)
4. [How competitors are compared](#how-competitors-are-compared)
5. [Tracking sheet (Apps Script)](#tracking-sheet-apps-script)
6. [Ranking X-Ray, Content Planner, Search Console](#ranking-x-ray-content-planner-search-console)
7. [Setup](#setup)
8. [Limits and things to know](#limits-and-things-to-know)
9. [File map](#file-map)
10. [Local dev](#local-dev)

---

## How it's built

- **Vercel, Node 18+, ES modules, no build step.** The pages are plain HTML files at the repo root;
  `vercel.json` sets `cleanUrls`, so `/brief` serves `brief.html`.
- **Serverless functions in `api/`**, shared logic in `lib/`. Every function has a 60-second limit
  (`vercel.json` → `maxDuration: 60`).
- **Vercel Hobby allows 12 functions per deployment.** That's why the whole Content Brief —
  research, AI writing, saving, draft checks, rank checks — runs in one function (`api/brief.js`)
  and the browser picks the step with `stage`. `GET /api/health` is a rewrite to the same function.
- **Dependencies:** `cheerio` (reads HTML) and `exceljs` (spreadsheet exports).
- **`nav.js`** gives every page the same four-tool menu and the "How these tools fit together"
  guide, plus `AppNav.jumpBar()` — the sticky "Jump to" bar over long results. If it fails to load,
  each page keeps its own fallback menu.

---

## Competitors we track

There are two lists, used by different tools.

| List | File | Sites | Used by |
|---|---|---|---|
| `BRIEF_TRACKED` | `lib/brief.js` | MarketsandMarkets, MRFR, Precedence Research, Future Market Insights, Fortune Business Insights, **Grand View Research** | Content Brief, tracking sheet |
| `COMPETITOR_SITES` | `lib/competitors.js` | MRFR, Future Market Insights, MarketsandMarkets, Precedence Research, Persistence Market Research | Ranking X-Ray, Content Planner |

The Content Brief **always** analyses every site in `BRIEF_TRACKED`, even when it isn't on page 1:
it looks for the site in Google ranks 11–20, then runs a `site:` search, then guesses the report URL
(`SLUG_URL`). Domains in either list are tagged "tracked" in the brief.

### Adding a competitor

1. **`lib/brief.js`** — add it to `BRIEF_TRACKED` (`domain`, `name`, `short`). Optionally add its
   report-URL pattern to `REPORT_URL` and a URL guess to `SLUG_URL`.
2. **`brief.html`** — add the domain to `TRACKED_DOMAINS` (marks it in the AI Overview sources).
3. **`apps-script/Code.gs`** — add the **same `name`** to `TRACKED`, paste the file into the sheet's
   Apps Script editor, **Save**, run **setup** (adds the rank and URL columns), then
   **Deploy → Manage deployments → ✏️ → New version → Deploy**.
4. For the X-Ray and Planner too: add the domain to `COMPETITOR_SITES` in `lib/competitors.js`,
   plus its entries in `viaSlugProbe` and `viaOnSiteSearch`. Each extra site adds one page to every
   X-Ray run, which is closer to the 60-second limit.

---

## Content Brief — how it works

```
brief.html (browser)
│
├─ 1. stage "collect"  (one 60 s call)
│     lib/serp.js           Google top 10 for the keyword + country, and ranks 11–20
│     lib/brief.js          reads every page (lib/fetcher.js, lib/xray.js), finds each tracked
│                           competitor's report, builds the topic grid, keywords, benchmarks,
│                           targets and the competitor rows
│     lib/dupes.js          our own pages already ranking for this (Google + Search Console)
│     lib/brief-checks.js   search intent, keyword check, stale-data flags, figure check
│     lib/competitor-gaps.js  what most competitors miss (see below)
│
├─ 2. stage "write"  ┐ run side by side, each with its own 60 s
├─ 3. stage "gap"    ┘ (only when a gap analysis is attached)
│     lib/brief-ai.js        titles, H3 ideas, FAQs, "your job" line (OpenAI)
│     lib/internal-links.js  related Kings Research reports from the sitemap
│     lib/gap-analysis.js    reads the research team's gap analysis; brief-ai words its H3s
│
├─ 4. stage "save"
│     lib/sheet-summary.js  competitor gaps, page-1 URLs, tracked competitors' ranks + URLs
│     lib/storage.js        → Apps Script web app → Google Doc + JSON in Drive, row in the Sheet
│
└─ The browser builds the writer's skeleton from the saved data (buildSkeleton in brief.html),
   so reopening a saved brief (/brief?id=KB-…) runs no new searches.
```

### `POST /api/brief` stages

| Stage | Body | Returns |
|---|---|---|
| `collect` | `{ keyword, gl?, hl?, contentType?, ourUrl?, manual? }` | `{ collected }` — all research data |
| `write` | `{ collected }` | `{ ai, internalLinks }` |
| `gap` | `{ keyword, market?, url? \| html? \| text? }` | `{ gap }` — stored in `collected.gap` |
| `save` | `{ brief, html, country }` | `{ id, docUrl, sheetUrl }` |
| `list` | `{ limit? }` | saved briefs from the Sheet |
| `get` | `{ id }` | one saved brief, to reopen in the tool |
| `check` | `{ collected, title, meta, html }` | draft checker score and results (`lib/draft-check.js`) |
| `ranks` | `{ secret, keyword, gl }` | current ranks + ranking URLs + page-1 URLs (called by the Sheet) |
| `summary` | `{ secret, collected }` | sheet columns for briefs saved before the latest version |
| `full` | as `collect` | collect + write in one call (scripts only — can pass 60 s) |

`GET /api/brief` returns which services are configured; the page shows a banner for anything missing.

`manual` = competitor pages an analyst adds (URL, or URL + pasted page for sites that block us).
Max 8 pages.

### What the brief shows

**Writer's skeleton tab** — for the writer:
- **Your job** and targets (words, H2s, tables, FAQs).
- **What competitors miss — add these to beat them** (top opportunities).
- **Before you write** — our pages that already rank, the research team's gap analysis notes,
  competitor figures that don't add up.
- **The skeleton** in the Kings Research report format: title, meta, URL, H1, descriptor, byline,
  then each H2 with what to write, suggested question H3s, tables, keywords and
  "Competitors miss this" notes. Each H2 has a checkbox; progress shows in the side menu.

  House format: Overview → Key Market Highlights → Market Dynamics → Market Segmentation →
  Segmental Analysis → Regional Analysis → *(optional: Trends, Tariffs/Policy/AI, Pricing,
  Value Chain)* → Regulatory Landscape *(fixed slot on report pages)* → Competitive Landscape
  *(fixed H3s: M&A & partnerships, Latest developments, Key players)* → Research Methodology → FAQs.

**SEO details tab** — Google top 10, our existing pages, Competitor scorecard,
**What competitors miss** (grid), keywords competitors target, topics each competitor covers,
keywords to use, the gap analysis benchmark, Google's rules.

**Check my draft tab** — paste the finished draft; it's scored against the brief.

Copy, Word download and Print export the current tab with everything expanded.

### Research team's gap analysis (optional)

Attach the "Competitor SEO & Content Gap Analysis" as a Google Doc link (shared: anyone with the link
can view) or pasted. `lib/gap-analysis.js` reads its pointers (drivers, restraints, opportunities,
risks, regulation…), new H2 sections, regulatory jurisdictions, players, deals, developments, FAQs
and sources, and they go straight into the skeleton. Its figures go through the same figure check.

---

## How competitors are compared

### Which pages are compared

- **Google top 10** for the keyword and country — except category pages (lists of reports),
  social / UGC, our own pages and pages under 250 words. For report keywords, only research
  publishers are compared when at least two rank.
- **Every tracked competitor** (`BRIEF_TRACKED`), wherever it ranks.
- **Pages analysts add** under "Competitor pages".

Blocked sites go through fallbacks in `lib/fetcher.js` (scraping service, reader service,
archive.org, ChatGPT web search). The brief says which route was used. Pages read by ChatGPT are
left out of the word and table targets.

### What's compared

| Section of the brief | What it shows | Code |
|---|---|---|
| Competitor scorecard | Rank, words, tables, FAQs, market size, CAGR, forecast period, last updated; stale-data and "figures don't add up" flags | `lib/brief.js` → `buildCompetitorRows`, `lib/brief-checks.js` |
| Topics each competitor covers | Each page's H2/H3s mapped to 22 standard report topics. **Must have** = at least half the pages; **good to have** = 2+ | `lib/brief.js` → `buildTopicMatrix` |
| Keywords competitors target | Main keyword from each title, whether it's in title/H1/meta, secondary keywords | `lib/brief.js` → `buildKeywords` |
| **What competitors miss** | ✓ / ✗ for every competitor on the checks below | `lib/competitor-gaps.js` |

### What competitors miss (`lib/competitor-gaps.js`)

Runs on every new brief, right after the pages are read. It checks each compared page for:

- **Sections (18):** market size, drivers, restraints, opportunities, trends, macro impact,
  segmentation by type / application / end use, regional, pricing, value chain, regulation,
  investment, competitive landscape, recent developments, analyst view, methodology.
- **Data:** 2+ tables · 5+ key players listed · country-level detail (3+ countries).
- **Trust:** named analyst byline · visible update date · 2+ links to outside sources.
- **Freshness:** current forecast and updated in the last 12 months.
- **Figures:** base → forecast matches the stated CAGR.
- **Questions:** an FAQ with 3+ questions · FAQ markup · each People Also Ask question
  (answered if a heading or FAQ question on the page shares 60%+ of its words).

An item missing on **at least half** of the pages that could be checked is an opportunity. It shows up:

- in the **brief summary** box (top 6, plus People Also Ask questions nobody answers);
- inside the **skeleton section** it belongs to ("Competitors miss this — add it to beat them");
- as a **new H2** tagged "competitors miss it" when that section isn't in our format
  (Pricing, Value Chain, Trends, Tariffs/Policy/AI, Regulatory);
- at the top of the **FAQ list**, tagged "no competitor answers";
- in the **SEO details** grid (every item, highlighted rows = opportunities);
- in the Sheet's **Misses to work on** column.

Briefs saved before this check existed get a **basic** version (sections, tables, FAQs, freshness,
figures) when the Sheet fills them; generate the brief again for the full check.

---

## Tracking sheet (Apps Script)

`apps-script/Code.gs` is the source of truth, but it runs **inside the tracking Google Sheet**
(Extensions → Apps Script), deployed as a web app. The tool talks to it through `lib/storage.js`
using `STORAGE_WEBAPP_URL` + `STORAGE_SECRET`.

**On save**, it writes:
- the brief as a **Google Doc** and the data as **JSON** in the Drive folder;
- a row on **Briefs**, including:
  - **Misses to work on** — what competitors miss;
  - **Page 1 URLs (latest)**;
  - **Rank check status**;
- an **"At brief"** row on **Rank history** with our rank and each tracked competitor's rank and
  ranking URL.

**Every Monday** (time-driven trigger), for each brief with Track ranks = Yes, it calls
`stage: "ranks"`. The result goes on a new Rank history row (our rank, every tracked competitor's
rank + URL, page-1 URLs) and updates Latest rank, Change (▲ / ▼) and Rank check status on Briefs.

**Sheet menu → Ranking X-Ray:**
- **Check ranks now** — runs the weekly check immediately.
- **Fill misses for older briefs** — fills Misses to work on and Page 1 URLs for any brief where
  they're empty, via `stage: "summary"`.

**After any change to `Code.gs`:**
1. Paste it into the editor and press **Save**.
2. If you added columns or tracked competitors, run **setup**.
3. Go to **Deploy → Manage deployments**, click ✏️, choose **New version**, and click **Deploy**.

Saves only use the new code after step 3.

---

## Ranking X-Ray, Content Planner, Search Console

### Ranking X-Ray — `POST /api/analyze`

```json
{
  "url": "https://www.kingsresearch.com/report/plywood-market-3073",
  "keyword": "plywood market",
  "competitors": ["https://www.precedenceresearch.com/plywood-market"],
  "gscRefreshToken": "optional",
  "gscSiteUrl": "https://www.kingsresearch.com/",
  "gscDays": 90
}
```
- `url` (required) — our page. `keyword` is inferred from the H1/title if omitted.
- `competitors` (optional) — filtered to `COMPETITOR_SITES`; if omitted, the matching report is
  found on each site (Google `site:` search → URL guess → the site's own search page).
- Returns our page's X-ray and on-page score, one X-ray + weighted verdict per competitor,
  and Search Console quick wins when credentials are available.

**Link counting** covers the report body only: header, nav, footer, sidebars, related and
breadcrumb blocks are removed first. Per page: `inContentInternal`, `inContentExternal`
(listed with anchor + URL), `chromeLinkCount` (counted separately), `totalLinkCount`.

**Verdict weights (1–9):** content depth 9 · structured data 8 · in-content internal links 7 ·
authorship / E-E-A-T 7 · external citations 6 · FAQ / AI Overview coverage 6 ·
content-to-chrome ratio 5 · topical breadth 5 · data tables 4 · freshness / dates 4 ·
title length 3 · hreflang 2 · image alt 2.

### Content Planner — `POST /api/plan`

Paste a finished draft to get word and link targets, content gaps against the same fixed
competitors, meta tags, FAQs and JSON-LD before publishing.

### Search Console — `/bulk`

Three tools on one page (`/bulk#hreflang`, `/bulk#csv`, `/bulk#crawl`):

| Tool | APIs |
|---|---|
| Weekly hreflang report | `GET /api/sitemaps?url=…` lists child sitemaps with their language; `POST /api/hreflang-report` returns clicks, impressions, CTR and position per sitemap per week (`format: "csv"` for a download); also uses `/api/hreflang-assemble` |
| Bulk CSV metrics | `/api/bulk-compare` |
| Index status crawl | `/api/crawl` |

`GET /api/auth/start` → Google consent screen (Search Console, read-only);
`GET /api/auth/callback` returns the `refresh_token` to store as `GSC_REFRESH_TOKEN`.

---

## Setup

### 1. Vercel environment variables

| Variable | Needed for | |
|---|---|---|
| `SERPER_API_KEY` | Google results for every tool | **Required** (or `SERPAPI_KEY`) |
| `OPENAI_API_KEY` | Brief titles, H3s, FAQs; gap-analysis H3 wording; X-Ray AI tips | Recommended — briefs still work without it, with templates |
| `OPENAI_MODEL`, `OPENAI_BRIEF_MODEL` | Model choice (default `gpt-4o-mini`) | Optional |
| `SERPAPI_KEY` | Brief's main search, so it can show which sites Google's AI Overview cites | Optional, costs more per search |
| `SERP_DEFAULT_GL`, `SERP_DEFAULT_HL` | Default country / language | Optional (`us`, `en`) |
| `OUR_DOMAIN` | Spotting our own pages | Recommended (`kingsresearch.com`) |
| `STORAGE_WEBAPP_URL`, `STORAGE_SECRET` | Saving briefs to Drive + the Sheet; weekly rank checks | Recommended |
| `APP_URL` | "Open in tool" links in the Sheet | Recommended |
| `SCRAPER_API_URL` | Paid scraping service for sites that block Vercel (`{url}` placeholder) | Optional |
| `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, `GOOGLE_OAUTH_REDIRECT_URI`, `OAUTH_STATE_SECRET` | Search Console sign-in | For Search Console |
| `GSC_REFRESH_TOKEN`, `GSC_SITE_URL` | Search Console data in every tool (incl. the brief's existing-page check) | For Search Console |
| `GOOGLE_CSE_KEY`, `GOOGLE_CSE_CX` | Legacy fallback search — Google switches it off on 1 Jan 2027 | Not needed with Serper |

See `.env.example` for the full list with comments. Redeploy after changing variables.

### 2. Deploy

1. Push to GitHub → Vercel **New Project → import the repo**. No build step.
2. Add the environment variables, deploy, and check `https://<app>.vercel.app/api/health`.
3. Open `/brief` — a yellow banner lists anything still missing.

### 3. Search Console (OAuth)

1. Google Cloud Console → enable **Google Search Console API**.
2. Credentials → **OAuth client ID → Web application**; redirect URI
   `https://<app>.vercel.app/api/auth/callback`.
3. OAuth consent screen → add the Search Console user as a test user (or publish).
4. Put the client ID / secret in Vercel, visit `/api/auth/start`, approve, and save the returned
   `refresh_token` as `GSC_REFRESH_TOKEN`.

### 4. Tracking sheet

1. In the tracking Sheet: **Extensions → Apps Script**, paste `apps-script/Code.gs`, **Save**.
2. Run **setup** — it creates the sheets and columns, and shows the secret for `STORAGE_SECRET`.
3. **Deploy → New deployment → Web app** (execute as you, access: anyone with the link).
   Put the `/exec` URL in `STORAGE_WEBAPP_URL`.
4. The weekly trigger is created by setup; **Ranking X-Ray → Check ranks now** runs it on demand.

---

## Limits and things to know

- **60 seconds per call.** The brief is split into stages for this reason. A 504 on "collect"
  usually means slow competitor sites — try again, or paste those pages under "Competitor pages".
- **Search credits per brief:** the main search, ranks 11–20, a `site:` search for each tracked
  competitor not found in the top 20 (up to 6), plus the existing-page check. The weekly rank
  check uses 2 searches per tracked brief.
- **Bot protection.** Market-research sites often return HTTP 403 to servers. A blocked page is
  marked as blocked, never fails the brief, and can be pasted in by hand.
- **Figures are read from the first mentions on each page** and can pick the wrong number;
  the figure check flags rows that don't add up, and those are left out of the CAGR range.
- **Bing Search** was retired on 11 Aug 2025 and is no longer used. **Google Programmable
  Search** shuts down on 1 Jan 2027 — Serper / SerpApi replace it.

---

## File map

```
index.html          Ranking X-Ray (/)
brief.html          Content Brief (/brief) — form, skeleton builder, SEO tab, draft checker, export
planner.html        Content Planner (/planner)
bulk.html           Search Console tools (/bulk)
nav.js              shared four-tool menu + "Jump to" bar

api/brief.js        Content Brief: every stage (collect, write, gap, save, list, get, check, ranks, summary)
api/analyze.js      Ranking X-Ray
api/plan.js         Content Planner
api/sitemaps.js, api/hreflang-report.js, api/hreflang-assemble.js,
api/bulk-compare.js, api/crawl.js      Search Console tools
api/auth/…          Search Console OAuth

lib/brief.js            brief engine: tracked competitors, page reading, topic grid, keywords, benchmarks
lib/brief-checks.js     search intent, keyword check, stale data, figure check
lib/competitor-gaps.js  what competitors miss
lib/brief-ai.js         OpenAI writing for the brief and gap-analysis H3s
lib/gap-analysis.js     reads the research team's gap analysis
lib/draft-check.js      "Check my draft" scoring
lib/sheet-summary.js    what the tracking sheet shows per brief
lib/dupes.js            our existing pages for the keyword
lib/internal-links.js   related-report links from the sitemap
lib/storage.js          calls the Apps Script web app
lib/serp.js             Google results (Serper / SerpApi / legacy CSE)
lib/fetcher.js          page fetching with fallback routes
lib/xray.js             page X-ray (content, links, schema, headings, FAQs)
lib/competitors.js      X-Ray / Planner competitor list and report finder
lib/google-policy.js    Google policy baseline shown in briefs

apps-script/Code.gs     tracking Sheet + Drive storage (runs inside the Sheet)
vercel.json             function time limits, clean URLs, /api/health rewrite
.env.example            every environment variable, with comments
```

---

## Local dev

```bash
npm install
vercel dev                        # run the pages and API locally
npm run test:local                # live fetch (may 403 from your IP — that's the block, not a bug)
node scripts/test-fixtures.mjs    # full pipeline against saved real HTML
```
