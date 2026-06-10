// lib/audit.js
// On-page audit + score for a single XRay result. Produces findings aligned to
// the current Google core update and a 0-100 on-page score.

const BRITISH_US = {
  colour: "color", favour: "favor", behaviour: "behavior", labour: "labor",
  honour: "honor", neighbour: "neighbor", centre: "center", fibre: "fiber",
  litre: "liter", metre: "meter", theatre: "theater", organisation: "organization",
  organise: "organize", organised: "organized", realise: "realize",
  recognise: "recognize", analyse: "analyze", analysed: "analyzed",
  catalogue: "catalog", programme: "program", licence: "license",
  defence: "defense", offence: "offense", travelling: "traveling",
  modelling: "modeling", labelled: "labeled", grey: "gray", ageing: "aging",
  judgement: "judgment", utilise: "utilize", optimise: "optimize",
  maximise: "maximize", minimise: "minimize", prioritise: "prioritize",
  capitalise: "capitalize", emphasise: "emphasize", standardise: "standardize",
  speciality: "specialty",
};

export function britishSpellings(text) {
  const low = (text || "").toLowerCase();
  const hits = [];
  for (const [brit, us] of Object.entries(BRITISH_US)) {
    if (new RegExp(`\\b${brit}\\b`).test(low)) hits.push([brit, us]);
  }
  return hits;
}

export function auditPage(x, keyword, contentText = "") {
  const f = [];
  const kw = (keyword || "").toLowerCase().trim();
  const add = (severity, category, message, detail = "") =>
    f.push({ severity, category, message, detail });

  // Title
  if (!x.title) add("critical", "Title", "Missing <title> tag.");
  else {
    if (x.titleLen < 30) add("warning", "Title", `Title short (${x.titleLen}). Aim 50-60.`, x.title);
    else if (x.titleLen > 65) add("warning", "Title", `Title may truncate (${x.titleLen}). Aim 50-60.`, x.title);
    else add("good", "Title", `Title length OK (${x.titleLen}).`);
    if (kw && !x.title.toLowerCase().includes(kw)) add("warning", "Title", "Keyword not in title.", kw);
  }

  // Meta description
  if (!x.metaDescLen) add("critical", "Meta", "Missing meta description.");
  else if (x.metaDescLen < 120) add("warning", "Meta", `Meta short (${x.metaDescLen}). Aim 140-160.`);
  else if (x.metaDescLen > 165) add("warning", "Meta", `Meta may truncate (${x.metaDescLen}). Aim 140-160.`);
  else add("good", "Meta", `Meta length OK (${x.metaDescLen}).`);

  // Indexing
  if (!x.canonical) add("warning", "Indexing", "No canonical tag.");
  else add("good", "Indexing", "Canonical present.", x.canonical);
  if (/noindex/i.test(x.robots)) add("critical", "Indexing", "Page set to NOINDEX — will not rank.", x.robots);

  // H1
  const h1s = x.headingTree.filter(([lvl]) => lvl === 1);
  if (h1s.length === 0) add("critical", "Headings", "No H1 found.");
  else if (h1s.length > 1) add("warning", "Headings", `Multiple H1s (${h1s.length}). Prefer one.`);
  else {
    add("good", "Headings", "Single H1 present.", h1s[0][1]);
    if (kw && !h1s[0][1].toLowerCase().includes(kw)) add("warning", "Headings", "Keyword not in H1.");
  }

  // Heading progression
  let prev = 0, skips = 0;
  for (const [lvl] of x.headingTree) {
    if (prev && lvl > prev + 1) skips++;
    prev = lvl;
  }
  if (skips) add("warning", "Headings", `Heading levels skip ${skips} time(s). Use sequential H1->H2->H3.`);
  else if (x.headingTree.length) add("good", "Headings", "Heading hierarchy sequential.");

  // Content depth
  if (x.contentWords < 600) add("critical", "Content", `Thin content (${x.contentWords} words).`);
  else if (x.contentWords < 1200) add("warning", "Content", `Moderate depth (${x.contentWords}). Top pages run 1500+.`);
  else add("good", "Content", `Solid depth (${x.contentWords} words).`);

  // Schema
  if (!x.schemaBlocks.length) add("warning", "Schema", "No JSON-LD detected. Add Article/Dataset/FAQPage.");
  else add("good", "Schema", "Structured data present.", [...new Set(x.schemaBlocks)].join(", "));

  // FAQ / AI Overview
  if (x.faqCount >= 3) {
    add("good", "AI Overview", `${x.faqCount} Q&A pairs — good for AI Overviews & PAA.`);
    if (!x.hasFaqPage) add("warning", "Schema", "FAQ content exists but no FAQPage schema. Add it.");
  } else add("warning", "AI Overview", "Few/no Q&A pairs. Add an FAQ block.");

  // E-E-A-T
  if (x.hasAuthor || x.hasReviewer) add("good", "E-E-A-T", "Author / reviewer signals present.");
  else add("warning", "E-E-A-T", "No clear author/reviewer. Add bylines + credentials.");
  if (!x.hasDates) add("warning", "E-E-A-T", "No machine-visible published/updated dates.");

  // Images
  if (x.images && x.imagesNoAlt) add("warning", "Images", `${x.imagesNoAlt}/${x.images} content images missing alt.`);
  else if (x.images) add("good", "Images", "All content images have alt text.");

  // Internal linking
  if (x.inContentInternal.length < 5)
    add("warning", "Linking", `Only ${x.inContentInternal.length} in-content internal links. Add contextual links.`);
  else add("good", "Linking", `${x.inContentInternal.length} in-content internal links.`);

  // Social
  if (!x.ogCount) add("warning", "Social", "No Open Graph tags.");
  else add("good", "Social", `${x.ogCount} OG tags present.`);

  // US English
  const brit = britishSpellings(contentText || x.title);
  if (brit.length)
    add("warning", "US English", `${brit.length} British spellings found.`, brit.slice(0, 12).map(([b, u]) => `${b}->${u}`).join(", "));
  else add("good", "US English", "No British spellings detected.");

  return f;
}

export function scoreOf(findings) {
  const w = { critical: 12, warning: 4, good: 0, info: 1 };
  const penalty = findings.reduce((s, x) => s + (w[x.severity] || 0), 0);
  return Math.max(0, 100 - penalty);
}
