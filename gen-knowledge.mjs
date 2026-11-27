// knowledge.md is the source. Trigger.dev bundles TypeScript only, so the text is copied into src/knowledge.ts.
// Run after editing knowledge.md:  node gen-knowledge.mjs
import { readFileSync, writeFileSync } from "node:fs";
const md = readFileSync(new URL("./knowledge.md", import.meta.url), "utf8");
writeFileSync(new URL("./src/knowledge.ts", import.meta.url), `// GENERATED from knowledge.md by gen-knowledge.mjs. Do not edit by hand.\nexport const KNOWLEDGE = ${JSON.stringify(md)};\n`);
console.log("wrote src/knowledge.ts", md.length, "chars");
