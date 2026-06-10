# API call examples

## Health
```bash
curl https://YOUR-APP.vercel.app/api/health
```

## Analyze (auto-find competitors)
```bash
curl -X POST https://YOUR-APP.vercel.app/api/analyze \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://www.kingsresearch.com/report/plywood-market-3073",
    "keyword": "plywood market"
  }'
```

## Analyze with manual competitor URLs (still restricted to the 4 fixed sites)
```bash
curl -X POST https://YOUR-APP.vercel.app/api/analyze \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://www.kingsresearch.com/report/plywood-market-3073",
    "keyword": "plywood market",
    "competitors": [
      "https://www.precedenceresearch.com/plywood-market",
      "https://www.marketsandmarkets.com/Market-Reports/plywood-market-233250253.html",
      "https://www.marketresearchfuture.com/reports/plywood-market-10362",
      "https://www.futuremarketinsights.com/reports/plywood-market"
    ]
  }'
```

## Analyze with GSC quick-wins
```bash
# 1. Authorize once:
#    open https://YOUR-APP.vercel.app/api/auth/start  -> copy refresh_token
# 2. Pass it in:
curl -X POST https://YOUR-APP.vercel.app/api/analyze \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://www.kingsresearch.com/report/plywood-market-3073",
    "keyword": "plywood market",
    "gscRefreshToken": "1//0g...",
    "gscSiteUrl": "https://www.kingsresearch.com/",
    "gscDays": 90
  }'
```
