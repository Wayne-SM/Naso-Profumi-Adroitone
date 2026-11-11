/**
 * Mirrors the Shopify platform scripts the pages load from the origin.
 *
 * These provide `Shopify.formatMoney`, the country/currency selector and the
 * section plumbing. Leaving them pointing at the live origin breaks the
 * footer's country picker (and anything else that needs them) offline.
 *
 * The local file name keeps the original path structure, so
 *   themes_support/api.jquery-7ab1a3a4.js  ->  assets/js/themes_support/api.jquery-7ab1a3a4.js
 */
import fs from "node:fs";
import path from "node:path";
import { PUBLIC, ORIGIN, ensureDir, grabBuffer } from "./lib.mjs";

const JS_DIR = path.join(PUBLIC, "assets", "js");
ensureDir(JS_DIR);

const files = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (["assets", "api"].includes(e.name)) continue;
      walk(path.join(dir, e.name));
    } else if (e.name.endsWith(".html")) files.push(path.join(dir, e.name));
  }
})(PUBLIC);

// Paths that live under /cdn/shopifycloud/storefront/assets/ on the origin.
const RE = /\/\/www\.nasoprofumi\.com(\/cdn\/shopifycloud\/storefront\/assets\/[A-Za-z0-9_\-./]+)/g;

const wanted = new Map(); // origin path -> local relative path
for (const f of files) {
  const html = fs.readFileSync(f, "utf8");
  for (const m of html.matchAll(RE)) {
    const p = m[1].replace(/^\/cdn\/shopifycloud\/storefront\/assets\//, "");
    wanted.set(p, p.replace(/^\/+/, ""));
  }
}

// Some pages were already rewritten to a mangled local path; recover them.
const MANGLED = /\/assets\/js\/((?:themes_support|storefront)_[A-Za-z0-9_\-.]+\.js)/g;
for (const f of files) {
  const html = fs.readFileSync(f, "utf8");
  for (const m of html.matchAll(MANGLED)) {
    const mangled = m[1];
    const dir = mangled.startsWith("themes_support_") ? "themes_support/" : "storefront/";
    const file = mangled.replace(/^(themes_support|storefront)_/, "").replace(/_/g, (c, i, s) => (s.slice(0, i).includes("_") && c === "_" ? "_" : "_"));
    // Only replace the FIRST underscore after the known directory prefix.
    const restored = mangled.replace(/^(themes_support|storefront)_/, (d) => d + "/").replace(/_/g, "_");
    const p = dir + restored.slice(dir.length);
    if (!wanted.has(p)) wanted.set(p, p);
  }
}

console.log(`platform scripts to mirror: ${wanted.size}`);

for (const [p, rel] of wanted) {
  const dest = path.join(JS_DIR, rel);
  if (fs.existsSync(dest) && fs.statSync(dest).size > 0) {
    console.log(`  = have ${rel}`);
    continue;
  }
  try {
    const buf = await grabBuffer(`${ORIGIN}/cdn/shopifycloud/storefront/assets/${p}`);
    ensureDir(path.dirname(dest));
    fs.writeFileSync(dest, buf);
    console.log(`  + ${rel} (${buf.length} bytes)`);
  } catch (e) {
    console.error(`  ! ${p} -> ${e.message}`);
  }
}

// Point the HTML at the local copies, preserving the directory structure.
let rewritten = 0;
for (const f of files) {
  const html = fs.readFileSync(f, "utf8");
  let fixed = html.replace(RE, (m, p) => `/assets/js/${p.replace(/^\/cdn\/shopifycloud\/storefront\/assets\//, "")}`);

  // Repair the previously mangled references.
  fixed = fixed.replace(MANGLED, (m, mangled) => {
    const dir = mangled.startsWith("themes_support_") ? "themes_support/" : "storefront/";
    const rest = mangled.slice(mangled.indexOf("_") + 1);
    return `/assets/js/${dir}${rest}`;
  });

  if (fixed !== html) {
    fs.writeFileSync(f, fixed);
    rewritten++;
  }
}
console.log(`rewrote ${rewritten} html files`);
