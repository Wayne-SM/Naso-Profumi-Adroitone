/**
 * End-to-end verification of the clone.
 *
 * 1. Compares every cloned route against the origin HTML captured during the
 *    scrape (authoritative, no re-fetching, no rate limiting).
 * 2. Resolves every local asset referenced by every page.
 * 3. Exercises the runtime JSON/section endpoints and the full cart flow.
 * 4. Spot-checks a sample of routes against the live origin with backoff.
 */
import fs from "node:fs";
import path from "node:path";
import { DATA, PUBLIC, ORIGIN, readJson } from "./lib.mjs";

const BASE = process.env.CLONE || "http://localhost:3000";
const routes = JSON.parse(fs.readFileSync(path.join(DATA, "routes.json"), "utf8"));

let pass = 0;
let fail = 0;
const failures = [];
const check = (name, ok, detail) => {
  if (ok) pass++;
  else {
    fail++;
    failures.push(`${name}: ${detail}`);
  }
};

const fileFor = (route) =>
  route === "/" ? path.join(PUBLIC, "index.html") : path.join(PUBLIC, route.replace(/^\//, "").replace(/\//g, "__") + ".html");

/** Visible text only — ignores scripts, styles, and markup. */
const visibleText = (html) =>
  html
    .replace(/<script[\s\S]*?<\/script>/g, " ")
    .replace(/<style[\s\S]*?<\/style>/g, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();

/* ------------------------------------------------ 1. page content fidelity */

console.log("1. comparing every route against the captured origin HTML...");

const CONC = 8;
const queue = [...routes];
let compared = 0;

async function worker() {
  while (queue.length) {
    const r = queue.shift();
    const f = fileFor(r.route);
    if (!fs.existsSync(f)) {
      check(r.route, false, "no captured file");
      continue;
    }
    const originHtml = fs.readFileSync(f, "utf8");

    const res = await fetch(BASE + r.route).catch(() => null);
    if (!res || !res.ok) {
      check(r.route, false, `clone fetch failed (${res?.status})`);
      continue;
    }
    const cloneHtml = await res.text();

    const o = visibleText(originHtml);
    const c = visibleText(cloneHtml);

    if (o.length < 50) {
      check(r.route, false, "origin page had almost no visible text");
      continue;
    }

    // Sample evenly-spread words from the origin and check they appear.
    const words = o.split(" ").filter((w) => w.length > 3);
    let hit = 0;
    const n = Math.min(300, words.length);
    for (let i = 0; i < n; i++) {
      if (c.includes(words[Math.floor((i * words.length) / n)])) hit++;
    }
    const ratio = n ? hit / n : 0;
    check(r.route, ratio > 0.97, `text overlap ${(ratio * 100).toFixed(1)}%`);

    compared++;
    if (compared % 25 === 0) process.stdout.write(`\r  compared: ${compared}/${routes.length}   `);
  }
}
await Promise.all(Array.from({ length: CONC }, worker));
process.stdout.write(`\r  compared: ${compared}/${routes.length}\n`);

/* ------------------------------------------------------- 2. asset integrity */

console.log("2. resolving local assets...");

let assetTotal = 0;
let assetBad = 0;
const badAssets = new Set();
const assetSeen = new Set();

for (const r of routes) {
  const f = fileFor(r.route);
  if (!fs.existsSync(f)) continue;
  const html = fs.readFileSync(f, "utf8");

  const urls = [];
  for (const m of html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)) urls.push(m[1]);
  for (const m of html.matchAll(/srcset="([^"]+)"/g)) {
    for (const part of m[1].split(",")) {
      const u = part.trim().split(/\s+/)[0];
      if (u.startsWith("/assets/")) urls.push(u);
    }
  }
  for (const m of html.matchAll(/data-rimg-template="([^"]+)"/g)) urls.push(m[1]);
  for (const m of html.matchAll(/url\(['"]?(\/assets\/[^)'"]+)['"]?\)/g)) urls.push(m[1]);

  for (const u of new Set(urls)) {
    // Skip template placeholders — the runtime substitutes {size} before use.
    if (u.includes("{size}")) {
      // Verify the base original resolves AND that a runtime-sized variant
      // (what the browser actually requests) can be generated from it.
      const base = u
        .replace(/_\{size\}/gi, "")
        .replace(/_\d+x\d+/i, "")
        .replace(/_crop_center/gi, "");
      if (!assetSeen.has(base)) {
        assetSeen.add(base);
        assetTotal++;
        const br = await fetch(BASE + base).catch(() => null);
        if (!br || !br.ok) {
          assetBad++;
          badAssets.add(base);
        } else {
          // Simulate the runtime: NAME_{size}[_crop_center].ext
          const probe = u.replace(/_\{size\}/gi, "_640x960");
          const pr = await fetch(BASE + probe).catch(() => null);
          if (!pr || !pr.ok) {
            assetBad++;
            badAssets.add(probe);
          }
        }
      }
      continue;
    }
    if (assetSeen.has(u)) continue;
    assetSeen.add(u);
    assetTotal++;
    const ar = await fetch(BASE + u).catch(() => null);
    if (!ar || !ar.ok) {
      assetBad++;
      badAssets.add(u);
    }
  }
}
check("assets resolve", assetBad === 0, `${assetBad}/${assetTotal} failed`);
console.log(`  assets: ${assetTotal - assetBad}/${assetTotal} ok`);
for (const b of [...badAssets].slice(0, 10)) console.log("    missing:", b);

/* --------------------------------------------------- 3. runtime endpoints */

console.log("3. exercising runtime endpoints...");

const j = async (u, init) => {
  const r = await fetch(BASE + u, init);
  const t = await r.text();
  try {
    return JSON.parse(t);
  } catch {
    return { __error: t.slice(0, 200), __status: r.status };
  }
};

const cart0 = await j("/cart.js");
check("GET /cart.js", Array.isArray(cart0.items) && typeof cart0.total_price === "number", JSON.stringify(cart0).slice(0, 120));

const prods = await j("/products.json");
check("GET /products.json", prods.products?.length > 100, `${prods.products?.length} products`);

const cols = await j("/collections.json");
check("GET /collections.json", cols.collections?.length > 30, `${cols.collections?.length} collections`);

const cp = await j("/collections/perfume/products.json");
check("GET /collections/:h/products.json", cp.products?.length > 0, `${cp.products?.length}`);

const psHtml = await (await fetch(`${BASE}/search/suggest?q=oud&section_id=predictive-search`)).text();
check("predictive search", psHtml.includes("predictive-search__product-suggestion"), "no product suggestions in fragment");
check("predictive search finds oud", /OUD/i.test(psHtml), "no OUD match in fragment");

const psEmpty = await (await fetch(`${BASE}/search/suggest?q=zzzqqqxyz&section_id=predictive-search`)).text();
check("predictive search empty state", psEmpty.includes("No matching results found"), "missing empty state");

const recHtml = await (
  await fetch(`${BASE}/recommendations/products?section_id=template--21034835673318__product-recommendations&limit=4&product_id=9854616109286`)
).text();
check("recommendations", recHtml.includes("data-html") && recHtml.length > 500, `len ${recHtml.length}`);

const qsHtml = await (await fetch(`${BASE}/products/splash?view=quickshop`)).text();
check("quickshop fragment", qsHtml.includes("data-options") && qsHtml.includes("product-area"), qsHtml.slice(0, 120));

const mini0 = await (await fetch(`${BASE}/cart?view=mini`)).text();
check("cart mini (empty)", mini0.includes('data-html="content"') && mini0.includes("cart-mini-empty"), mini0.slice(0, 120));

const ajax0 = await (await fetch(`${BASE}/cart?view=_ajax`)).text();
check("cart table (empty)", ajax0.includes('data-html="table"') && ajax0.includes("cart-table"), ajax0.slice(0, 120));

const variantHtml = await (await fetch(`${BASE}/variants/48356965843174/?section_id=surface-pick-up`)).text();
check("variant section", variantHtml.includes("surface-pick-up"), variantHtml.slice(0, 120));

/* ------------------------------------------------------------ 4. cart flow */

console.log("4. cart flow...");

// node's fetch does not persist cookies, so keep an explicit jar.
const jar = new Map();
const absorb = (res) => {
  for (const c of res.headers.getSetCookie ? res.headers.getSetCookie() : []) {
    const [kv] = c.split(";");
    const i = kv.indexOf("=");
    if (i > 0) jar.set(kv.slice(0, i), kv.slice(i + 1));
  }
};
const cookie = () => [...jar].map(([k, v]) => `${k}=${v}`).join("; ");

/** Fetches from the clone carrying (and updating) the session cookie. */
async function cFetch(path, init) {
  const res = await fetch(BASE + path, { ...init, headers: { ...(init?.headers || {}), Cookie: cookie() } });
  absorb(res);
  return res;
}

await cFetch("/cart.js");
const variant = prods.products.find((p) => p.variants.some((v) => v.available))?.variants.find((v) => v.available);
check("found an in-stock variant", !!variant, "none found");
// The origin reports variant prices in paise; the clone converts from the
// rupee strings in products.json.
const unitCents = Math.round(Number(variant.price) * 100);

const added = await j("/cart/add.js", {
  method: "POST",
  headers: { "Content-Type": "application/json", Cookie: cookie() },
  body: JSON.stringify({ id: variant.id, quantity: 2 }),
});
check("POST /cart/add.js", added.variant_id === variant.id && added.quantity === 2, JSON.stringify(added).slice(0, 160));

const cart1 = await j("/cart.js", { headers: { Cookie: cookie() } });
check(
  "cart reflects add",
  cart1.item_count === 2 && cart1.total_price === unitCents * 2,
  `count ${cart1.item_count}, total ${cart1.total_price}, expected ${unitCents * 2}`
);

const changed = await j("/cart/change.js", {
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: cookie() },
  body: new URLSearchParams({ id: String(variant.id), quantity: "5" }).toString(),
});
check("POST /cart/change.js", changed.item_count === 5, JSON.stringify(changed).slice(0, 160));

const mini1 = await (await cFetch("/cart?view=mini")).text();
check("cart mini shows items", mini1.includes("cart-mini-item") && mini1.includes("Qty: 5"), "items missing from mini view");

const ajax1 = await (await cFetch("/cart?view=_ajax")).text();
check("cart table shows items", ajax1.includes("cart-item") && ajax1.includes("Rs. "), "items missing from cart table");

const cleared = await j("/cart/clear.js", { method: "POST", headers: { Cookie: cookie() } });
check("POST /cart/clear.js", cleared.item_count === 0, JSON.stringify(cleared).slice(0, 120));

/* ------------------------------------------------- 5. live origin spot-check */

// The origin rate-limits aggressively, so this step is best-effort and can be
// skipped entirely (CI does not depend on the origin being reachable).
if (process.env.SKIP_LIVE_CHECK) {
  console.log("5. live spot-check skipped (SKIP_LIVE_CHECK set)");
} else {
  console.log("5. live spot-check against the origin (rate-limited, best effort)...");

  const sample = ["/", "/collections/perfume", "/products/splash", "/pages/our-story", "/blogs/news"];
  for (const route of sample) {
    let originOk = null;
    for (let attempt = 0; attempt < 3 && originOk === null; attempt++) {
      const r = await fetch(ORIGIN + route).catch(() => null);
      if (r && r.ok) {
        const oText = visibleText(await r.text());
        const cText = visibleText(await (await fetch(BASE + route)).text());
        const words = oText.split(" ").filter((w) => w.length > 4);
        let hit = 0;
        const n = Math.min(200, words.length);
        for (let i = 0; i < n; i++) if (cText.includes(words[Math.floor((i * words.length) / n)])) hit++;
        originOk = n ? hit / n : 0;
      } else {
        await new Promise((r2) => setTimeout(r2, 3000));
      }
    }
    if (originOk === null) {
      console.log(`  ${route}: origin rate-limited, skipped`);
      continue;
    }
    check(`live ${route}`, originOk > 0.95, `live text overlap ${(originOk * 100).toFixed(1)}%`);
    console.log(`  ${route}: ${(originOk * 100).toFixed(1)}%`);
  }
}

/* ------------------------------------------------------------------ report */

console.log("\n================ RESULTS ================");
console.log(`pass: ${pass}   fail: ${fail}`);
if (failures.length) {
  console.log("\nfailures:");
  for (const f of failures.slice(0, 50)) console.log("  -", f);
}
console.log("=========================================");
process.exit(fail ? 1 : 0);
