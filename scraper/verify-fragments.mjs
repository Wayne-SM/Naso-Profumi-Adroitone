/**
 * Compares the clone's runtime fragments (cart mini, cart table, predictive
 * search, quickshop, recommendations) against the live origin, structurally.
 */
import fs from "node:fs";
import * as cheerio from "cheerio";

const ORIGIN = "https://www.nasoprofumi.com";
const CLONE = "http://localhost:3000";

/** A cookie jar for the origin. */
const jar = new Map();
const cookie = () => [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
function absorb(res) {
  for (const c of res.headers.getSetCookie ? res.headers.getSetCookie() : []) {
    const [kv] = c.split(";");
    const i = kv.indexOf("=");
    if (i > 0) jar.set(kv.slice(0, i), kv.slice(i + 1));
  }
}

/** Describes an element tree: tag + key classes + text, ignoring volatile bits. */
function outline($, el, depth = 0, out = []) {
  if (depth > 6 || !el || !el.length) return out;
  const node = el.get(0);
  const tag = node?.tagName?.toLowerCase();
  if (!tag || ["script", "style", "svg", "noscript"].includes(tag)) return out;
  const cls = (el.attr("class") || "")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 4)
    .join(".");
  const text = el
    .clone()
    .children()
    .remove()
    .end()
    .text()
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, 60);
  out.push(`${"  ".repeat(depth)}${tag}${cls ? "." + cls : ""}${text ? ` "${text}"` : ""}`);
  // cheerio's .each() hands back raw DOM nodes, so re-wrap them.
  el.children().each((i, c) => outline($, $(c), depth + 1, out));
  return out;
}

/** Picks the node to outline from a parsed document. */
function pickOne($, candidates) {
  for (const sel of candidates) {
    const node = $(sel).first();
    if (node.length && node.children().length) return node;
  }
  for (const sel of candidates) {
    const node = $(sel).first();
    if (node.length) return node;
  }
  return $("body").first();
}

function compare(name, originHtml, cloneHtml, candidates) {
  const $o = cheerio.load(originHtml);
  const $c = cheerio.load(cloneHtml);
  const o = outline($o, pickOne($o, candidates)).join("\n");
  const c = outline($c, pickOne($c, candidates)).join("\n");
  const oLines = o.split("\n");
  const cLines = c.split("\n");
  const setC = new Set(cLines);
  const missing = oLines.filter((l) => !setC.has(l));
  const setO = new Set(oLines);
  const extra = cLines.filter((l) => !setO.has(l));

  const overlap = oLines.length ? (oLines.length - missing.length) / oLines.length : 0;
  console.log(`\n=== ${name} ===`);
  console.log(`  origin lines: ${oLines.length}, clone lines: ${cLines.length}, overlap: ${(overlap * 100).toFixed(1)}%`);
  if (missing.length) {
    console.log(`  missing (${missing.length}):`);
    for (const l of missing.slice(0, 10)) console.log("    -", l.trim());
  }
  if (extra.length) {
    console.log(`  extra (${extra.length}):`);
    for (const l of extra.slice(0, 6)) console.log("    +", l.trim());
  }
  return { name, overlap, missing: missing.length, extra: extra.length };
}

/* ------------------------------------------------------------------ setup */

// Use the locally captured product data (the origin rate-limits aggressively).
const products = JSON.parse(fs.readFileSync("public/api/products.json", "utf8"));
const variant = products.products[0].variants.find((v) => v.available);
const variantId = variant.id;

/**
 * Fetches the origin with retry, tolerating rate limiting.
 *
 * The live cart fragments were captured earlier into
 * public/api/cart-fixture.json; those are used as the reference for the cart
 * views so the check does not depend on the origin being reachable.
 */
async function originFetch(path, init) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await fetch(ORIGIN + path, { ...init, headers: { ...(init?.headers || {}), Cookie: cookie() } });
    const text = await res.text();
    if (res.ok && !text.startsWith("<!DOCTYPE html>")) return text;
    await new Promise((r) => setTimeout(r, 2500 * (attempt + 1)));
  }
  return "";
}

/** The captured live cart fragments (mini drawer + cart table). */
const cartFixture = JSON.parse(fs.readFileSync("public/api/cart-fixture.json", "utf8"));

/** The captured live quickshop section fragment. */
const quickshopFixture = JSON.parse(fs.readFileSync("public/api/quickshop.json", "utf8"));

/** A cookie jar for the clone (node's fetch does not persist cookies). */
const cloneJar = new Map();
const cloneCookie = () => [...cloneJar].map(([k, v]) => `${k}=${v}`).join("; ");

/** Fetches from the clone, carrying the session cookie. */
async function cloneFetch(path, init) {
  const res = await fetch(CLONE + path, {
    ...init,
    headers: { ...(init?.headers || {}), Cookie: cloneCookie() },
  });
  for (const c of res.headers.getSetCookie ? res.headers.getSetCookie() : []) {
    const [kv] = c.split(";");
    const i = kv.indexOf("=");
    if (i > 0) cloneJar.set(kv.slice(0, i), kv.slice(i + 1));
  }
  return res;
}

for (const base of [ORIGIN, CLONE]) {
  const res = await fetch(`${base}/cart/add.js`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: variantId, quantity: 3 }),
  });
  absorb(res);
  await res.text();
}

// The captured live fixture contains two specific products; build the exact
// same cart in the clone so the two fragments describe the same contents.
await cloneFetch("/cart/clear.js", { method: "POST" });
for (const item of cartFixture.cart.items) {
  await cloneFetch("/cart/add.js", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: item.variant_id, quantity: item.quantity }),
  });
}

const results = [];

/* ------------------------------------------------------------- cart mini */

const oMini = cartFixture.mini;
const cMini = await (await cloneFetch("/cart?view=mini")).text();
results.push(
  compare("cart mini", oMini, cMini, ["template[data-html='content']", "[data-cart-mini-content]", ".cart-mini-content"])
);

/* ------------------------------------------------------------ cart table */

const oTable = cartFixture.ajax;
const cTable = await (await cloneFetch("/cart?view=_ajax")).text();
results.push(
  compare("cart table", oTable, cTable, ["template[data-html='table']", "[data-cart-table]", ".cart-table"])
);

/* ------------------------------------------------------- predictive search */

// The captured live predictive-search fragments are the reference, so this
// check does not depend on the origin being reachable.
const predictiveSamples = JSON.parse(fs.readFileSync("public/api/predictive-search-samples.json", "utf8"));

for (const q of ["oud", "rose"]) {
  const oPs = predictiveSamples[q] ?? (await originFetch(`/search/suggest?q=${q}&section_id=predictive-search`));
  const cPs = await (await fetch(`${CLONE}/search/suggest?q=${q}&section_id=predictive-search`)).text();
  results.push(
    compare(
      `predictive search "${q}"`,
      oPs,
      cPs,
      [".predictive-search__product-suggestions", ".predictive-search", "[data-predictive-search]"]
    )
  );
}

/* ------------------------------------------------------------- quickshop */

// The captured live quickshop section fragment is the reference; the origin
// answers ?view=quickshop with a full page whose [data-html] block holds the
// same markup the clone serves directly.
const oQsArea = quickshopFixture.splash.html;
const cQs = await (await fetch(`${CLONE}/products/splash?view=quickshop`)).text();
const $cq = cheerio.load(cQs);
const cQsArea = $cq("[data-html]").length ? $cq("[data-html]").html() : cQs;
results.push(compare("quickshop", oQsArea, cQsArea, [".product-area", "[data-html]", "body"]));

/* --------------------------------------------------------------- summary */

console.log("\n================ SUMMARY ================");
for (const r of results) {
  console.log(`${r.name}: overlap ${(r.overlap * 100).toFixed(1)}%  missing ${r.missing}  extra ${r.extra}`);
}
const worst = Math.min(...results.map((r) => r.overlap));
console.log("=========================================");
process.exit(worst > 0.85 ? 0 : 1);
