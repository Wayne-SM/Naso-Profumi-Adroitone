/**
 * Captures the runtime endpoints the Atlantic theme calls at runtime, plus the
 * static data feeds (products/collections). These are replayed by the clone's
 * server so the theme behaves identically offline.
 */
import fs from "node:fs";
import path from "node:path";
import * as cheerio from "cheerio";
import { DATA, PUBLIC, ORIGIN, ensureDir, writeJson, grabText, grab } from "./lib.mjs";

const API = path.join(PUBLIC, "api");
ensureDir(API);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function pool(items, worker, limit = 5) {
  const queue = [...items];
  await Promise.all(
    Array.from({ length: Math.min(limit, queue.length) }, async () => {
      while (queue.length) {
        const item = queue.shift();
        try {
          await worker(item);
        } catch (e) {
          console.error("  ! ", item, e.message);
        }
      }
    })
  );
}

/* ------------------------------------------------------- static data feeds */

async function captureDataFeeds() {
  const products = await grabText(`${ORIGIN}/products.json?limit=250`);
  fs.writeFileSync(path.join(API, "products.json"), products);
  const p = JSON.parse(products).products;
  console.log(`  products.json: ${p.length} products`);

  const collections = await grabText(`${ORIGIN}/collections.json?limit=250`);
  fs.writeFileSync(path.join(API, "collections.json"), collections);
  const c = JSON.parse(collections).collections;
  console.log(`  collections.json: ${c.length} collections`);

  // per-collection product lists (drives collection pages + search facets)
  const perCollection = {};
  await pool(
    c.map((x) => x.handle),
    async (handle) => {
      const txt = await grabText(`${ORIGIN}/collections/${handle}/products.json?limit=250`);
      perCollection[handle] = JSON.parse(txt).products.map((x) => ({
        id: x.id,
        handle: x.handle,
        title: x.title,
        vendor: x.vendor,
        product_type: x.product_type,
        tags: x.tags,
        variants: x.variants,
        images: x.images,
        options: x.options,
      }));
    }
  );
  writeJson(path.join(API, "collection-products.json"), perCollection);
  console.log(`  collection-products.json: ${Object.keys(perCollection).length} collections`);

  // vendor list
  const vendors = [...new Set(p.map((x) => x.vendor).filter(Boolean))];
  writeJson(path.join(API, "vendors.json"), vendors);
  console.log(`  vendors.json: ${vendors.length}`);
}

/* --------------------------------------------------- predictive search feed */

/**
 * Predictive search returns a themed HTML fragment. Rather than scrape every
 * possible query, we capture the fragment *template* once and let the server
 * render it from local product data.
 */
async function capturePredictiveSearch() {
  const queries = ["oud", "rose", "candle", "saffron", "gift", "oudh", "attar", "x"];
  const out = {};
  for (const q of queries) {
    const html = await grabText(`${ORIGIN}/search/suggest?q=${encodeURIComponent(q)}&section_id=predictive-search`);
    out[q] = html;
    await sleep(120);
  }
  writeJson(path.join(API, "predictive-search-samples.json"), out);
  console.log(`  predictive-search-samples.json: ${Object.keys(out).length} queries`);
}

/* ---------------------------------------------------- recommendation section */

/**
 * Product recommendation sections are rendered per product. We capture the raw
 * section HTML for every product so the server can replay it.
 */
async function captureRecommendations(products) {
  const out = {};
  let done = 0;
  await pool(
    products,
    async (prod) => {
      const sectionId = "template--21034835673318__product-recommendations";
      const url = `${ORIGIN}/recommendations/products?section_id=${sectionId}&limit=4&product_id=${prod.id}`;
      const html = await grabText(url);
      const $ = cheerio.load(html);
      const dh = $("[data-html]").first();
      out[prod.handle] = dh.length ? $.html(dh) : "";
      done++;
      process.stdout.write(`\r  recommendations: ${done}/${products.length}   `);
    },
    5
  );
  process.stdout.write("\n");
  writeJson(path.join(API, "recommendations.json"), out);
}

/* ----------------------------------------------------------- quickshop feed */

/**
 * Quickshop injects a product's gallery + form. The theme asks the product
 * URL with ?view=quickshop and extracts [data-options] + [data-html].
 * Capturing the whole rendered product HTML per product is heavy, so we
 * capture only the two fragments the theme's asyncview loader needs.
 */
async function captureQuickshops(products) {
  const out = {};
  let done = 0;
  await pool(
    products,
    async (prod) => {
      const html = await grabText(`${ORIGIN}/products/${prod.handle}?view=quickshop`);
      const $ = cheerio.load(html);
      const opts = $("[data-options]").first();
      const dh = $("[data-html]").first();
      out[prod.handle] = {
        options: opts.length ? opts.text().trim() : "",
        html: dh.length ? $.html(dh) : "",
      };
      done++;
      process.stdout.write(`\r  quickshops: ${done}/${products.length}   `);
    },
    5
  );
  process.stdout.write("\n");
  writeJson(path.join(API, "quickshop.json"), out);
}

/* ------------------------------------------------------------ cart fixtures */

/**
 * Captures the cart's rendered fragments (mini drawer + cart table) for a
 * populated cart, so the server can reproduce the exact markup.
 */
async function captureCart() {
  const jar = new Map();
  const storeCookies = (res) => {
    const sc = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
    for (const c of sc) {
      const [kv] = c.split(";");
      const i = kv.indexOf("=");
      if (i > 0) jar.set(kv.slice(0, i), kv.slice(i + 1));
    }
  };
  const cookie = () => [...jar].map(([k, v]) => `${k}=${v}`).join("; ");

  const products = JSON.parse(fs.readFileSync(path.join(API, "products.json"), "utf8")).products;
  const withVariants = products.filter((p) => p.variants.some((v) => v.available)).slice(0, 2);
  for (const p of withVariants) {
    const v = p.variants.find((x) => x.available);
    const res = await grab(`${ORIGIN}/cart/add.js`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie() },
      body: JSON.stringify({ id: v.id, quantity: 1 }),
    });
    storeCookies(res);
  }

  const mini = await grabText(`${ORIGIN}/cart?view=mini`, { headers: { Cookie: cookie() } });
  const ajax = await grabText(`${ORIGIN}/cart?view=_ajax`, { headers: { Cookie: cookie() } });
  const cartJson = await grabText(`${ORIGIN}/cart.js`, { headers: { Cookie: cookie() } });

  writeJson(path.join(API, "cart-fixture.json"), {
    mini,
    ajax,
    cart: JSON.parse(cartJson),
    cookies: Object.fromEntries(jar),
  });
  console.log(`  cart-fixture.json captured`);
}

/* ------------------------------------------------------ theme global config */

/** Captures the live theme/Shopify globals so the clone boots identically. */
async function captureGlobals() {
  const html = await grabText(`${ORIGIN}/`);
  const $ = cheerio.load(html);

  const globals = {};
  $("script").each((i, el) => {
    const txt = $(el).html() || "";
    if (/window\.Shopify\s*=/.test(txt) || /window\.Theme\s*=/.test(txt) || /window\.Pop\s*=/.test(txt)) {
      globals[`script_${i}`] = txt;
    }
  });

  // Money format actually used by the theme's formatMoney helper.
  const moneyFormat = html.match(/window\.Shopify\.money_format\s*=\s*("[^"]*"|'[^']*')/)?.[1];
  writeJson(path.join(API, "globals.json"), {
    scripts: globals,
    moneyFormat: moneyFormat ? JSON.parse(moneyFormat) : "<span class='money'><span class=money>Rs. {{amount}}</span></span>",
  });
  console.log(`  globals.json: ${Object.keys(globals).length} scripts`);
}

async function main() {
  console.log("capturing runtime endpoints");
  await captureGlobals();
  await captureDataFeeds();
  await capturePredictiveSearch();

  const products = JSON.parse(fs.readFileSync(path.join(API, "products.json"), "utf8")).products;
  await captureRecommendations(products);
  await captureQuickshops(products);
  await captureCart();

  console.log("done.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
