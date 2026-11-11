/**
 * Downloads the base (un-suffixed) original for every image referenced by the
 * site.
 *
 * Shopify's CDN derives `NAME_600x901.jpg` from `NAME.jpg`. The theme's
 * responsive-image runtime requests sizes that were never in the HTML (it
 * computes them from viewport width), so the clone needs the base original
 * to regenerate any size on demand — mirroring the live CDN exactly.
 */
import fs from "node:fs";
import path from "node:path";
import { PUBLIC, ORIGIN, ensureDir, grabBuffer, grab } from "./lib.mjs";

const IMG_DIR = path.join(PUBLIC, "assets", "img");
ensureDir(IMG_DIR);

// Strip Shopify's size suffixes to recover the base filename.
const stripSize = (file) => file.replace(/_\d+x\d+(_crop_center)?(?=\.[a-z0-9]+$)/i, "");

const htmlFiles = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (["assets", "api"].includes(e.name)) continue;
      walk(path.join(dir, e.name));
    } else if (e.name.endsWith(".html")) htmlFiles.push(path.join(dir, e.name));
  }
})(PUBLIC);

const refs = new Set();
const imgRe = /\/assets\/img\/([^"'?\s)]+)/g;
for (const f of htmlFiles) {
  const html = fs.readFileSync(f, "utf8");
  for (const m of html.matchAll(imgRe)) {
    const raw = decodeURIComponent(m[1]);
    // "{size}" templates resolve to the base original at runtime.
    const base = stripSize(raw.replace(/_\{size\}(\.[a-z0-9]+)$/i, "$1"));
    if (base.includes("{size}")) continue;
    refs.add(base);
  }
}

console.log(`image references: ${refs.size} base files`);

let done = 0;
let fetched = 0;
let skipped = 0;
const missing = [];

const queue = [...refs];
const CONC = 6;
await Promise.all(
  Array.from({ length: CONC }, async () => {
    while (queue.length) {
      const file = queue.shift();
      const dest = path.join(IMG_DIR, file);
      if (fs.existsSync(dest) && fs.statSync(dest).size > 0) {
        skipped++;
      } else {
        try {
          const res = await grab(`${ORIGIN}/cdn/shop/files/${file}`, { method: "GET" });
          if (!res.ok) {
            missing.push(`${file} (HTTP ${res.status})`);
          } else {
            const buf = Buffer.from(await res.arrayBuffer());
            ensureDir(path.dirname(dest));
            fs.writeFileSync(dest, buf);
            fetched++;
          }
        } catch (e) {
          missing.push(`${file} (${e.message})`);
        }
      }
      done++;
      process.stdout.write(`\r  bases: ${done}/${refs.size} (fetched ${fetched}, skipped ${skipped})   `);
    }
  })
);

process.stdout.write("\n");
if (missing.length) {
  console.log(`  missing ${missing.length}:`);
  for (const m of missing.slice(0, 20)) console.log("    -", m);
}
console.log("done.");
