/**
 * Mirrors the remaining origin asset paths that the first scrape pass missed.
 *
 * Shopify serves images from several prefixes on the store's own domain:
 *   /cdn/shop/files/       (product + general files)
 *   /cdn/shop/products/    (product images)
 *   /cdn/shop/articles/    (blog images)
 *   /cdn/shop/collections/ (collection banners)
 * plus the equivalent cdn.shopify.com/s/files/<shop>/<type>/ paths.
 *
 * This downloads those and rewrites the HTML to the local /assets/img route.
 */
import fs from "node:fs";
import path from "node:path";
import { PUBLIC, ORIGIN, ensureDir, grabBuffer, grab } from "./lib.mjs";

const IMG_DIR = path.join(PUBLIC, "assets", "img");
ensureDir(IMG_DIR);

// ---- collect every image URL still pointing at the origin -----------------
const files = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (["assets", "api"].includes(e.name)) continue;
      walk(path.join(dir, e.name));
    } else if (e.name.endsWith(".html")) files.push(path.join(dir, e.name));
  }
})(PUBLIC);

const SHOP_TYPES = ["files", "products", "articles", "collections"];

// Matches:  //www.nasoprofumi.com/cdn/shop/<type>/<file>
//           https://cdn.shopify.com/s/files/1/<shop>/<type>/<file>
const IMG_RE = new RegExp(
  `(?:https?:)?//(?:www\\.nasoprofumi\\.com/cdn/shop/(${SHOP_TYPES.join("|")})|cdn\\.shopify\\.com/s/files/1/\\d+/\\d+/\\d+/(${SHOP_TYPES.join("|")}))/([^"'?\\s)]+)`,
  "g"
);

const refs = new Map(); // "type/file" -> {url, file}

for (const f of files) {
  const html = fs.readFileSync(f, "utf8");
  for (const m of html.matchAll(IMG_RE)) {
    const type = m[1] || m[2];
    const file = m[3];
    const key = `${type}/${file}`;
    if (refs.has(key)) continue;
    refs.set(key, {
      type,
      file,
      url: `${ORIGIN}/cdn/shop/${type}/${file}`,
    });
  }
}

console.log(`origin images still referenced: ${refs.size}`);

// ---- download -------------------------------------------------------------
let done = 0;
let fetched = 0;
let skipped = 0;
const missing = [];

const queue = [...refs.values()];
const CONC = 8;
await Promise.all(
  Array.from({ length: CONC }, async () => {
    while (queue.length) {
      const item = queue.shift();
      // Keep the type folder so different stores of the same filename don't clash.
      const dest = path.join(IMG_DIR, item.type, item.file);
      if (fs.existsSync(dest) && fs.statSync(dest).size > 0) {
        skipped++;
      } else {
        try {
          const res = await grab(item.url);
          if (!res.ok) {
            missing.push(`${item.type}/${item.file} (HTTP ${res.status})`);
          } else {
            const buf = Buffer.from(await res.arrayBuffer());
            ensureDir(path.dirname(dest));
            fs.writeFileSync(dest, buf);
            fetched++;
          }
        } catch (e) {
          missing.push(`${item.type}/${item.file} (${e.message})`);
        }
      }
      done++;
      process.stdout.write(`\r  images: ${done}/${refs.size} (fetched ${fetched}, skipped ${skipped})   `);
    }
  })
);
process.stdout.write("\n");
if (missing.length) {
  console.log(`  missing ${missing.length}:`);
  for (const m of missing.slice(0, 15)) console.log("    -", m);
}

// ---- rewrite HTML ---------------------------------------------------------
// Local URL keeps the type folder: /assets/img/<type>/<file>
let rewritten = 0;
for (const f of files) {
  const html = fs.readFileSync(f, "utf8");
  const fixed = html.replace(IMG_RE, (m, t1, t2, file) => {
    const type = t1 || t2;
    const clean = file.replace(/\?.*$/, "");
    const encoded = encodeURIComponent(clean).replace(/%7B/g, "{").replace(/%7D/g, "}");
    return `/assets/img/${type}/${encoded}`;
  });
  if (fixed !== html) {
    fs.writeFileSync(f, fixed);
    rewritten++;
  }
}
console.log(`rewrote ${rewritten} html files`);
console.log("done.");
