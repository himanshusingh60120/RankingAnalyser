// scripts/test-chunked.mjs
// Verifies the free-tier chunked mode: per-language partial requests store
// slices in a mocked KV, then assemble rebuilds the combined report. Also
// checks the GSC query is scoped per language (page filter applied).
// Run: node scripts/test-chunked.mjs

// ---- in-memory KV (Upstash REST shape) ----
const store = new Map(), lists = new Map();
function handle(cmd) {
  const [op, key, ...rest] = cmd;
  switch (op) {
    case "SET": {
      store.set(key, rest[0]); return "OK"; }
    case "GET": return store.has(key) ? store.get(key) : null;
    case "DEL": return store.delete(key) ? 1 : 0;
    case "MGET": return [key, ...rest].map((k) => (store.has(k) ? store.get(k) : null));
    case "LPUSH": { const l = lists.get(key) || []; l.unshift(rest[0]); lists.set(key, l); return l.length; }
    case "LRANGE": { const l = lists.get(key) || []; let [a, b] = [Number(rest[0]), Number(rest[1])]; if (b === -1) b = l.length - 1; return l.slice(a, b + 1); }
    default: throw new Error("unhandled " + op);
  }
}
process.env.KV_REST_API_URL = "https://mock-kv";
process.env.KV_REST_API_TOKEN = "mock";

// ---- fake sitemaps + GSC; capture GSC filters to prove per-language scoping ----
const seenFilters = [];
const enUrls = ["https://www.kingsresearch.com/report/a", "https://www.kingsresearch.com/report/b"];
const frUrls = ["https://www.kingsresearch.com/fr/report/a", "https://www.kingsresearch.com/fr/report/b", "https://www.kingsresearch.com/fr/report/c"];
const urlset = (u) => `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${u.map((x) => `<url><loc>${x}</loc></url>`).join("")}</urlset>`;

globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  const ok = (o, t = "application/json") => new Response(typeof o === "string" ? o : JSON.stringify(o), { status: 200, headers: { "Content-Type": t } });
  if (u.includes("mock-kv")) {
    const body = JSON.parse(init.body);
    if (u.endsWith("/pipeline")) return ok(body.map((c) => ({ result: handle(c) })));
    return ok({ result: handle(body) });
  }
  if (u.includes("/fr/sitemap-reports")) return ok(urlset(frUrls), "application/xml");
  if (u.includes("sitemap-reports")) return ok(urlset(enUrls), "application/xml");
  if (u.includes("oauth2.googleapis.com/token")) return ok({ access_token: "fake" });
  if (u.includes("searchAnalytics/query")) {
    const b = JSON.parse(init.body);
    seenFilters.push(JSON.stringify(b.dimensionFilterGroups || []));
    if ((b.startRow || 0) > 0) return ok({ rows: [] });
    // return data only for the URLs that match the page filter (simulate scoping)
    const grp = (b.dimensionFilterGroups || [])[0];
    const isFr = grp && JSON.stringify(grp).includes("/fr/");
    const rows = (isFr ? frUrls : enUrls).slice(0, 2).map((url, i) => ({ keys: [url], clicks: i + 1, impressions: (i + 1) * 10, ctr: 0.1, position: 5 }));
    return ok({ rows });
  }
  throw new Error("unexpected " + u);
};

let pass = 0, fail = 0;
const eq = (n, g, w) => { const ok = JSON.stringify(g) === JSON.stringify(w); ok ? pass++ : fail++; console.log((ok ? "  ✓ " : "  ✗ ") + n + (ok ? "" : ` — got ${JSON.stringify(g)}, want ${JSON.stringify(w)}`)); };
const req = (b) => new Request("http://local", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) });

const { POST: REPORT } = await import("../api/hreflang-report.js");
const { POST: ASSEMBLE } = await import("../api/hreflang-assemble.js");

const sessionId = "testsess1";
const weeks = [{ label: "W1", startDate: "2026-07-06", endDate: "2026-07-12" }];
const creds = { gscSiteUrl: "https://www.kingsresearch.com/", gscRefreshToken: "fake" };

// English pass
let r = await REPORT(req({ sitemaps: ["https://www.kingsresearch.com/sitemap-reports.xml"], weeks, ...creds, partial: true, sessionId, langCode: "x-default" }));
let d = await r.json();
eq("EN partial ok", d.partial, true);
eq("EN language reported", d.languages[0].label, "English");
eq("EN urls in sitemap", d.languages[0].urlsInSitemap, 2);

// French pass
r = await REPORT(req({ sitemaps: ["https://www.kingsresearch.com/fr/sitemap-reports.xml"], weeks, ...creds, partial: true, sessionId, langCode: "fr" }));
d = await r.json();
eq("FR partial ok", d.partial, true);
eq("FR urls in sitemap", d.languages[0].urlsInSitemap, 3);

// per-language GSC scoping applied
eq("EN query used excludingRegex", seenFilters[0].includes("excludingRegex"), true);
eq("FR query used includingRegex /fr/", seenFilters[1].includes("includingRegex") && seenFilters[1].includes("/fr/"), true);

// assemble JSON
r = await ASSEMBLE(req({ sessionId }));
d = await r.json();
eq("assemble sitemaps=2 langs", d.sitemaps.length, 2);
eq("assemble total urls", d.totals.urlsInSitemaps, 5);
eq("assemble labels", d.sitemaps.map((s) => s.lang.label).sort(), ["English", "French"]);

// assemble XLSX
r = await ASSEMBLE(req({ sessionId, format: "xlsx" }));
eq("assemble xlsx status", r.status, 200);
const buf = Buffer.from(await r.arrayBuffer());
eq("assemble xlsx is zip", buf.slice(0, 2).toString(), "PK");
eq("assemble xlsx non-trivial", buf.length > 4000, true);

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
