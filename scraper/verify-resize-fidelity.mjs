/**
 * Verifies that the locally regenerated image variants match the ones the
 * origin's CDN serves, before the stored copies are pruned.
 *
 * Compares pixel dimensions and a perceptual hash of the decoded image.
 */
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { PUBLIC, ORIGIN, grabBuffer } from "./lib.mjs";

const IMG = path.join(PUBLIC, "assets", "img");
const SIZE = /^(.*)_(\d+)x(\d+)(_crop_center)?\.([a-z0-9]+)$/i;

// Sample the regenerable variants across all folders.
const candidates = [];
for (const dir of fs.readdirSync(IMG)) {
  const full = path.join(IMG, dir);
  if (!fs.statSync(full).isDirectory()) continue;
  for (const name of fs.readdirSync(full)) {
    const m = name.match(SIZE);
    if (!m) continue;
    const basePath = path.join(full, `${m[1]}.${m[5]}`);
    if (!fs.existsSync(basePath)) continue;
    candidates.push({ dir, name, base: basePath, m });
  }
}

console.log(`regenerable variants: ${candidates.length}`);
const step = Math.max(1, Math.floor(candidates.length / 40));
const sample = candidates.filter((_, i) => i % step === 0).slice(0, 40);

let dimMatch = 0;
let contentMatch = 0;
let fetchFail = 0;
const mismatches = [];

for (const c of sample) {
  const localPath = path.join(IMG, c.dir, c.name);

  // The origin's URL for this variant.
  const originUrl = `${ORIGIN}/cdn/shop/${c.dir}/${c.name}`;
  let originBuf;
  try {
    const res = await fetch(originUrl);
    if (!res.ok) {
      fetchFail++;
      continue;
    }
    originBuf = Buffer.from(await res.arrayBuffer());
  } catch {
    fetchFail++;
    continue;
  }

  // Rebuild from the base with the same rules the server uses.
  const [, base, w, h, crop, ext] = c.m;
  const baseBuf = fs.readFileSync(c.base);
  const meta = await sharp(baseBuf).metadata();

  let rebuilt;
  if (crop) {
    const coverScale = Math.max(Number(w) / meta.width, Number(h) / meta.height);
    if (coverScale > 1) {
      rebuilt = await sharp(baseBuf)
        .resize(Number(w), Number(h), { fit: "inside", withoutEnlargement: true })
        .toBuffer();
    } else {
      rebuilt = await sharp(baseBuf)
        .resize(Number(w), Number(h), { fit: "cover", position: "centre", withoutEnlargement: true })
        .toBuffer();
    }
  } else {
    rebuilt = await sharp(baseBuf)
      .resize(Number(w), Number(h), { fit: "inside", withoutEnlargement: true })
      .toBuffer();
  }

  const [om, rm] = await Promise.all([sharp(originBuf).metadata(), sharp(rebuilt).metadata()]);
  if (om.width === rm.width && om.height === rm.height) dimMatch++;
  else {
    mismatches.push(`${c.dir}/${c.name}: origin ${om.width}x${om.height} vs rebuilt ${rm.width}x${rm.height}`);
    continue;
  }

  // Compare decoded pixels (both decoded to a small common size).
  const a = await sharp(originBuf).resize(32, 32, { fit: "fill" }).raw().toBuffer();
  const b = await sharp(rebuilt).resize(32, 32, { fit: "fill" }).raw().toBuffer();
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff += Math.abs(a[i] - b[i]);
  const mean = diff / a.length;
  if (mean < 6) contentMatch++;
  else mismatches.push(`${c.dir}/${c.name}: pixel delta ${mean.toFixed(2)}`);
}

console.log(`\nsampled ${sample.length} variants`);
console.log(`  dimensions identical : ${dimMatch}`);
console.log(`  pixels near-identical: ${contentMatch}`);
console.log(`  origin fetch failed  : ${fetchFail}`);
if (mismatches.length) {
  console.log("\n  differences:");
  for (const m of mismatches.slice(0, 12)) console.log("   -", m);
}
