/**
 * Repairs the `{size}` placeholder in already-localized HTML.
 *
 * The first scrape pass percent-encoded `{` / `}` in image URLs, but the
 * theme's responsive-image runtime substitutes `{size}` client-side and
 * matches the literal string. This restores the literal placeholder.
 */
import fs from "node:fs";
import path from "node:path";
import { PUBLIC } from "./lib.mjs";

const files = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (["assets", "api"].includes(e.name)) continue;
      walk(path.join(dir, e.name));
    } else if (e.name.endsWith(".html")) files.push(path.join(dir, e.name));
  }
})(PUBLIC);

let changed = 0;
let occurrences = 0;
for (const f of files) {
  const html = fs.readFileSync(f, "utf8");
  const fixed = html.replace(/%7Bsize%7D/g, "{size}");
  if (fixed !== html) {
    occurrences += (html.match(/%7Bsize%7D/g) || []).length;
    fs.writeFileSync(f, fixed);
    changed++;
  }
}
console.log(`repaired ${occurrences} placeholders across ${changed} files`);
