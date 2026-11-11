/**
 * Extracts the origin's product-card markup for every product.
 *
 * Collection pages render the full card for each product; capturing them lets
 * the clone rebuild collection grids with the exact same markup (including
 * badges, overlays, and the quickshop/add-to-cart controls).
 */
import fs from "node:fs";
import path from "node:path";
import * as cheerio from "cheerio";
import { PUBLIC, writeJson } from "./lib.mjs";

const files = fs.readdirSync(PUBLIC).filter((f) => f.startsWith("collections__") && f.endsWith(".html"));
const cards = new Map();

for (const f of files) {
  const html = fs.readFileSync(path.join(PUBLIC, f), "utf8");
  const $ = cheerio.load(html);
  $("[data-product-item]").each((i, el) => {
    const node = $(el);
    // The product id is in the card's class list ("product-<id>").
    const idClass = (node.attr("class") || "").split(/\s+/).find((c) => /^product-\d+$/.test(c));
    if (!idClass) return;
    const id = idClass.replace("product-", "");
    const link = node.find('a[href*="/products/"]').first().attr("href") || "";
    const handle = link.split("/products/")[1]?.split(/[?#]/)[0];
    if (!handle || cards.has(handle)) return;
    cards.set(handle, $.html(node));
  });
}

console.log(`product cards captured: ${cards.size}`);
writeJson(path.join(PUBLIC, "api", "product-cards.json"), Object.fromEntries(cards));
