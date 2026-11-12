/**
 * Bakes the footer corrections into the mirrored HTML.
 *
 * The server applies the same corrections at request time, so the two stay in
 * step (the shared implementation lives in lib/footer.mjs). Baking means a
 * page served straight off the CDN — the homepage on a static host, for
 * instance — is identical to one rendered by the server.
 *
 * The step is idempotent.
 */
import fs from "node:fs";
import path from "node:path";
import { PUBLIC } from "../lib/config.mjs";
import { fixFooter } from "../lib/footer.mjs";

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
let bytes = 0;

for (const f of files) {
  const html = fs.readFileSync(f, "utf8");
  const fixed = fixFooter(html);
  if (fixed !== html) {
    fs.writeFileSync(f, fixed);
    changed++;
    bytes += fixed.length - html.length;
  }
}

console.log(`baked the footer corrections into ${changed} of ${files.length} pages (+${(bytes / 1024).toFixed(0)} KB)`);
