/**
 * Analyses the mirrored image inventory so the repository can be sized well:
 *   - format split (PNG vs JPEG) and how much is photographic
 *   - alpha channel presence (PNG -> JPEG is only safe without alpha)
 *   - the largest dimensions the theme actually requests (data-rimg-max and
 *     the explicit `_WxH` variants), so base originals can be capped safely
 */
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { PUBLIC } from "./lib.mjs";

const IMG = path.join(PUBLIC, "assets", "img");

const files = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) files.push(path.join(dir, e.name));
  }
})(IMG);

let totalBytes = 0;
let pngBytes = 0;
let jpgBytes = 0;
let otherBytes = 0;
let pngOpaque = 0;
let pngAlpha = 0;
let pngOpaqueBytes = 0;
let pngAlphaBytes = 0;

const bySize = [];

for (const f of files) {
  for (const name of fs.readdirSync(f)) {
    const p = path.join(f, name);
    let st;
    try {
      st = fs.statSync(p);
    } catch {
      continue;
    }
    if (!st.isFile()) continue;
    totalBytes += st.size;
    const ext = path.extname(name).toLowerCase();

    if (ext === ".png") {
      pngBytes += st.size;
      try {
        const meta = await sharp(p).metadata();
        if (meta.hasAlpha) {
          pngAlpha++;
          pngAlphaBytes += st.size;
        } else {
          pngOpaque++;
          pngOpaqueBytes += st.size;
        }
        bySize.push({ p, w: meta.width, h: meta.height, bytes: st.size, ext, alpha: !!meta.hasAlpha });
      } catch {}
    } else if (ext === ".jpg" || ext === ".jpeg") {
      jpgBytes += st.size;
    } else {
      otherBytes += st.size;
    }
  }
}

const mb = (b) => (b / 1048576).toFixed(1);
console.log("=== inventory ===");
console.log(`total          ${mb(totalBytes)} MB`);
console.log(`png            ${mb(pngBytes)} MB  (${mb(pngOpaqueBytes)} MB opaque, ${mb(pngAlphaBytes)} MB with alpha)`);
console.log(`jpeg           ${mb(jpgBytes)} MB`);
console.log(`other          ${mb(otherBytes)} MB`);

// ---- what does the theme actually request?
const html = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (["assets", "api"].includes(e.name)) continue;
      walk(path.join(dir, e.name));
    } else if (e.name.endsWith(".html")) html.push(path.join(dir, e.name));
  }
})(PUBLIC);

let maxRequestedW = 0;
let maxRequestedH = 0;
const explicitSizes = new Set();
for (const f of html) {
  const h = fs.readFileSync(f, "utf8");
  for (const m of h.matchAll(/data-rimg-max="(\d+)x(\d+)"/g)) {
    maxRequestedW = Math.max(maxRequestedW, Number(m[1]));
    maxRequestedH = Math.max(maxRequestedH, Number(m[2]));
  }
  for (const m of h.matchAll(/\/assets\/img\/[^"')]*?_(\d+)x(\d+)\./g)) {
    explicitSizes.add(`${Number(m[1])}x${Number(m[2])}`);
  }
}
console.log("\n=== requested dimensions ===");
console.log(`max data-rimg-max : ${maxRequestedW}x${maxRequestedH}`);
console.log(`explicit variants : ${explicitSizes.size} distinct sizes`);
const dims = [...explicitSizes].map((s) => s.split("x").map(Number)).sort((a, b) => b[0] * b[1] - a[0] * a[1]);
console.log("largest explicit variants:", dims.slice(0, 8).map((d) => d.join("x")).join(", "));

// ---- how much would capping + re-encoding save?
const longEdges = bySize.map((i) => Math.max(i.w, i.h));
longEdges.sort((a, b) => b - a);
console.log("\n=== base originals by long edge ===");
for (const p of [4000, 3000, 2500, 2000]) {
  const over = bySize.filter((i) => Math.max(i.w, i.h) > p);
  const bytes = over.reduce((s, i) => s + i.bytes, 0);
  console.log(`  > ${p}px: ${over.length} files, ${mb(bytes)} MB`);
}

const big = bySize.filter((i) => i.bytes > 1024 * 1024);
console.log(`\nfiles over 1MB: ${big.length}, ${mb(big.reduce((s, i) => s + i.bytes, 0))} MB`);
console.log("opaque PNG over 1MB:", big.filter((i) => i.ext === ".png" && !i.alpha).length);
console.log("alpha PNG over 1MB :", big.filter((i) => i.ext === ".png" && i.alpha).length);
