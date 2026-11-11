/**
 * Finds image files that are redundant.
 *
 * The server regenerates any `NAME_WxH` variant from the base original using
 * the same rules the origin's CDN uses, so a stored copy is only needed when
 * no base original exists to rebuild it from.
 */
import fs from "node:fs";
import path from "node:path";
import { PUBLIC } from "./lib.mjs";

const IMG = path.join(PUBLIC, "assets", "img");
const SIZE = /^(.*)_(\d+)x(\d+)(_crop_center)?\.([a-z0-9]+)$/i;

let redundant = 0;
let redundantBytes = 0;
let keep = 0;
let keepBytes = 0;
const noBase = [];

for (const dir of fs.readdirSync(IMG)) {
  const full = path.join(IMG, dir);
  if (!fs.statSync(full).isDirectory()) continue;

  for (const name of fs.readdirSync(full)) {
    const p = path.join(full, name);
    const st = fs.statSync(p);
    if (!st.isFile()) continue;

    const m = name.match(SIZE);
    if (!m) {
      keep++;
      keepBytes += st.size;
      continue;
    }

    const basePath = path.join(full, `${m[1]}.${m[5]}`);
    if (fs.existsSync(basePath)) {
      redundant++;
      redundantBytes += st.size;
    } else {
      keep++;
      keepBytes += st.size;
      noBase.push(`${dir}/${name}`);
    }
  }
}

const mb = (b) => (b / 1048576).toFixed(1);
console.log("=== regenerable vs required ===");
console.log(`regenerable (server rebuilds from base): ${redundant} files, ${mb(redundantBytes)} MB`);
console.log(`required (kept):                          ${keep} files, ${mb(keepBytes)} MB`);
console.log(`total:                                    ${mb(redundantBytes + keepBytes)} MB`);
console.log(`\nkept variants with no base (${noBase.length}):`);
noBase.slice(0, 15).forEach((s) => console.log("  ", s));
