/**
 * Removes the image variants the server can regenerate from a base original.
 *
 * The server reproduces Shopify's CDN resize rules exactly (verified in
 * verify-resize-fidelity.mjs), so the stored copies of `NAME_WxH.ext` are
 * redundant once `NAME.ext` is present. This cuts roughly 1.1 GB off the
 * repository without changing a single pixel the site serves.
 */
import fs from "node:fs";
import path from "node:path";
import { PUBLIC } from "./lib.mjs";

const IMG = path.join(PUBLIC, "assets", "img");
const SIZE = /^(.*)_(\d+)x(\d+)(_crop_center)?\.([a-z0-9]+)$/i;

const DRY = process.argv.includes("--dry-run");

let removed = 0;
let removedBytes = 0;
let kept = 0;
let keptBytes = 0;

for (const dir of fs.readdirSync(IMG)) {
  const full = path.join(IMG, dir);
  if (!fs.statSync(full).isDirectory()) continue;

  for (const name of fs.readdirSync(full)) {
    const p = path.join(full, name);
    const st = fs.statSync(p);
    if (!st.isFile()) continue;

    const m = name.match(SIZE);
    if (!m) {
      kept++;
      keptBytes += st.size;
      continue;
    }

    const basePath = path.join(full, `${m[1]}.${m[5]}`);
    if (!fs.existsSync(basePath)) {
      // No base to rebuild from — this copy is required.
      kept++;
      keptBytes += st.size;
      continue;
    }

    removed++;
    removedBytes += st.size;
    if (!DRY) fs.unlinkSync(p);
  }
}

const mb = (b) => (b / 1048576).toFixed(1);
console.log(DRY ? "=== dry run ===" : "=== pruned ===");
console.log(`removed ${removed} regenerable variants (${mb(removedBytes)} MB)`);
console.log(`kept    ${kept} files (${mb(keptBytes)} MB)`);
console.log(`now     ${mb(removedBytes + keptBytes)} MB`);
