// api/sitemaps.js
// GET /api/sitemaps?url=https://www.kingsresearch.com/sitemap.xml
//
// Server-side fetch (no CORS problems) of a sitemap index. Returns the child
// sitemaps with an inferred hreflang/language label so the UI can render a
// selectable list. If the URL is a plain <urlset> (not an index), it is
// returned as a single selectable entry.

import { fetchSitemap, detectLang } from "../lib/sitemaps.js";

export async function GET(request) {
  const u = new URL(request.url);
  const target = (u.searchParams.get("url") || "").trim();
  if (!/^https?:\/\//i.test(target)) {
    return json({ error: "Pass a sitemap URL: /api/sitemaps?url=https://site.com/sitemap.xml" }, 400);
  }

  const parsed = await fetchSitemap(target);
  if (!parsed.ok) {
    return json({
      error: `Could not read sitemap (${parsed.error || "unknown error"}).`,
      status: parsed.status,
      hint: "Check the URL is a public XML sitemap. Gzip-only sitemaps are not supported.",
    }, 502);
  }

  if (parsed.kind === "urlset") {
    return json({
      source: target,
      kind: "urlset",
      note: "This is a flat urlset, not an index — selectable as one sitemap.",
      sitemaps: [{ loc: target, lastmod: null, lang: detectLang(target), urlCount: parsed.urls.length }],
    });
  }

  return json({
    source: target,
    kind: "index",
    count: parsed.sitemaps.length,
    sitemaps: parsed.sitemaps.map((s) => ({
      loc: s.loc,
      lastmod: s.lastmod,
      lang: detectLang(s.loc),
    })),
  });
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
