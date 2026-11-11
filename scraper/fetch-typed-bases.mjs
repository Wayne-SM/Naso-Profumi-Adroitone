/**
 * Downloads base originals for type-scoped images whose `{size}` template
 * URLs 404 on the origin (the template is a runtime pattern, not a file).
 *
 * e.g. /cdn/shop/articles/IMG_6092_{size}.jpg  ->  /cdn/shop/articles/IMG_6092.jpg
 *      /cdn/shop/products/18_{size}_crop_center.jpg -> /cdn/shop/products/18.jpg
 */
import fs from "node:fs";
import path from "node:path";
import { PUBLIC, ORIGIN, ensureDir, grab } from "./lib.mjs";

const IMG_DIR = path.join(PUBLIC, "assets", "img");
const TYPES = ["files", "products", "articles", "collections"];

const files = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (["assets", "api"].includes(e.name)) continue;
      walk(path.join(dir, e.name));
    } else if (e.name.endsWith(".html")) files.push(path.join(dir, e.name));
  }
})(PUBLIC);

// Any local image path that still carries a {size} template needs its base.
const LOCAL_RE = new RegExp(`/assets/img/(${TYPES.join("|")})/([^"'?\\s)]+)`, "g");

const bases = new Map(); // "type/base" -> {type, base, url}
for (const f of files) {
  const html = fs.readFileSync(f, "utf8");
  for (const m of html.matchAll(LOCAL_RE)) {
    const type = m[1];
    const name = decodeURIComponent(m[2]);
    if (!name.includes("{size}")) continue;
    // Strip the template marker first, then any size/crop suffix, to recover
    // the base filename: "18_{size}_crop_center.jpg" -> "18.jpg"
    const base = name
      .replace(/_\{size\}/, "")
      .replace(/_\d+x\d+/i, "")
      .replace(/_crop_center/i, "")
      .replace(/^_+|_+$/g, "");
    if (!base || base.includes("{")) continue;
    const key = `${type}/${base}`;
    if (bases.has(key)) continue;
    bases.set(key, { type, base, url: `${ORIGIN}/cdn/shop/${type}/${base}` });
  }
}

console.log(`base originals needed: ${bases.size}`);

let done = 0;
let fetched = 0;
let skipped = 0;
const missing = [];

const queue = [...bases.values()];
const CONC = 8;
await Promise.all(
  Array.from({ length: CONC }, async () => {
    while (queue.length) {
      const item = queue.shift();
      const dest = path.join(IMG_DIR, item.type, item.base);
      if (fs.existsSync(dest) && fs.statSync(dest).size > 0) {
        skipped++;
      } else {
        try {
          const res = await grab(item.url);
          if (!res.ok) {
            missing.push(`${item.type}/${item.base} (HTTP ${res.status})`);
          } else {
            const buf = Buffer.from(await res.arrayBuffer());
            ensureDir(path.dirname(dest));
            fs.writeFileSync(dest, buf);
            fetched++;
          }
        } catch (e) {
          missing.push(`${item.type}/${item.base} (${e.message})`);
        }
      }
      done++;
      process.stdout.write(`\r  bases: ${done}/${bases.size} (fetched ${fetched}, skipped ${skipped})   `);
    }
  })
);

process.stdout.write("\n");
if (missing.length) {
  console.log(`  missing ${missing.length}:`);
  for (const m of missing.slice(0, 15)) console.log("    -", m);
}
console.log("done.");
