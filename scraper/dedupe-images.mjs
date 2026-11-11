/**
 * Removes image copies that exist, byte-for-byte, in more than one place.
 *
 * The typed folders (`files/`, `products/`, `articles/`, `collections/`) are
 * canonical. Loose files at the root of the image directory are leftovers
 * from an earlier pass; they are removed only when an identical copy exists
 * in a folder — never when they are the sole copy of a file.
 *
 * References are checked first: a file is never removed if the HTML still
 * points at that exact path.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { PUBLIC } from "./lib.mjs";

const IMG = path.join(PUBLIC, "assets", "img");
const DRY = process.argv.includes("--dry-run");

// --- collect every path the HTML references
const htmlFiles = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (["assets", "api"].includes(e.name)) continue;
      walk(path.join(dir, e.name));
    } else if (e.name.endsWith(".html")) htmlFiles.push(path.join(dir, e.name));
  }
})(PUBLIC);

const referenced = new Set();
for (const f of htmlFiles) {
  const html = fs.readFileSync(f, "utf8");
  for (const m of html.matchAll(/\/assets\/img\/([^"'?\s)]+)/g)) {
    referenced.add(decodeURIComponent(m[1]));
  }
}

// --- index every image file by content hash
const all = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else all.push(p);
  }
})(IMG);

const byHash = new Map();
for (const p of all) {
  const hash = crypto.createHash("sha1").update(fs.readFileSync(p)).digest("hex");
  if (!byHash.has(hash)) byHash.set(hash, []);
  byHash.get(hash).push(p);
}

let removed = 0;
let removedBytes = 0;
const removedPaths = [];

for (const [, paths] of byHash) {
  if (paths.length < 2) continue;

  // Prefer a copy that the HTML actually references, then one in a folder.
  const scored = paths
    .map((p) => {
      const rel = path.relative(IMG, p).split(path.sep).join("/");
      const inFolder = path.dirname(p) !== IMG;
      const isReferenced = referenced.has(rel);
      return { p, inFolder, isReferenced };
    })
    .sort((a, b) => Number(b.isReferenced) - Number(a.isReferenced) || Number(b.inFolder) - Number(a.inFolder));

  const keep = scored[0];
  for (const cand of scored.slice(1)) {
    // Never remove a file the HTML points at. Only unreferenced loose copies
    // at the root of the image directory are removed.
    const rel = path.relative(IMG, cand.p).split(path.sep).join("/");
    if (cand.isReferenced) continue;
    if (path.dirname(cand.p) === IMG) {
      const st = fs.statSync(cand.p);
      removedBytes += st.size;
      removed++;
      removedPaths.push(rel);
      if (!DRY) fs.unlinkSync(cand.p);
    }
  }
}

const mb = (b) => (b / 1048576).toFixed(1);
console.log(DRY ? "=== dry run ===" : "=== removed ===");
console.log(`removed ${removed} duplicate copies (${mb(removedBytes)} MB)`);
if (removedPaths.length) console.log(removedPaths.map((p) => `  - ${p}`).join("\n"));
