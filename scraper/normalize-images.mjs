/**
 * Normalizes every local image path to the canonical typed form
 * `/assets/img/<type>/<file>` and repairs base-original derivation.
 *
 * The first scrape pass stored `/cdn/shop/files/` images flat in
 * `public/assets/img/`, while later passes stored the other Shopify types in
 * subfolders. This consolidates them and rewrites the HTML to match.
 *
 * It also fixes the base-original derivation for `crop_center` variants:
 *   "NAME_{size}_crop_center.jpg" -> "NAME.jpg"   (not "NAME_crop_center.jpg")
 */
import fs from "node:fs";
import path from "node:path";
import { PUBLIC, ORIGIN, ensureDir, grab } from "./lib.mjs";

const IMG_DIR = path.join(PUBLIC, "assets", "img");
const TYPES = ["files", "products", "articles", "collections"];

/* ------------------------------------------- 1. move flat files -> files/ */

const flat = fs.readdirSync(IMG_DIR).filter((n) => fs.statSync(path.join(IMG_DIR, n)).isFile());
if (flat.length) {
  ensureDir(path.join(IMG_DIR, "files"));
  for (const n of flat) {
    const src = path.join(IMG_DIR, n);
    const dest = path.join(IMG_DIR, "files", n);
    if (!fs.existsSync(dest)) fs.renameSync(src, dest);
  }
  console.log(`moved ${flat.length} flat images into files/`);
}

/* ------------------------------------------- 2. rewrite HTML to typed form */

const files = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (["assets", "api"].includes(e.name)) continue;
      walk(path.join(dir, e.name));
    } else if (e.name.endsWith(".html")) files.push(path.join(dir, e.name));
  }
})(PUBLIC);

const LOCAL_RE = /\/assets\/img\/([^"'?\s)]+)/g;
let rewritten = 0;

for (const f of files) {
  const html = fs.readFileSync(f, "utf8");
  const fixed = html.replace(LOCAL_RE, (m, rest) => {
    if (TYPES.includes(rest.split("/")[0])) return m; // already typed
    return `/assets/img/files/${rest}`;
  });
  if (fixed !== html) {
    fs.writeFileSync(f, fixed);
    rewritten++;
  }
}
console.log(`rewrote ${rewritten} html files to typed image paths`);

/* --------------------------------- 3. repair base originals for crop_center */

// "NAME_{size}_crop_center.jpg" -> "NAME.jpg"
// "NAME_600x600_crop_center.jpg" -> "NAME.jpg"
const deriveBase = (name) =>
  name
    .replace(/_\{size\}/i, "")
    .replace(/_\d+x\d+/i, "")
    .replace(/_crop_center/i, "")
    .replace(/^_+|_+$/g, "");

const bases = new Map();
for (const f of files) {
  const html = fs.readFileSync(f, "utf8");
  for (const m of html.matchAll(LOCAL_RE)) {
    const rest = decodeURIComponent(m[1]);
    if (!rest.includes("{size}")) continue;
    const type = TYPES.includes(rest.split("/")[0]) ? rest.split("/")[0] : "files";
    const file = rest.slice(type.length + 1);
    const base = deriveBase(file);
    if (!base || base.includes("{")) continue;
    const key = `${type}/${base}`;
    if (!bases.has(key)) bases.set(key, { type, base, url: `${ORIGIN}/cdn/shop/${type}/${base}` });
  }
}

console.log(`base originals referenced: ${bases.size}`);

let fetched = 0;
let skipped = 0;
const missing = [];
const queue = [...bases.values()];

await Promise.all(
  Array.from({ length: 8 }, async () => {
    while (queue.length) {
      const item = queue.shift();
      const dest = path.join(IMG_DIR, item.type, item.base);
      if (fs.existsSync(dest) && fs.statSync(dest).size > 0) {
        skipped++;
        continue;
      }
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
  })
);

console.log(`base originals: fetched ${fetched}, already present ${skipped}`);
if (missing.length) {
  console.log(`missing ${missing.length}:`);
  for (const m of missing.slice(0, 20)) console.log("  -", m);
}
console.log("done.");
