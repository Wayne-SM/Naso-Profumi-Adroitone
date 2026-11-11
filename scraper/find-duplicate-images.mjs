/**
 * Finds duplicate image files by content hash.
 *
 * Normalising the image paths left some copies in more than one place; those
 * are pure duplication in the repository and can be dropped.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { PUBLIC } from "./lib.mjs";

const IMG = path.join(PUBLIC, "assets", "img");

const all = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else all.push(p);
  }
})(IMG);

const byHash = new Map();
let total = 0;
for (const p of all) {
  const buf = fs.readFileSync(p);
  total += buf.length;
  const hash = crypto.createHash("sha1").update(buf).digest("hex");
  if (!byHash.has(hash)) byHash.set(hash, []);
  byHash.get(hash).push(p);
}

const mb = (b) => (b / 1048576).toFixed(1);
let dupBytes = 0;
let dupFiles = 0;
const groups = [];

for (const [, paths] of byHash) {
  if (paths.length < 2) continue;
  const sorted = paths.sort();
  // Keep the copy in a typed folder; drop the others.
  const keep = sorted.find((p) => p !== path.join(IMG, path.basename(p))) || sorted[0];
  for (const p of sorted) {
    if (p === keep) continue;
    const st = fs.statSync(p);
    dupBytes += st.size;
    dupFiles++;
  }
  groups.push({ keep: path.relative(IMG, keep), drop: sorted.filter((p) => p !== keep).map((p) => path.relative(IMG, p)) });
}

console.log("=== duplicates ===");
console.log(`files: ${all.length}, total ${mb(total)} MB`);
console.log(`unique: ${byHash.size}`);
console.log(`duplicate copies: ${dupFiles} (${mb(dupBytes)} MB)`);
console.log("\nexamples:");
for (const g of groups.slice(0, 10)) {
  console.log(`  keep ${g.keep}`);
  for (const d of g.drop) console.log(`  drop ${d}`);
}
