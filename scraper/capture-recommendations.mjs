/**
 * Re-captures the product-recommendations sections, storing the *complete*
 * response body for each product.
 *
 * The theme's asyncview loader parses the response for `[data-options]` and
 * `[data-html]` elements, so the exact outer structure has to be preserved.
 */
import fs from "node:fs";
import path from "node:path";
import { PUBLIC, ORIGIN, ensureDir, writeJson, grab, sleep } from "./lib.mjs";

const API = path.join(PUBLIC, "api");
const products = JSON.parse(fs.readFileSync(path.join(API, "products.json"), "utf8")).products;

const SECTION_ID = "template--21034835673318__product-recommendations";
const out = {};

// Warm session so the origin does not challenge us.
const jar = new Map();
const cookie = () => [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
function absorb(res) {
  const sc = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  for (const c of sc) {
    const [kv] = c.split(";");
    const i = kv.indexOf("=");
    if (i > 0) jar.set(kv.slice(0, i), kv.slice(i + 1));
  }
}
await grab(ORIGIN + "/", { headers: { Cookie: cookie() } }).then(async (r) => {
  absorb(r);
  await r.text();
});

let done = 0;
for (const p of products) {
  const url = `${ORIGIN}/recommendations/products?section_id=${SECTION_ID}&limit=4&product_id=${p.id}`;
  let body = null;
  for (let attempt = 0; attempt < 4 && body === null; attempt++) {
    try {
      const res = await grab(url, { headers: { Cookie: cookie() } });
      absorb(res);
      const text = await res.text();
      if (text.includes("data-html") && text.length > 500) body = text;
      else await sleep(2000 * (attempt + 1));
    } catch {
      await sleep(2000 * (attempt + 1));
    }
  }
  out[p.handle] = body || "";
  done++;
  process.stdout.write(`\r  recommendations: ${done}/${products.length}   `);
}
process.stdout.write("\n");

writeJson(path.join(API, "recommendations.json"), out);
console.log("done.");
