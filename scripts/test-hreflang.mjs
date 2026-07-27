// scripts/test-hreflang.mjs
// Offline end-to-end test of /api/hreflang-report: mocks the sitemap fetches
// and the Google OAuth + Search Console APIs, then checks the per-sitemap
// per-week roll-ups (clicks sum, impressions sum, CTR, weighted position).
// Run: node scripts/test-hreflang.mjs

const SITEMAP_EN = `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
<url><loc>https://www.kingsresearch.com/report/a</loc></url>
<url><loc>https://www.kingsresearch.com/report/b</loc></url></urlset>`;
const SITEMAP_JA = `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
<url><loc>https://www.kingsresearch.com/ja/report/a</loc></url></urlset>`;

// GSC page rows per week window (keyed by startDate)
const GSC_WEEKS = {
  "2026-07-06": [
    { keys: ["https://www.kingsresearch.com/report/a"], clicks: 10, impressions: 100, ctr: 0.10, position: 5 },
    { keys: ["https://www.kingsresearch.com/report/b"], clicks: 30, impressions: 300, ctr: 0.10, position: 9 },
    { keys: ["https://www.kingsresearch.com/ja/report/a"], clicks: 2, impressions: 50, ctr: 0.04, position: 20 },
  ],
  "2026-07-13": [
    { keys: ["https://www.kingsresearch.com/report/a"], clicks: 20, impressions: 200, ctr: 0.10, position: 4 },
    // report/b drops out this week; ja gains
    { keys: ["https://www.kingsresearch.com/ja/report/a"], clicks: 8, impressions: 80, ctr: 0.10, position: 12 },
  ],
};

globalThis.fetch = async (input, init = {}) => {
  const url = String(input);
  const ok = (obj, type = "application/json") =>
    new Response(typeof obj === "string" ? obj : JSON.stringify(obj), { status: 200, headers: { "Content-Type": type } });

  if (url.includes("sitemap-en")) return ok(SITEMAP_EN, "application/xml");
  if (url.includes("sitemap-ja")) return ok(SITEMAP_JA, "application/xml");
  if (url.includes("oauth2.googleapis.com/token")) return ok({ access_token: "fake" });
  if (url.includes("searchAnalytics/query")) {
    const body = JSON.parse(init.body);
    if ((body.startRow || 0) > 0) return ok({ rows: [] });
    return ok({ rows: GSC_WEEKS[body.startDate] || [] });
  }
  throw new Error("Unexpected fetch: " + url);
};

const { POST } = await import("../api/hreflang-report.js");

const res = await POST(new Request("http://local/api/hreflang-report", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    sitemaps: [
      "https://www.kingsresearch.com/sitemap-en.xml",
      "https://www.kingsresearch.com/sitemap-ja.xml",
    ],
    weeks: [
      { label: "Week 2 · Jul 6 – Jul 12", startDate: "2026-07-06", endDate: "2026-07-12" },
      { label: "Week 3 · Jul 13 – Jul 19", startDate: "2026-07-13", endDate: "2026-07-19" },
    ],
    gscSiteUrl: "https://www.kingsresearch.com/",
    gscRefreshToken: "fake-refresh",
  }),
}));

const data = await res.json();
let pass = 0, fail = 0;
const eq = (name, got, want) => {
  const okv = JSON.stringify(got) === JSON.stringify(want);
  okv ? pass++ : fail++;
  console.log((okv ? "  ✓ " : "  ✗ ") + name + (okv ? "" : ` — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`));
};

console.log("status:", res.status);
const en = data.sitemaps.find((s) => s.sitemap.includes("-en"));
const ja = data.sitemaps.find((s) => s.sitemap.includes("-ja"));

eq("EN sitemap urlCount", en.urlCount, 2);
eq("EN wk1 clicks (10+30)", en.weeks[0].clicks, 40);
eq("EN wk1 impressions", en.weeks[0].impressions, 400);
eq("EN wk1 CTR", en.weeks[0].ctr, 10);
// weighted position: (5*100 + 9*300)/400 = 8.0
eq("EN wk1 weighted position", en.weeks[0].position, 8);
eq("EN wk2 clicks (b dropped)", en.weeks[1].clicks, 20);
eq("EN wk2 matchedUrls", en.weeks[1].matchedUrls, 1);
eq("JA wk1 clicks", ja.weeks[0].clicks, 2);
eq("JA wk2 position", ja.weeks[1].position, 12);
eq("JA lang label", ja.lang.label, "Japanese");
eq("grand wk1 clicks", data.grandTotals[0].clicks, 42);
eq("grand wk1 impressions", data.grandTotals[0].impressions, 450);
eq("urls with data", data.totals.urlsWithData, 3);

// CSV path
const res2 = await POST(new Request("http://local/api/hreflang-report", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    sitemaps: ["https://www.kingsresearch.com/sitemap-en.xml"],
    weeks: [{ label: "W2", startDate: "2026-07-06", endDate: "2026-07-12" }],
    gscSiteUrl: "https://www.kingsresearch.com/",
    gscRefreshToken: "fake-refresh",
    format: "csv",
  }),
}));
const csv = await res2.text();
eq("CSV header", csv.split("\r\n")[0].startsWith("Sitemap,Language,URL,Week"), true);
eq("CSV has rollup row", csv.includes("(all URLs in sitemap)"), true);
eq("CSV has per-URL row", csv.includes("report/a,W2"), true);


// XLSX path
const res3 = await POST(new Request("http://local/api/hreflang-report", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    sitemaps: ["https://www.kingsresearch.com/sitemap-en.xml", "https://www.kingsresearch.com/sitemap-ja.xml"],
    weeks: [
      { label: "Week 2 · Jul 6 – Jul 12", startDate: "2026-07-06", endDate: "2026-07-12" },
      { label: "Week 3 · Jul 13 – Jul 19", startDate: "2026-07-13", endDate: "2026-07-19" },
    ],
    gscSiteUrl: "https://www.kingsresearch.com/",
    gscRefreshToken: "fake-refresh",
    format: "xlsx",
  }),
}));
eq("XLSX status", res3.status, 200);
eq("XLSX content-type", res3.headers.get("Content-Type"),
   "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
const buf = Buffer.from(await res3.arrayBuffer());
eq("XLSX magic bytes (PK zip)", buf.slice(0, 2).toString(), "PK");
eq("XLSX non-trivial size", buf.length > 5000, true);
const { writeFileSync } = await import("node:fs");
writeFileSync("/tmp/e2e-report.xlsx", buf);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
