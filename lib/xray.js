// lib/xray.js
// Deep source-level X-ray of a page. Isolates the main report container,
// separates in-content links (internal + external) from site chrome
// (nav/menu/sidebar/footer), and captures SEO signals from the source.

import * as cheerio from "cheerio";

const CHROME_TAGS = ["header", "nav", "footer", "aside"];
const CHROME_HINTS =
  /(nav|menu|header|footer|sidebar|side-bar|breadcrumb|cookie|banner|mega|drawer|topbar|navbar|related|also-read|recommend|widget|promo|subscribe|newsletter|social|share|popup|modal|offcanvas|skip-link)/i;
const MAIN_HINTS =
  /(report|article|content|main|body|description|overview|post|entry|market|insight|analysis|prose)/i;

// Cross-sell / navigation widgets that must be stripped even when their class
// ALSO contains a "report"/"market" hint (e.g. "related-reports") — otherwise
// their links and text are wrongly counted as editorial content.
const STRONG_CHROME =
  /(related|recommend|also[-_ ]?(read|like|view)|you[-_ ]?may|more[-_ ]?(report|article|news|stor)|similar|popular|trending|top[-_ ]?(report|stor|search)|other[-_ ]?report|cross[-_ ]?sell|upsell|read[-_ ]?more|region[-_ ]?(select|drop|switch|list|nav)|country[-_ ]?(select|drop|switch|list)|lang(uage)?[-_ ]?(select|switch|drop|nav|bar)|translat|hreflang|\bcta\b|sample[-_ ]?(form|request|cta|btn)|enquir|inquir|subscribe|newsletter|tag[-_ ]?cloud|pagination|report[-_ ]?tabs?|tabs?[-_ ]?(nav|list|wrap|bar))/i;

// Internal paths that are transactional / utility / cross-promo, never editorial.
const NON_EDITORIAL_PATH =
  /\/(sample[_-]?request|request[_-]?sample|free[_-]?sample|sample|checkout|buy[_-]?now|buy|cart|order|request[_-]?quote|get[_-]?quote|enquir\w*|inquir\w*|contact(?:[-_]us)?|login|sign[-_]?in|register|sign[-_]?up|subscribe|newsletter|pricing|payment|discount|speak[-_]?to[-_]?\w+|talk[-_]?to[-_]?\w+|ask[-_]?an[-_]?analyst|customi[sz]ation|customi[sz]e|brochure|infographics?|press[-_]?releases?|case[-_]?stud\w*)(?:[/?#]|$)/i;

// Two-letter language path prefixes used for translated alternates of a page.
const LANG_PREFIX = new Set(
  "de fr ja es zh ko pt it ru ar nl pl tr sv da fi no cs el he hi th vi id ms ro hu bg hr sk sl lt lv et fa".split(" ")
);

function firstSeg(pathname) {
  const p = pathname.split("/").filter(Boolean);
  return p.length ? p[0].toLowerCase() : "";
}

// A link is "editorial" only if it sits inside real prose: its nearest block has
// substantially more text than the anchor itself. Related-report, region-variant
// and language-switcher entries are link-only (block text ≈ anchor) and are
// rejected; links embedded in sentences/paragraphs/table cells are kept.
function isProseLink($, el) {
  const $a = $(el);
  const anchorLen = $a.text().trim().length || 1;
  const $block = $a.closest("p, li, td, th, blockquote, figcaption, dd");
  if ($block.length) {
    const blockLen = $block.text().trim().length;
    return blockLen >= anchorLen * 2 && blockLen >= 60;
  }
  // Loose inside a div/span: only prose if the surrounding block carries real text.
  const $div = $a.closest("div, section, span");
  if ($div.length) {
    const dLen = $div.text().trim().length;
    return dLen >= anchorLen * 4 && dLen >= 120;
  }
  return false;
}

function identOf($, el) {
  const id = $(el).attr("id") || "";
  const cls = $(el).attr("class") || "";
  return `${id} ${cls}`.trim();
}

function pickMain($) {
  // strip non-content tags globally
  $("script, style, noscript, svg, head").remove();
  const body = $("body").length ? $("body") : $.root();

  // prefer semantic main/article with real text
  for (const sel of ["main", "article"]) {
    const node = body.find(sel).first();
    if (node.length && node.text().trim().length > 400) return node;
  }

  // otherwise score containers
  let best = body,
    bestScore = -1;
  body.find("div, section").each((_, el) => {
    const $el = $(el);
    const txtLen = $el.text().trim().length;
    if (txtLen < 400) return;
    const ident = identOf($, el);
    let score = txtLen / 1000;
    if (MAIN_HINTS.test(ident)) score += 5;
    if (CHROME_HINTS.test(ident)) score -= 8;
    if (score > bestScore) {
      bestScore = score;
      best = $el;
    }
  });
  return best;
}

function stripChrome($, $main) {
  CHROME_TAGS.forEach((t) => $main.find(t).remove());
  $main.find("div, section, ul, ol, aside, nav").each((_, el) => {
    const ident = identOf($, el);
    if (!ident) return;
    // Cross-sell/region/language/CTA widgets go even if they say "report"/"market".
    if (STRONG_CHROME.test(ident)) { $(el).remove(); return; }
    if (CHROME_HINTS.test(ident) && !MAIN_HINTS.test(ident)) $(el).remove();
  });
}

function domainOf(u) {
  try {
    return new URL(u).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

export function xray(url, status, html) {
  const baseDom = domainOf(url);
  const out = {
    url,
    domain: baseDom,
    status,
    fetched: false,
    title: "",
    titleLen: 0,
    metaDesc: "",
    metaDescLen: 0,
    canonical: "",
    robots: "",
    ogCount: 0,
    twitterCount: 0,
    hreflangCount: 0,
    totalDomNodes: 0,
    contentWords: 0,
    totalWords: 0,
    contentRatio: 0,
    inContentInternal: [],
    inContentExternal: [],
    inContentInternalRaw: 0,
    inContentExternalRaw: 0,
    chromeLinkCount: 0,
    totalLinkCount: 0,
    headingTree: [],
    hCounts: {},
    paragraphs: 0,
    tables: 0,
    lists: 0,
    listItems: 0,
    faqCount: 0,
    faqQuestions: [],
    schemaFaqCount: 0,
    schemaBlocks: [],
    schemaDetail: [],
    h1List: [],
    hasFaqPage: false,
    hasArticle: false,
    hasBreadcrumb: false,
    hasDataset: false,
    images: 0,
    imagesNoAlt: 0,
    hasAuthor: false,
    hasReviewer: false,
    hasDates: false,
  };

  if (status !== 200 || !html) return out;
  out.fetched = true;
  const $ = cheerio.load(html);

  // ---- meta (from full doc, before mutation) ----
  out.title = ($("title").first().text() || "").trim();
  out.titleLen = out.title.length;
  $("meta").each((_, el) => {
    const name = (
      $(el).attr("name") ||
      $(el).attr("property") ||
      ""
    ).toLowerCase();
    const content = ($(el).attr("content") || "").trim();
    if (name === "description") { out.metaDesc = content; out.metaDescLen = content.length; }
    else if (name === "robots") out.robots = content;
    else if (name.startsWith("og:")) out.ogCount++;
    else if (name.startsWith("twitter:")) out.twitterCount++;
  });
  out.canonical = $('link[rel="canonical"]').first().attr("href") || "";
  out.hreflangCount = $('link[rel="alternate"][hreflang]').length;

  // ---- schema (supports @graph) ----
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const data = JSON.parse($(el).contents().text() || "{}");
      const blocks = Array.isArray(data) ? data : [data];
      blocks.forEach((b) => {
        const graph = b["@graph"] || [b];
        (Array.isArray(graph) ? graph : [graph]).forEach((g) => {
          const t = g["@type"];
          const types = Array.isArray(t) ? t : [t];
          // Full detail record for this schema block
          const detail = {
            type: types.filter(Boolean).join(" + ") || "(untyped)",
            props: Object.keys(g).filter((k) => !k.startsWith("@")).slice(0, 14),
          };
          if (g["@type"] === "FAQPage" && Array.isArray(g.mainEntity)) {
            detail.faqItems = g.mainEntity.length;
            // Authoritative FAQ count straight from schema (most reliable).
            out.schemaFaqCount = Math.max(out.schemaFaqCount || 0, g.mainEntity.length);
            // Capture actual question text so the AI can dedupe suggestions.
            out.faqQuestions = (out.faqQuestions || []).concat(
              g.mainEntity
                .map((q) => (q && q.name ? String(q.name).trim() : ""))
                .filter(Boolean)
            );
          }
          if (g.author)
            detail.author = typeof g.author === "object" ? g.author.name : g.author;
          if (g.datePublished) detail.datePublished = g.datePublished;
          if (g.dateModified) detail.dateModified = g.dateModified;
          out.schemaDetail.push(detail);
          types.forEach((tt) => {
            if (!tt) return;
            out.schemaBlocks.push(tt);
            const tl = String(tt).toLowerCase();
            if (tl === "faqpage") out.hasFaqPage = true;
            else if (tl.includes("article")) out.hasArticle = true;
            else if (tl === "breadcrumblist") out.hasBreadcrumb = true;
            else if (tl === "dataset") out.hasDataset = true;
          });
          if (g.author) out.hasAuthor = true;
          if (g.reviewedBy || g.review) out.hasReviewer = true;
          if (g.datePublished || g.dateModified) out.hasDates = true;
        });
      });
    } catch {
      /* ignore malformed JSON-LD */
    }
  });

  // H1s collected DOCUMENT-WIDE (hero H1s often sit outside the content div)
  out.h1List = [];
  $("h1").each((_, el) => {
    const t = $(el).text().trim();
    if (t) out.h1List.push(t);
  });

  out.totalDomNodes = $("*").length;
  out.totalWords = wordCount($.root().text());
  out.totalLinkCount = $("a[href]").length;

  // ---- isolate main content ----
  const $main = pickMain($);
  stripChrome($, $main);
  const mainText = $main.text();
  out.contentWords = wordCount(mainText);
  out.contentRatio = out.totalWords
    ? +(out.contentWords / out.totalWords).toFixed(3)
    : 0;

  for (let lvl = 1; lvl <= 6; lvl++) {
    const nodes = $main.find(`h${lvl}`);
    out.hCounts[`h${lvl}`] = nodes.length;
    nodes.each((_, el) => {
      const t = $(el).text().trim();
      if (t) out.headingTree.push([lvl, t]);
    });
  }
  out.paragraphs = $main.find("p").length;
  out.tables = $main.find("table").length;
  out.lists = $main.find("ul, ol").length;
  out.listItems = $main.find("li").length;

  // FAQ detection
  const qMatches = mainText.match(/\b(what|which|how|who|why|when)\b[^?]{6,180}\?/gi) || [];
  // FAQ count priority: (1) FAQPage schema mainEntity (authoritative),
  // (2) visible accordion question blocks, (3) regex on "?" text.
  const accordionQs = $("[id*='faq'] [class*='rf5'], #faq-section [class*='question'], .faq-question").length;
  if (out.schemaFaqCount && out.schemaFaqCount > 0) {
    out.faqCount = out.schemaFaqCount;
  } else if (accordionQs >= 3) {
    out.faqCount = accordionQs;
  } else if (/frequently asked/i.test(mainText)) {
    out.faqCount = qMatches.length;
  }
  if (out.hasFaqPage && out.faqCount === 0) out.faqCount = qMatches.length;

  // images in content
  const imgs = $main.find("img");
  out.images = imgs.length;
  out.imagesNoAlt = imgs.filter((_, i) => !($(i).attr("alt") || "").trim()).length;

  // ---- LINK X-RAY (content only) — count GENUINE editorial links ----
  // Many report pages pack the article container with translated alternates,
  // "Request Sample"/"Contact" CTAs, same-report tab sub-pages, and big
  // "related / regional reports" link lists. None are editorial links, so they
  // must not inflate the competitor benchmark. We keep only links that are
  // (a) not a translated alternate, (b) not a transactional/utility path,
  // (c) not a tab sub-page of THIS report, and (d) genuinely embedded in prose —
  // then de-duplicate by URL.
  const curPath = (() => { try { return new URL(url).pathname.replace(/\/+$/, ""); } catch { return ""; } })();
  const curBase = curPath.replace(/-\d+$/, ""); // strip trailing numeric report id
  const seenInternal = new Set();
  const seenExternal = new Set();
  let internalRaw = 0, externalRaw = 0;

  $main.find("a[href]").each((_, el) => {
    let href = ($(el).attr("href") || "").trim();
    if (
      !href ||
      href.startsWith("#") ||
      href.startsWith("mailto:") ||
      href.startsWith("tel:") ||
      href.startsWith("javascript:")
    )
      return;
    let u;
    try { u = new URL(href, url); } catch { return; }
    const full = u.href;
    const dom = domainOf(full);
    const isInternal = dom === baseDom || dom === "";
    const anchor = ($(el).text().trim() || "(no anchor)").slice(0, 90);

    if (isInternal) {
      internalRaw++;
      const path = u.pathname.replace(/\/+$/, "");
      if (path === curPath) return;                                   // self link
      if (path.startsWith(curPath + "/") ||
          (curBase && curBase !== curPath && path.startsWith(curBase + "/"))) return; // same-report tab
      if (LANG_PREFIX.has(firstSeg(u.pathname))) return;              // translated alternate
      if (NON_EDITORIAL_PATH.test(u.pathname)) return;                // CTA / utility / cross-promo
      if (!isProseLink($, el)) return;                                // related/region list item, button, card
      if (seenInternal.has(full)) return;                            // duplicate
      seenInternal.add(full);
      out.inContentInternal.push({ anchor, href: full });
    } else {
      externalRaw++;
      if (!isProseLink($, el)) return;
      if (seenExternal.has(full)) return;
      seenExternal.add(full);
      out.inContentExternal.push({ anchor, href: full });
    }
  });

  out.inContentInternalRaw = internalRaw;
  out.inContentExternalRaw = externalRaw;
  const inContentTotal =
    out.inContentInternal.length + out.inContentExternal.length;
  out.chromeLinkCount = Math.max(0, out.totalLinkCount - inContentTotal);

  // text fallbacks for E-E-A-T
  const low = html.toLowerCase();
  if (!out.hasAuthor && (low.includes("author") || low.includes("written by")))
    out.hasAuthor = true;
  if (!out.hasReviewer && low.includes("reviewed by")) out.hasReviewer = true;
  if (!out.hasDates && (low.includes("last updated") || low.includes("published")))
    out.hasDates = true;

  return out;
}

function wordCount(text) {
  return (text || "").trim().split(/\s+/).filter(Boolean).length;
}
