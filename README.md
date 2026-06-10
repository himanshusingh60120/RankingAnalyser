# SEO Deep X-Ray API

API-only service (deploys to Vercel) that does a **source-level X-ray** of a page,
auto-finds the matching report on **four fixed market-research competitors**,
and returns a weighted **ranking verdict** explaining why each competitor likely
outranks you. Optional Google Search Console integration via OAuth.

Recommendations align to the current **Google May 2026 core update** (Gemini-based
quality models): original people-first depth, credible authorship / E-E-A-T,
topical authority, and AI-Overview readiness.

## Fixed competitor set
Only these four sites are cross-checked (as specified):
- marketresearchfuture.com
- futuremarketinsights.com
- marketsandmarkets.com
- precedenceresearch.com

---

## Endpoints

### `GET /api/health`
Liveness + the locked competitor list.

### `POST /api/analyze`
Body:
```json
{
  "url": "https://www.kingsresearch.com/report/plywood-market-3073",
  "keyword": "plywood market",
  "competitors": ["https://www.precedenceresearch.com/plywood-market"],
  "gscRefreshToken": "optional-from-oauth",
  "gscSiteUrl": "https://www.kingsresearch.com/",
  "gscDays": 90
}
```
- `url` (required) — your page.
- `keyword` (optional) — inferred from H1/title if omitted.
- `competitors` (optional) — manual override; filtered to the four fixed
  domains. If omitted, the matching report is auto-found on each fixed site.
- `gscRefreshToken` + `gscSiteUrl` (optional) — enables GSC quick-win analysis.

Returns: target X-ray + on-page score + findings, one X-ray + weighted verdict
per fixed competitor (with every in-content link listed verbatim, chrome links
separated), and GSC findings if credentials supplied.

### `GET /api/auth/start`
Redirects to Google's consent screen for Search Console (read-only).

### `GET /api/auth/callback`
Handles the OAuth redirect, returns a `refresh_token`. Store it and pass it to
`/api/analyze` as `gscRefreshToken`.

---

## Link X-ray method (the important part)
Link counts cover the **report body only**. The parser isolates the main content
container, then removes site chrome (`header`, `nav`, `footer`, `aside`, plus any
element whose id/class matches nav/menu/sidebar/footer/related/breadcrumb/etc).

It reports, per page:
- `inContentInternal` — contextual internal links inside the report (listed: anchor + URL)
- `inContentExternal` — outbound citations inside the report (listed: anchor + URL)
- `chromeLinkCount` — nav/sidebar/footer links, counted separately, **never** mixed in
- `totalLinkCount` — for reference

## Ranking-verdict factors (weighted 1–9)
content depth (9) · structured data / schema (8) · in-content internal links (7) ·
authorship & E-E-A-T (7) · external citations (6) · FAQ / AI-Overview coverage (6) ·
content-to-chrome ratio (5) · topical breadth (5) · data tables (4) ·
freshness/dates (4) · title length (3) · hreflang (2) · image alt (2)

---

## Deploy to Vercel

1. Push this repo to GitHub.
2. In Vercel: **New Project → import the repo**. No build step; Vercel detects
   the `api/` functions automatically.
3. Set environment variables (Project → Settings → Environment Variables):
   see `.env.example`. At minimum, for GSC:
   - `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`
   - `GOOGLE_OAUTH_REDIRECT_URI` = `https://<your-app>.vercel.app/api/auth/callback`
   - `OAUTH_STATE_SECRET` = any long random string
   - (recommended) `GOOGLE_CSE_KEY` + `GOOGLE_CSE_CX` **or** `BING_SEARCH_KEY`
     for reliable competitor auto-find.
4. Deploy. Test: `GET https://<your-app>.vercel.app/api/health`.

### Google Cloud / OAuth setup (for GSC)
1. Google Cloud Console → new project → enable **Google Search Console API**.
2. **Credentials → Create OAuth client ID → Web application.**
3. Authorized redirect URI: `https://<your-app>.vercel.app/api/auth/callback`.
4. OAuth consent screen → add `hsingh@kingsresearch.com` as a test user (or
   publish). That account must have access to the kingsresearch.com property in
   Search Console.
5. Copy client ID/secret into Vercel env vars.
6. Visit `https://<your-app>.vercel.app/api/auth/start`, approve, copy the
   returned `refresh_token`, and pass it to `/api/analyze`.

### Competitor auto-find (recommended setup)
Without a search provider, the service falls back to scraping each competitor's
on-site search page, which is brittle. For reliable matching, set up **Google
Programmable Search** (create an engine that searches the whole web, get the
`cx` and an API key) or a **Bing Web Search** key, and add them as env vars.
Or skip auto-find entirely and pass exact `competitors` URLs in the request.

---

## A note on bot protection
These market-research sites return **HTTP 403** to non-browser clients. The
fetcher sends full browser headers and retries, which clears simple UA-based
blocks when requests originate from Vercel's servers. If a specific site still
blocks Vercel's datacenter IPs, the response marks that competitor
`fetched: false, blocked: true` rather than failing the whole request — and you
can pass that competitor's URL via a proxy/rendering service if needed. The
analysis logic is fully verified against real page HTML.

## Local dev
```bash
npm install
npm run test:local      # live fetch (may 403 from your IP — that's the block, not a bug)
node scripts/test-fixtures.mjs   # full pipeline against saved real HTML
vercel dev              # run the API locally
```
