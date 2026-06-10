import { fetchPage } from "../lib/fetcher.js";
import { xray } from "../lib/xray.js";
import { rankingVerdict } from "../lib/verdict.js";
import { auditPage, scoreOf } from "../lib/audit.js";

const TARGET = "https://www.kingsresearch.com/report/plywood-market-3073";
const COMP = "https://www.precedenceresearch.com/plywood-market";

console.log("Fetching target...");
const tf = await fetchPage(TARGET);
console.log("  target status:", tf.status, "blocked:", tf.blocked, "bytes:", tf.html.length);

console.log("Fetching competitor...");
const cf = await fetchPage(COMP);
console.log("  comp status:", cf.status, "blocked:", cf.blocked, "bytes:", cf.html.length);

if (tf.status === 200) {
  const t = xray(TARGET, tf.status, tf.html);
  const findings = auditPage(t, "plywood market", tf.html.replace(/<[^>]+>/g," "));
  console.log("\nTARGET XRAY:");
  console.log("  score:", scoreOf(findings), "| contentWords:", t.contentWords,
    "| inContentInternal:", t.inContentInternal.length,
    "| inContentExternal:", t.inContentExternal.length,
    "| chrome:", t.chromeLinkCount, "| headings:", t.headingTree.length,
    "| faq:", t.faqCount, "| schema:", [...new Set(t.schemaBlocks)].join(",") || "none");

  if (cf.status === 200) {
    const c = xray(COMP, cf.status, cf.html);
    console.log("\nCOMPETITOR XRAY:");
    console.log("  contentWords:", c.contentWords,
      "| inContentInternal:", c.inContentInternal.length,
      "| inContentExternal:", c.inContentExternal.length,
      "| chrome:", c.chromeLinkCount, "| headings:", c.headingTree.length,
      "| faq:", c.faqCount, "| schema:", [...new Set(c.schemaBlocks)].join(",") || "none");
    const v = rankingVerdict(t, c);
    console.log("\nVERDICT (why competitor ranks):");
    v.reasons.forEach(r => console.log(`  [${r.weight}] ${r.factor}: ${r.detail}`));
  }
}
