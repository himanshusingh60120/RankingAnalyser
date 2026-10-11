// lib/google-policy.js
// Google Search baseline every Content Brief is written against.
// Keep it current: when Google ships a core/spam update or new guidance, add an entry
// and bump POLICY_BASELINE. Each brief prints the baseline date so analysts know its age.

export const POLICY_BASELINE = "2026-10-11";

export const GOOGLE_POLICY = [
  {
    id: "core-may-2026",
    when: "21 May – 2 Jun 2026",
    title: "May 2026 core update",
    fact: "Google called it a regular update to surface relevant, satisfying content, with nothing special to do if content is made for people.",
    rule: "Every section must answer something a buyer of this report actually needs. No filler written to hit a word count.",
  },
  {
    id: "core-mar-2026",
    when: "27 Mar – 8 Apr 2026",
    title: "March 2026 core update",
    fact: "Third-party analyses (SE Ranking, Sistrix, Amsive) saw visibility move from aggregators and intermediaries toward brands, official sites, specialists and data-rich sources. Google did not confirm specifics.",
    rule: "Be the primary source: lead with our own estimates, methodology and proprietary data. Never paraphrase another publisher's numbers.",
  },
  {
    id: "ai-guide-may-2026",
    when: "15 May 2026",
    title: "Google's guide to generative AI features in Search",
    fact: "AI Overviews and AI Mode use core ranking systems with retrieval and query fan-out. Unique, non-commodity content matters most; llms.txt, content chunking, AI-only rewrites and AI-specific schema are not needed; mass pages for fan-out variations are discouraged.",
    rule: "Answer the sub-questions (People Also Ask, related searches) inside this one page. Never create thin pages per keyword variation.",
  },
  {
    id: "spam-2026",
    when: "Mar 24 · Jun 24 · Aug 18 · Sep 24 – Oct 8, 2026",
    title: "Four spam updates in 2026",
    fact: "Spam policies include scaled content abuse, expired domain abuse, site reputation abuse and thin affiliation. The September update finished on 8 Oct 2026.",
    rule: "Templated report pages that only swap the market name and numbers are the biggest scaled-content risk for research publishers. Each page needs topic-specific analysis.",
  },
  {
    id: "site-rep-aug-2026",
    when: "28 Aug 2026",
    title: "Site reputation policy update",
    fact: "From 30 Aug 2026, site-reputation manual actions stop affecting results for searchers in the EEA; they still apply everywhere else and the policy itself remains.",
    rule: "Don't rely on press-release syndication or third-party copies of our reports to rank. Build authority on our own domain.",
  },
  {
    id: "structured-data",
    when: "Standing guidance",
    title: "Structured data must match visible content",
    fact: "Google's AI-features guidance repeats that markup must reflect what users can see.",
    rule: "Only mark up FAQs, authors, dates and datasets that are visible on the page. No fake ratings.",
  },
  {
    id: "people-first",
    when: "Standing guidance",
    title: "Helpful, reliable, people-first content (E-E-A-T)",
    fact: "Google's self-assessment asks who created the content, how it was produced and why.",
    rule: "Show the named analyst with credentials, the methodology (primary interviews, secondary sources, model) and a visible last-updated date.",
  },
];

export function policyPromptText() {
  return GOOGLE_POLICY.map((p) => `- ${p.title} (${p.when}): ${p.rule}`).join("\n");
}
