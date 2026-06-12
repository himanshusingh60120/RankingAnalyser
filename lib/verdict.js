// lib/verdict.js
// Produces a weighted ranking verdict: the concrete reasons a competitor page
// is likely outranking the target. Weights (1-9) reflect how strongly each
// factor moves rankings under the current Google core update (May 2026,
// Gemini-based quality models): depth, E-E-A-T, structured data, topical
// authority, AI-Overview readiness.

export function rankingVerdict(target, comp, contentType = "report") {
  const isBlog = contentType === "blog";
  const reasons = [];
  const add = (weight, factor, detail) =>
    reasons.push({ weight, factor, detail });

  if (!comp.fetched) return { reasons: [], compAdvantages: [], targetAdvantages: [] };

  if (comp.contentWords > target.contentWords * 1.15) {
    add(
      9,
      "Content depth",
      `${comp.contentWords} content words vs your ${target.contentWords} (+${
        comp.contentWords - target.contentWords
      }). Deeper, more complete coverage reads as more helpful.`
    );
  }
  if (comp.contentRatio > target.contentRatio + 0.05) {
    add(
      5,
      "Content-to-chrome ratio",
      `${Math.round(comp.contentRatio * 100)}% of their page is real content vs ${Math.round(
        target.contentRatio * 100
      )}% of yours — leaner template, stronger main-content signal.`
    );
  }
  const ti = target.inContentInternal.length;
  const ci = comp.inContentInternal.length;
  if (ci > ti + 2) {
    add(
      7,
      "In-content internal links",
      `${ci} contextual internal links inside the report vs your ${ti}. Distributes topical authority and deepens crawl paths.`
    );
  }
  const te = target.inContentExternal.length;
  const ce = comp.inContentExternal.length;
  if (ce > te + 1) {
    add(
      6,
      "External citations",
      `${ce} outbound citations to sources vs your ${te}. Citing authoritative sources is a trust / E-E-A-T signal.`
    );
  }
  const compSchema = new Set(comp.schemaBlocks.map((s) => String(s).toLowerCase()));
  const tgtSchema = new Set(target.schemaBlocks.map((s) => String(s).toLowerCase()));
  const missing = [...compSchema].filter((s) => !tgtSchema.has(s));
  if (missing.length) {
    add(
      8,
      "Structured data",
      `They ship schema you lack: ${missing.join(", ")}. FAQPage / Article / Dataset drive rich results and AI Overviews.`
    );
  }
  if (comp.faqCount > target.faqCount + 1) {
    // FAQ matters much less for blogs than for report pages.
    add(
      isBlog ? 3 : 6,
      "FAQ / AI-Overview coverage",
      `${comp.faqCount} Q&A pairs vs your ${target.faqCount}. More question coverage wins People-Also-Ask and AI answers.`
    );
  }
  const ch = comp.headingTree.length;
  const th = target.headingTree.length;
  if (ch > th + 3) {
    add(
      isBlog ? 7 : 5,
      "Topical breadth",
      `${ch} sections vs your ${th}. They cover sub-topics your page doesn't.`
    );
  }
  // Data tables are a report signal; not expected in a blog, so skip for blogs.
  if (!isBlog && comp.tables > target.tables) {
    add(
      4,
      "Data tables",
      `${comp.tables} data tables vs your ${target.tables}. Tables expose extractable, citable data for AI engines.`
    );
  }
  if ((comp.hasAuthor || comp.hasReviewer) && !(target.hasAuthor || target.hasReviewer)) {
    add(7, "Authorship / E-E-A-T", "They expose author + reviewer credentials; your page does not.");
  }
  if (comp.hasDates && !target.hasDates) {
    add(4, "Freshness signals", "They expose published/updated dates; yours are not machine-visible.");
  }
  if (comp.titleLen >= 50 && comp.titleLen <= 60 && !(target.titleLen >= 50 && target.titleLen <= 60)) {
    add(3, "Title length", `Their title is ${comp.titleLen} chars (ideal) vs your ${target.titleLen}.`);
  }
  if (comp.hreflangCount > target.hreflangCount) {
    add(2, "hreflang targeting", `${comp.hreflangCount} hreflang tags vs your ${target.hreflangCount}.`);
  }
  if (target.images && target.imagesNoAlt && comp.images && !comp.imagesNoAlt) {
    add(2, "Image alt text", `All their content images have alt text; you miss ${target.imagesNoAlt}/${target.images}.`);
  }

  reasons.sort((a, b) => b.weight - a.weight);

  const compAdvantages = reasons.map((r) => r.factor);
  const targetAdvantages = [];
  if (target.contentWords > comp.contentWords * 1.15)
    targetAdvantages.push("Deeper content than this competitor");
  if (target.inContentInternal.length > comp.inContentInternal.length + 2)
    targetAdvantages.push("More in-content internal links");
  const tgtExtra = [...tgtSchema].filter((s) => !compSchema.has(s));
  if (tgtExtra.length) targetAdvantages.push("Schema they lack: " + tgtExtra.join(", "));
  if (target.faqCount > comp.faqCount)
    targetAdvantages.push(`More FAQ coverage (${target.faqCount} vs ${comp.faqCount})`);

  return { reasons, compAdvantages, targetAdvantages };
}
