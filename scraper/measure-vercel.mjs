/**
 * Measures what a Vercel deployment would actually have to upload.
 *
 * Vercel caps static file uploads at 100 MB (Hobby) / 1 GB (Pro), and a
 * serverless function bundle at 250 MB uncompressed. This reports the size of
 * each candidate asset set so a Vercel-native layout can be sized.
 */
import fs from "node:fs";
import path from "node:path";
import { PUBLIC } from "./lib.mjs";

// ---- collect the image URLs the HTML actually references
const htmlFiles = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (["assets", "api"].includes(e.name)) continue;
      walk(path.join(dir, e.name));
    } else if (e.name.endsWith(".html")) htmlFiles.push(path.join(dir, e.name));
  }
})(PUBLIC);

/** image name -> how it is referenced */
const refs = new Map(); // "files/NAME" -> Set("src" | "srcset" | "template")

for (const f of htmlFiles) {
  const html = fs.readFileSync(f, "utf8");

  for (const m of html.matchAll(/(?:src|href)="\/assets\/img\/([^"?]+)"/g)) {
    const key = decodeURIComponent(m[1]);
    if (!refs.has(key)) refs.set(key, new Set());
    refs.get(key).add("direct");
  }
  for (const m of html.matchAll(/srcset="([^"]+)"/g)) {
    for (const part of m[1].split(",")) {
      const u = part.trim().split(/\s+/)[0];
      const mm = u.match(/^\/assets\/img\/([^"?]+)/);
      if (!mm) continue;
      const key = decodeURIComponent(mm[1]);
      if (!refs.has(key)) refs.set(key, new Set());
      refs.get(key).add("srcset");
    }
  }
  for (const m of html.matchAll(/data-rimg-template="\/assets\/img\/([^"?]+)"/g)) {
    const key = decodeURIComponent(m[1]);
    if (!refs.has(key)) refs.set(key, new Set());
    refs.get(key).add("template");
  }
}

const IMG = path.join(PUBLIC, "assets", "img");
const onDisk = new Map(); // "type/name" -> bytes
for (const type of fs.readdirSync(IMG)) {
  const dir = path.join(IMG, type);
  if (!fs.statSync(dir).isDirectory()) continue;
  for (const name of fs.readdirSync(dir)) {
    onDisk.set(`${type}/${name}`, fs.statSync(path.join(dir, name)).size);
  }
}

// A base original can be rebuilt into any size, so a base can stand in for
// every size variant of the same image.
const baseOf = (key) => {
  const m = key.match(/^(.*)\/([^/]+?)_(\d+)x(\d+)(_crop_center)?\.([a-z0-9]+)$/i);
  if (!m) return null;
  return `${m[1]}/${m[2]}.${m[5]}`;
};

const mb = (b) => (b / 1048576).toFixed(1);

const buckets = {
  "bases only (current repo)": 0,
  "srcset + direct variants": 0,
  "bases + srcset variants": 0,
  "everything on disk": 0,
};

const seenBaseOnly = new Set();
const seenSrcset = new Set();
const seenBoth = new Set();

for (const [key, kinds] of refs) {
  const size = onDisk.get(key);
  if (size == null) continue;

  const base = baseOf(key);
  const baseSize = base ? onDisk.get(base) : undefined;

  // A base stands in for its variants.
  if (base && baseSize != null) {
    if (!seenBaseOnly.has(base)) {
      seenBaseOnly.add(base);
      buckets["bases only (current repo)"] += baseSize;
    }
    if (!seenBoth.has(base)) {
      seenBoth.add(base);
      buckets["bases + srcset variants"] += baseSize;
    }
  } else {
    buckets["bases only (current repo)"] += size;
    buckets["bases + srcset variants"] += size;
    seenBaseOnly.add(key);
    seenBoth.add(key);
  }

  // A variant needs its own file unless a base covers it.
  if (kinds.has("srcset") || kinds.has("direct")) {
    if (base && baseSize != null) {
      // covered by the base
    } else {
      if (!seenSrcset.has(key)) {
        seenSrcset.add(key);
        buckets["srcset + direct variants"] += size;
      }
    }
  }
}

for (const [k, v] of Object.entries(buckets)) {
  if (k === "everything on disk") continue;
  console.log(`${k.padEnd(32)} ${mb(v).padStart(9)} MB`);
}
const allDisk = [...onDisk.values()].reduce((a, b) => a + b, 0);
console.log(`${"everything on disk".padEnd(32)} ${mb(allDisk).padStart(9)} MB`);

const htmlBytes = htmlFiles.reduce((s, f) => s + fs.statSync(f).size, 0);
const apiBytes = fs
  .readdirSync(path.join(PUBLIC, "api"))
  .reduce((s, f) => s + fs.statSync(path.join(PUBLIC, "api", f)).size, 0);
console.log(`\n${"html pages".padEnd(32)} ${mb(htmlBytes).padStart(9)} MB  (${htmlFiles.length} files)`);
console.log(`${"api json".padEnd(32)} ${mb(apiBytes).padStart(9)} MB`);

console.log("\n=== Vercel limits ===");
console.log("  static upload   : 100 MB (Hobby) / 1 GB (Pro)");
console.log("  function bundle : 250 MB uncompressed (5 GB with large-functions beta)");
console.log("  filesystem      : read-only, writable /tmp up to 500 MB");
console.log("  request body    : 4.5 MB");
console.log("  state           : in-memory state is NOT shared across instances");
