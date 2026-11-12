/**
 * Bakes the runtime HTML transformations into the mirrored pages.
 *
 * The server applies the same transformations on the fly (see lib/bake.mjs),
 * but baking them means the pages can be served straight off disk — which is
 * what keeps the memory footprint small enough for a modest instance.
 *
 * The step is idempotent.
 */
import fs from "node:fs";
import path from "node:path";
import { PUBLIC } from "../lib/config.mjs";
import { bakePage } from "../lib/bake.mjs";

const files = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (["assets", "api", "services"].includes(e.name)) continue;
      walk(path.join(dir, e.name));
    } else if (e.name.endsWith(".html")) files.push(path.join(dir, e.name));
  }
})(PUBLIC);

let changed = 0;

for (const f of files) {
  const html = fs.readFileSync(f, "utf8");
  const baked = bakePage(html);
  if (baked !== html) {
    fs.writeFileSync(f, baked);
    changed++;
  }
}

console.log(`baked ${changed} of ${files.length} pages`);
