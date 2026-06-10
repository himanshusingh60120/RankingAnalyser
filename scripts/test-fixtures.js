import fs from "node:fs";
import { xray } from "../lib/xray.js";
import { rankingVerdict } from "../lib/verdict.js";
import { auditPage, scoreOf } from "../lib/audit.js";

const tHtml = fs.readFileSync(new URL("./fixture_target.html", import.meta.url), "utf8");
const cHtml = fs.readFileSync(new URL("./fixture_comp.html", import.meta.url), "utf8");

const t = xray("https://www.kingsresearch.com/report/plywood-market-3073", 200, tHtml);
const c = xray("https://www.precedenceresearch.com/plywood-market", 200, cHtml);

const findings = auditPage(t, "plywood market", tHtml.replace(/<[^>]+>/g," "));
console.log("TARGET: score", scoreOf(findings),
  "| contentWords", t.contentWords,
  "| inContentInternal", t.inContentInternal.length,
  "| inContentExternal", t.inContentExternal.length,
  "| chrome", t.chromeLinkCount, "| total", t.totalLinkCount,
  "| headings", t.headingTree.length, "| faq", t.faqCount,
  "| schema", [...new Set(t.schemaBlocks)].join(",")||"none");

console.log("COMP  : contentWords", c.contentWords,
  "| inContentInternal", c.inContentInternal.length,
  "| inContentExternal", c.inContentExternal.length,
  "| chrome", c.chromeLinkCount, "| total", c.totalLinkCount,
  "| headings", c.headingTree.length, "| faq", c.faqCount,
  "| schema", [...new Set(c.schemaBlocks)].join(",")||"none",
  "| author", c.hasAuthor, "| reviewer", c.hasReviewer, "| dates", c.hasDates,
  "| tables", c.tables);

console.log("\nLINK X-RAY — target in-content internal:");
t.inContentInternal.forEach(l => console.log("   ", l.anchor, "->", l.href));

const v = rankingVerdict(t, c);
console.log("\nVERDICT (why Precedence ranks better):");
v.reasons.forEach(r => console.log(`  [${r.weight}] ${r.factor}: ${r.detail}`));
console.log("\ntargetAdvantages:", v.targetAdvantages);
