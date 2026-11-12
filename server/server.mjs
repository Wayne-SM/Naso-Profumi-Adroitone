/**
 * NASO clone server.
 *
 * Serves the scraped static mirror and replays the Shopify runtime endpoints
 * the Atlantic theme calls at runtime:
 *
 *   GET  /cart.js                      cart state as JSON
 *   POST /cart/add.js                  add a line item
 *   POST /cart/change.js               change line-item quantity
 *   POST /cart/update.js               update quantities
 *   POST /cart/clear.js                empty the cart
 *   GET  /cart?view=mini               cart drawer fragment
 *   GET  /cart?view=_ajax              cart table fragment
 *   GET  /search/suggest               predictive search fragment
 *   GET  /recommendations/products     product recommendation fragment
 *   GET  /products/:handle?view=quickshop  quickshop fragment
 *   GET  /products.json, /collections.json, /collections/:h/products.json
 *   PUT  /localization.json            currency/locale switch
 *   GET  /healthz                      liveness / readiness probe
 *
 * Requires only `lib/`, `server/` and `public/` — the scraper is not needed
 * at runtime.
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import express from "express";
import compression from "compression";
import * as cheerio from "cheerio";
import { DATA, PUBLIC, readJson } from "../lib/config.mjs";
import { CART_COOKIE, decodeCart, encodeCart } from "../lib/cart.mjs";
import { fixFooter as applyFooterFixes } from "../lib/footer.mjs";
import { renderImage } from "./images.mjs";

const app = express();
const PORT = Number(process.env.PORT || 3000);

// The pages carry a lot of inline theme markup; gzip cuts the payload
// roughly 5x and keeps local browsing fast.
app.use(compression({ level: 6, threshold: 1024 }));

app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true, limit: "2mb" }));

/* ------------------------------------------------------------------ data */

const apiDir = path.join(PUBLIC, "api");
const loadApi = (name, fallback) => readJson(path.join(apiDir, name), fallback);

const products = loadApi("products.json", { products: [] }).products;
const collections = loadApi("collections.json", { collections: [] }).collections;
const collectionProducts = loadApi("collection-products.json", {});
const recommendations = loadApi("recommendations.json", {});
const quickshops = loadApi("quickshop.json", {});
const cartFixture = loadApi("cart-fixture.json", null);
const globals = loadApi("globals.json", { scripts: {}, moneyFormat: "Rs. {{amount}}" });
const predictiveSamples = loadApi("predictive-search-samples.json", {});

const productByHandle = new Map(products.map((p) => [p.handle, p]));
const productById = new Map(products.map((p) => [p.id, p]));
const variantIndex = new Map();
for (const p of products) for (const v of p.variants) variantIndex.set(String(v.id), { product: p, variant: v });

/**
 * The product-card markup the origin renders for each product, captured while
 * scraping so collection pages keep the exact card structure.
 */
const productCards = new Map(Object.entries(loadApi("product-cards.json", {})));

/**
 * The product order the origin renders for each collection under each sort
 * option. Captured directly, because Shopify's tie-break inside equal-price
 * groups follows an internal ordering that the public feeds do not expose.
 */
const collectionSortOrder = loadApi("collection-sort-order.json", {});

/* ------------------------------------------------------------------ cart */

/**
 * The cart is held in a signed cookie, not in process memory, so it works
 * across restarts and on platforms where each request may run in a separate
 * instance. See lib/cart.mjs.
 */
const MAX_LINES = 40;

function getSession(req, res) {
  const lines = decodeCart(req.cookies?.[CART_COOKIE]);
  const session = { lines, touched: Date.now() };

  /** Writes the current cart back to the cookie. */
  session.persist = () => {
    res.cookie(CART_COOKIE, encodeCart(session.lines), {
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      maxAge: 60 * 60 * 24 * 30,
    });
  };

  return session;
}

// Minimal cookie parsing (no cookie-parser dependency).
app.use((req, res, next) => {
  req.cookies = {};
  const raw = req.headers.cookie;
  if (raw) {
    for (const part of raw.split(";")) {
      const i = part.indexOf("=");
      if (i > 0) req.cookies[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
    }
  }
  next();
});

/* ------------------------------------------------------------ money format */

/**
 * The store's money_format is "<span class='money'><span class=money>Rs.
 * {{amount}}</span></span>". Amounts are in paise, matching Shopify's
 * convention (179900 -> "Rs. 1,799.00").
 *
 * Theme templates wrap that in a further <span class="money">, so the
 * rendered result carries three nested money spans in places like the
 * predictive-search price.
 */
const moneyFormat = globals.moneyFormat || "<span class='money'><span class=money>Rs. {{amount}}</span></span>";

function formatMoney(cents) {
  const amount = (Math.round(cents) / 100).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return moneyFormat.replace(/\{\{\s*amount\s*\}\}/g, amount);
}

/** The bare amount text, without the wrapping spans. */
const moneyText = (cents) =>
  `Rs. ${(Math.round(cents) / 100).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;

/** The money markup exactly as the origin renders it (two nested spans). */
const moneySpan = (cents) => `<span class="money">${formatMoney(cents)}</span>`;

/* --------------------------------------------------------------- cart JSON */

/**
 * Shopify's products.json reports variant prices as rupee strings ("1799.00").
 * The cart API works in paise, so convert once here.
 */
function variantPriceCents(variant) {
  const raw = Number(variant.price);
  return Math.round(raw * 100);
}

function buildCart(session) {
  const items = session.lines
    .map((line) => {
      const entry = variantIndex.get(String(line.id));
      if (!entry) return null; // the variant is no longer available
      const { product, variant } = entry;
      const price = variantPriceCents(variant);
      const linePrice = price * line.quantity;
      const primaryImage = product.images?.[0] || null;
      const imageUrl = primaryImage ? localImageUrl(primaryImage.url) : "";
      return {
        id: variant.id,
        properties: {},
        quantity: line.quantity,
        variant_id: variant.id,
        key: `${variant.id}:${line.key}`,
        title: `${product.title} - ${variant.title}`,
        price,
        original_price: price,
        presentment_price: price / 100,
        discounted_price: linePrice,
        line_price: linePrice,
        original_line_price: linePrice,
        total_discount: 0,
        discounts: [],
        sku: variant.sku,
      grams: variant.grams,
      vendor: product.vendor,
      taxable: false,
      product_id: product.id,
      product_has_only_default_variant: product.variants.length === 1,
      gift_card: false,
      final_price: price,
      final_line_price: linePrice,
      url: `/products/${product.handle}?variant=${variant.id}`,
      featured_image: primaryImage
        ? { ...primaryImage, url: imageUrl }
        : null,
      image: imageUrl || null,
      handle: product.handle,
      requires_shipping: true,
      product_type: product.product_type,
      product_title: product.title,
      product_description: product.body_html,
      variant_title: variant.title,
      variant_options: [variant.title],
      options_with_values: [{ name: product.options?.[0]?.name || "Size", value: variant.title }],
      line_level_discount_allocations: [],
      line_discount_allocations: [],
      discount_allocations: [],
      requires_selling_plan: false,
      selling_plan_allocation: null,
      price_string: moneyText(price),
      compare_at_price_string: variant.compare_at_price ? moneyText(Math.round(variant.compare_at_price * 100)) : null,
      product_title_html: product.title,
    };
  })
    .filter(Boolean);

  const total = items.reduce((sum, i) => sum + i.final_line_price, 0);
  return {
    token: "naso-clone",
    note: null,
    attributes: {},
    original_total_price: total,
    total_price: total,
    total_discount: 0,
    total_weight: 0,
    item_count: items.reduce((n, i) => n + i.quantity, 0),
    items,
    requires_shipping: items.length > 0,
    currency: "INR",
    items_subtotal_price: total,
    cart_level_discount_applications: [],
    discount_codes: [],
  };
}

/* --------------------------------------------------- cart fragment render */

function renderCartMini(session) {
  const cart = buildCart(session);
  const header = "Your cart";
  // The theme's free-shipping threshold is Rs. 75 (free_shipping_min_amount).
  const freeShippingThreshold = 75 * 100;
  const freeShippingBanner =
    cart.total_price >= freeShippingThreshold
      ? `You are eligible for free shipping!<div class="free-shipping-banner__progress-container" aria-hidden="true">
      <div class="free-shipping-banner__progress" style="--width: 100%"></div>
    </div>`
      : `You are ${moneySpan(freeShippingThreshold - cart.total_price)} away from free shipping!<div class="free-shipping-banner__progress-container" aria-hidden="true">
      <div class="free-shipping-banner__progress" style="--width: ${Math.round((cart.total_price / freeShippingThreshold) * 100)}%"></div>
    </div>`;

  let content;
  if (!cart.items.length) {
    content = `
  <div class="cart-mini-content cart-mini-items" data-cart-mini-content>
    
      <div class="cart-mini-empty">
        You don&#39;t have any items in your cart yet.

          <a class="cart-mini__continue-shopping" href="/collections/all">
            Continue shopping
          </a></div>
    
  </div>

  <div class="cart-mini-footer" data-cart-mini-footer>
    
  </div>`;
  } else {
    const rows = cart.items
      .map((item) => {
        const img = sizedImageUrl(item.featured_image?.url, 80, 121);
        return `
<div
          class="cart-mini-item"
          data-cart-mini-item="${item.variant_id}"
        >
          <div class="cart-mini-item-row">
            <div
              class="
                cart-mini-item-column
                cart-mini-item-column-image
              "
            >
              <figure class="cart-mini-item-image">
                <img
      src="${img}"
    alt=""
      data-rimg
    >
              </figure>
            </div>

            <div
              class="
                cart-mini-item-column
                cart-mini-item-column-details
              "
            >
              <span class="cart-mini-item-vendor">${item.vendor}</span>

              <span class="cart-mini-item-title">
                <a href="/products/${item.handle}">
                  ${item.product_title}
                </a>
              </span><dl class="cart-mini-item__product-options"><div class="product-option">
                        <dt class="product-option__name">Size:
                        </dt>
                        <dd class="product-option__value">${item.variant_title}</dd>
                      </div></dl>

              <span class="cart-mini-item-quantity">Qty: ${item.quantity}</span><div class="cart-mini-item-details-footer">
                <div class="cart-mini-item-prices"><span class="cart-mini-item-final-price cart-mini-item-price money">${moneySpan(item.final_price)}</span>
                </div>
                <button
                  class="cart-mini-item-remove"
                  aria-label="remove"
                  role="button"
                  data-cart-mini-item-remove="${item.key}"
                >
                  Remove
                </button>
              </div>
            </div>

          </div>
        </div>`;
      })
      .join("\n");

    content = `
  <div class="cart-mini-content cart-mini-items" data-cart-mini-content>
    ${rows}
  </div>

  <div class="cart-mini-footer" data-cart-mini-footer>
    <div class="cart-mini-subtotal">
        <span class="cart-mini-subtotal-heading">Subtotal</span>
        <span class="cart-mini-subtotal-value money">${moneySpan(cart.total_price)}</span>
      </div>

      <div class="cart-mini__tax-labels">
        <p class="cart-mini__tax-labels-text">Tax included and shipping calculated at checkout
</p>
      </div>

      <div class="cart-mini-actions">
      <a class="cart-mini-actions-cart action-button desaturated" href="/cart">
          View cart
        </a>
        <form class="cart-mini-actions__checkout" action="/cart" method="POST">
          <button class="cart-mini-actions__checkout-button action-button submit-button" type="submit" name="checkout">
            
            <span>Checkout</span>
          </button>
        </form>
      </div>
  </div>`;
  }

  return `<div id="shopify-section-template--21034834854118__main" class="shopify-section"><template data-options>
  {}
</template>

<template data-html="header">
  ${header}
</template><template data-html="free-shipping-banner">${freeShippingBanner}</template><template data-html="content">${content}
</template>
</div>`;
}

function renderCartTable(session) {
  const cart = buildCart(session);
  const rows = cart.items
    .map((item, i) => {
      const img = sizedImageUrl(item.featured_image?.url, 107, 160);
      return `
<tr
        class="
          table-row
          cart-item
          ${i === 0 ? "first" : ""}
          ${i === cart.items.length - 1 ? "last" : ""}
        "
        data-cart-item
        data-cart-item-key="${item.key}"
      >        <td
          class="
            cart-item-column
            product-image
            first
          "
        >
          <div class="image-wrap">
            <a
              class="image"
              href="/products/${item.handle}?variant=${item.variant_id}"
              aria-label="${item.product_title}"
            >
              <img
          src="${img}"
        alt=""
        data-rimg="lazy"
        data-rimg-scale="1"
      >
            </a>
          </div>
        </td>
        <td
          class="
            cart-item-column
            product-item
          "
        >

          <div class="wrap">
            <span class="label vendor">${item.vendor}</span>

            <span class="label title"><a href="/products/${item.handle}?variant=${item.variant_id}" title="">${item.product_title}</a></span><dl class="cart-item__product-options"><div class="product-option">
                      <dt class="product-option__name">Size:
                      </dt>
                      <dd class="product-option__value">${item.variant_title}</dd>
                    </div></dl>
</div>
        </td>

        <td
          class="
            cart-item-column
            cart-item-column-price
            price
          "
        >
          <span class="cart-item-label-mobile">
            Price
          </span>

          <div class="cart-item-column-contents"><span class="cart-item-final-price money">
              <span class="bcpo-cart-item-price" data-key="${item.key}">${moneySpan(item.final_price)}</span>
            </span>
          </div>
        </td>

        <td
          class="
            cart-item-column
            cart-item-column-quantity
            quantity
          "
        >
          <span class="cart-item-label-mobile">
            Quantity
          </span>

          <div class="cart-item-column-contents">
            <input
              class="
                cart-item-quantity
                field
              "
              type="number"
              name="updates[]"
              pattern="\d*"
              value="${item.quantity}"
              data-cart-item-quantity
              aria-label="Quantity"
            >
            <a
              class="cart-item-remove"
              href="/cart/change/${item.variant_id}?line=${i + 1}&quantity=0"
              data-cart-action="remove"
            >
              Remove
            </a>
          </div>
        </td>
        <td
          class="
            cart-item-column
            cart-item-column-total
            total
            last
          "
        >
          <span class="cart-item-label-mobile">
            Total
          </span>

          <div class="cart-item-column-contents"><span class="cart-item-final-price money">
              <span class="bcpo-cart-item-line-price" data-key="${item.key}">${moneySpan(item.final_line_price)}</span>
            </span>
          </div>
        </td>
      </tr>`;
    })
    .join("\n");

  const table = `
<table class="cart-table table" data-cart-table>
  <thead>
    <tr class="table-header">
      <th class="first" colspan=2">Product</th>
      <th class="cart-item-column-price">Price</th>
      <th class="cart-item-column-quantity">Quantity</th>
      <th class="cart-item-column-total last">Total</th>
    </tr>
  </thead>

  <tbody>
    ${rows}
  </tbody>
</table>`;

  return `<div id="shopify-section-template--21034834886886__main" class="shopify-section"><template data-options>
  {
    "totalPrice": "${formatMoney(cart.total_price).replace(/"/g, '\\"')}"
  }
</template>

<template data-html="table">
  ${table}
</template>

<template data-html="discounts">
  
</template>
</div>`;
}

/* --------------------------------------------------------- predictive search */

/**
 * Ranks products the way Shopify's predictive search does.
 *
 * Shopify's ordering for a single term is, in practice: exact title match,
 * then title prefix matches (ordered by title), then other title matches,
 * then body/tag matches. Exact-phrase matches outrank scattered terms.
 */
function searchProducts(query, limit = 10) {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const terms = q.split(/\s+/).filter(Boolean);
  const scored = [];

  for (const p of products) {
    const title = p.title.toLowerCase();
    const handle = p.handle.toLowerCase();
    const tags = (p.tags || []).join(" ").toLowerCase();
    const type = (p.product_type || "").toLowerCase();
    const body = (p.body_html || "").replace(/<[^>]*>/g, " ").toLowerCase();

    let score = 0;
    let matchedTerms = 0;

    for (const t of terms) {
      let termScore = 0;
      if (title === t) termScore += 1000;
      else if (title.startsWith(t)) termScore += 500;
      else if (title.includes(t)) termScore += 300;
      if (handle === t) termScore += 400;
      else if (handle.startsWith(t)) termScore += 250;
      else if (handle.includes(t)) termScore += 150;
      if (tags.includes(t)) termScore += 80;
      if (type.includes(t)) termScore += 50;
      if (body.includes(t)) termScore += 10;
      if (termScore > 0) matchedTerms++;
      score += termScore;
    }

    // Shopify only returns products matching every term.
    if (matchedTerms < terms.length) continue;

    // Full-phrase matches outrank scattered term matches.
    if (title.includes(q)) score += 200;
    if (handle.includes(q)) score += 120;

    scored.push({ p, score });
  }

  scored.sort((a, b) => b.score - a.score || a.p.title.localeCompare(b.p.title));
  return scored.slice(0, limit).map((s) => s.p);
}

/**
 * Maps a Shopify CDN image URL to the local /assets/img route.
 *
 * The shop's files live under /cdn/shop/<type>/ on its own domain and under
 * /s/files/1/<shop>/<type>/ on cdn.shopify.com. Both are stored locally under
 * the matching type folder.
 */
function localImageUrl(url) {
  if (!url) return "";
  const m = String(url).match(
    /(?:www\.nasoprofumi\.com\/cdn\/shop|cdn\.shopify\.com\/s\/files\/1\/\d+\/\d+\/\d+)\/(files|products|articles|collections)\/([^/?]+)/
  );
  if (m) return `/assets/img/${m[1]}/${encodeURIComponent(m[2])}`;
  // Fall back to a bare filename under files/.
  const file = String(url).split("/").pop().split("?")[0];
  return `/assets/img/files/${encodeURIComponent(file)}`;
}

/**
 * Requests a specific rendered size from the local image service, the way the
 * origin asks its CDN for `NAME_80x121.jpg` thumbnails.
 */
function sizedImageUrl(url, width, height) {
  const local = localImageUrl(url);
  if (!local) return "";
  const m = local.match(/^(.*)\/([^/]+)(\.[a-z0-9]+)$/i);
  if (!m) return local;
  const [, dir, name, ext] = m;
  return `${dir}/${name}_${width}x${height}${ext}`;
}

function renderPredictiveSearch(query) {
  const q = query.trim();
  const matches = searchProducts(q, 10);

  // Shopify shows up to 5 product suggestions and up to 7 query suggestions.
  const productMatches = matches.slice(0, 5);
  // The query-suggestion list is only populated when the query is a prefix of
  // a title; otherwise the origin shows the products alone.
  const suggestionMatches = matches.filter((p) => p.title.toLowerCase().startsWith(q.toLowerCase())).slice(0, 7);

  const suggestions = suggestionMatches.map((p, i) => {
    const title = p.title;
    const idx = title.toLowerCase().indexOf(q.toLowerCase());
    let marked;
    if (idx >= 0) {
      marked = `<mark>${escapeHtml(title.slice(0, idx))}</mark>${escapeHtml(title.slice(idx + q.length))}`;
    } else {
      marked = escapeHtml(title);
    }
    return `<li class="predictive-search__query-suggestion">
                  <a class="predictive-search__query-suggestion-link" href="/search?q=${encodeURIComponent(title)}&_pos=${i + 1}&_psq=${encodeURIComponent(q)}&_psid=naso&_ss=e">${marked}</a>
                </li>`;
  });

  const productItems = productMatches
    .map((p, i) => {
      const variant = p.variants.find((v) => v.available) || p.variants[0];
      // Shopify renders the compare-at price when one is set, else the price.
      const shown = variant.compare_at_price
        ? Math.round(Number(variant.compare_at_price) * 100)
        : Math.round(Number(variant.price) * 100);
      const img = p.images?.[0]?.url;
      const imgUrl = sizedImageUrl(img, 50, 76);
      const baseImg = localImageUrl(img);
      const ext = imgUrl.match(/\.[a-z0-9]+$/i)?.[0] || "";
      const template = baseImg.replace(/\.[a-z0-9]+$/i, "") + "_{size}" + ext;
      return `
                  <li class="predictive-search__product-suggestion">
                    <a class="predictive-search__product-suggestion-link" href="/products/${p.handle}?_pos=${i + 1}&_psq=${encodeURIComponent(q)}&_psid=naso&_ss=e">
                      <figure class="predictive-search__product-suggestion-image">
                        <noscript data-rimg-noscript>
                          <img src="${imgUrl}" alt="" data-rimg="noscript" srcset="${imgUrl} 1x, ${sizedImageUrl(img, 100, 152)} 2x, ${sizedImageUrl(img, 150, 228)} 3x, ${sizedImageUrl(img, 200, 304)} 4x">
                        </noscript>
                        <img src="${imgUrl}" alt="" data-rimg="lazy" data-rimg-scale="1" data-rimg-template="${template}" srcset="data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='50' height='76'></svg>">
                      </figure>
                      <div class="predictive-search__product-suggestion-details">
                        <span class="predictive-search__product-suggestion-vendor">${escapeHtml(p.vendor || "")}</span>
                        <span class="predictive-search__product-suggestion-title">${escapeHtml(p.title)}</span>
                        <div class="predictive-search__product-suggestion-price price sale">
                          ${moneySpan(shown)}
                        </div>
                      </div>
                    </a>
                  </li>`;
    })
    .join("\n");

  const header = matches.length
    ? `
      <div class="predictive-search__header">
        
        <div class="predictive-search__header-column">
          <h2 class="predictive-search__title">Suggestions</h2>

          <ul class="predictive-search__query-suggestions">
            ${suggestions.join("\n            ")}
          </ul>
        </div>
      </div>`
    : `
      <div class="predictive-search__header">
        <div class="predictive-search__header-column">
          <p class="predictive-search__no-results">No matching results found.</p>
        </div>
      </div>`;

  return `<div id="shopify-section-predictive-search" class="shopify-section">

<div data-html>
  <div class="predictive-search" data-predictive-search>
    ${header}

        <div class="predictive-search__main">
          <div class="predictive-search__column">
            <h2 class="predictive-search__title">Products</h2>

            <ul class="predictive-search__product-suggestions" data-predictive-search-product-suggestions>
              ${productItems}
            </ul>
          </div>
        </div>

      <div class="predictive-search__footer" data-predictive-search-footer>
        <a
          class="predictive-search__footer-button"
          href="/search?q=${encodeURIComponent(q)}"
        >Search for &quot;${escapeHtml(q)}&quot;</a>
      </div>
  </div>
</div>
</div>`;
}

function escapeHtml(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/* ------------------------------------------------------------------ routes */

// --- static data feeds
app.get("/products.json", (req, res) => {
  res.json({ products });
});

app.get("/collections.json", (req, res) => {
  res.json({ collections });
});

app.get("/collections/:handle/products.json", (req, res) => {
  const handle = req.params.handle;
  const list = collectionProducts[handle];
  if (!list) return res.status(404).json({ errors: "Not Found" });
  res.json({ products: list });
});

// --- cart JSON API
app.get("/cart.js", (req, res) => {
  res.json(buildCart(getSession(req, res)));
});

/** Adds a variant to the cart's line list. */
function addLine(session, variantId, quantity) {
  const existing = session.lines.find((l) => l.id === variantId);
  if (existing) {
    existing.quantity += quantity;
    return;
  }
  if (session.lines.length >= MAX_LINES) return;
  session.lines.push({ id: variantId, quantity, key: Math.random().toString(36).slice(2, 14) });
}

/** Sets a line's quantity; a quantity of 0 or less removes it. */
function setLineQuantity(session, key, quantity) {
  const line = session.lines.find((l) => l.key === key || String(l.id) === String(key));
  if (!line) return;
  const q = Number(quantity);
  if (!q || q <= 0) session.lines = session.lines.filter((l) => l !== line);
  else line.quantity = q;
}

app.post("/cart/add.js", (req, res) => {
  const session = getSession(req, res);
  const body = req.body || {};
  const id = Number(body.id);
  const quantity = Number(body.quantity || 1);
  const entry = variantIndex.get(String(id));
  if (!entry) return res.status(422).json({ status: 422, message: "The product you requested is not available." });
  if (!entry.variant.available) return res.status(422).json({ status: 422, message: "The product you requested is not available." });

  addLine(session, id, quantity);
  session.persist();

  const cart = buildCart(session);
  const item = cart.items.find((i) => i.variant_id === id);
  res.json(item || cart);
});

app.post("/cart/change.js", (req, res) => {
  const session = getSession(req, res);
  setLineQuantity(session, req.body?.id, req.body?.quantity);
  session.persist();
  res.json(buildCart(session));
});

app.post("/cart/update.js", (req, res) => {
  const session = getSession(req, res);
  const updates = req.body?.updates;
  if (Array.isArray(updates)) {
    for (const u of updates) setLineQuantity(session, u.key ?? u.id, u.quantity);
  }
  session.persist();
  res.json(buildCart(session));
});

app.post("/cart/clear.js", (req, res) => {
  const session = getSession(req, res);
  session.lines = [];
  session.persist();
  res.json(buildCart(session));
});

// --- cart fragments
app.get("/cart", (req, res, next) => {
  if (req.query.view === "mini") return res.type("html").send(renderCartMini(getSession(req, res)));
  if (req.query.view === "_ajax") return res.type("html").send(renderCartTable(getSession(req, res)));
  next();
});
// --- predictive search
app.get("/search/suggest", (req, res) => {
  const q = String(req.query.q || "");
  if (req.query.section_id === "predictive-search") {
    return res.type("html").send(renderPredictiveSearch(q));
  }
  res.type("html").send(renderPredictiveSearch(q));
});

// --- recommendations
app.get("/recommendations/products", (req, res) => {
  const productId = Number(req.query.product_id);
  const product = productById.get(productId);
  const body = product ? recommendations[product.handle] : "";

  // The captured payload is the complete section response, matching the
  // structure the theme's asyncview loader expects.
  if (body) {
    const html = rewriteForLocal(body);
    return res.type("html").send(html);
  }

  // Fallback: render the section shell for products without a capture.
  const sectionId = req.query.section_id || "template--21034835673318__product-recommendations";
  res.type("html").send(
    `<div id="shopify-section-${sectionId}" class="shopify-section">\n` +
      `  <script type="application/json" data-section-type="static-product-recommendations" ` +
      `data-section-id="${sectionId}" data-section-data data-section-index="">\n` +
      `    {\n      "settings": {\n        "limit": ${Number(req.query.limit) || 4}\n      },\n` +
      `      "productId": ${productId}\n    }\n  </script>\n\n` +
      `  <div class="content content-area">\n    <section class="product-recommendations" data-html data-product-recommendations></section>\n  </div>\n</div>`
  );
});

// --- quickshop
// The theme requests the product's URL with ?view=quickshop. Product URLs can
// be nested under a collection (/collections/<handle>/products/<handle>).
app.get("/products/:handle", (req, res, next) => {
  if (req.query.view === "quickshop") {
    const html = quickshopFragment(req.params.handle);
    if (html) return res.type("html").send(html);
  }
  next();
});

app.get("/collections/:collection/products/:handle", (req, res, next) => {
  if (req.query.view === "quickshop") {
    const html = quickshopFragment(req.params.handle);
    if (html) return res.type("html").send(html);
  }
  next();
});

/**
 * The captured quickshop payload holds the section's [data-options] JSON and
 * the inner markup of its [data-html] element.
 *
 * The theme's asyncview loader treats a single `[data-html]` element
 * specially, so the fragment must contain exactly one.
 */
function quickshopFragment(handle) {
  const qs = quickshops[handle];
  if (!qs) return null;

  // The captured markup is the <div data-html> element itself; keep only its
  // contents, minus any nested `data-html` attributes.
  let inner = qs.html;
  const m = inner.match(/^<div\s+data-html\s*=\s*"[^"]*"\s*>([\s\S]*)<\/div>\s*$/i);
  if (m) inner = m[1];
  inner = inner.replace(/\sdata-html(\s*=\s*"[^"]*")?/g, "");

  return rewriteForLocal(
    `<div id="shopify-section-template--21034835706086__main" class="shopify-section">\n` +
      `  <script type="application/json" data-section-type="static-quickshop" ` +
      `data-section-id="template--21034835706086__main" data-section-data data-options data-section-index="1">\n` +
      `${qs.options}\n  </script>\n\n` +
      `  <div data-html>\n${inner}\n  </div>\n</div>`
  );
}

// --- localization (country/currency switcher)
app.put("/localization.json", (req, res) => res.json({}));
app.post("/localization.json", (req, res) => res.json({}));

// --- variant section (surface pick-up)
app.get("/variants/:id", (req, res) => {
  res.type("html").send(
    `<div id="shopify-section-surface-pick-up" class="shopify-section"><template data-html="surface-pick-up-embed">
  
  
  
  

</template>

<template data-html="surface-pick-up-items">
  
  
</template>
</div>`
  );
});

// --- checkout placeholder
app.get("/checkout", (req, res) => {
  res.status(200).type("html").send(
    `<!doctype html><html><head><meta charset="utf-8"><title>Checkout</title></head><body style="font-family:sans-serif;padding:40px"><h1>Checkout</h1><p>This is a static clone of nasoprofumi.com. Checkout is not connected.</p><p><a href="/cart">Return to cart</a></p></body></html>`
  );
});

/**
 * The theme's product form posts to /cart/add (no .js) as a no-JS fallback,
 * and the cart's remove link points at /cart/change/:id. Both are honoured so
 * the site works with JavaScript disabled.
 */
app.post("/cart/add", (req, res) => {
  const session = getSession(req, res);
  const id = Number(req.body?.id);
  const quantity = Number(req.body?.quantity || 1);
  const entry = variantIndex.get(String(id));
  if (entry && entry.variant.available) {
    addLine(session, id, quantity);
    session.persist();
  }
  res.redirect(303, "/cart");
});

app.get("/cart/change/:key", (req, res) => {
  const session = getSession(req, res);
  setLineQuantity(session, req.params.key, req.query.quantity ?? 0);
  session.persist();
  res.redirect(303, "/cart");
});

app.post("/cart/change", (req, res) => {
  const session = getSession(req, res);
  setLineQuantity(session, req.body?.id, req.body?.quantity ?? 0);
  session.persist();
  res.json(buildCart(session));
});

/* --------------------------------------------------- cart page rendering */
/**
 * The origin renders /cart server-side: an empty-state message when the cart
 * is empty, and a full form + table when it is not. The clone reproduces both
 * by swapping the cart section of the mirrored page.
 */
function renderCartPage(session) {
  const cart = buildCart(session);
  const file = htmlFiles.get("/cart");
  if (!file) return null;

  let html = fs.readFileSync(file, "utf8");
  if (!cart.items.length) return rewriteForLocal(html);

  const table = renderCartTable(session);
  const m = table.match(/<template data-html="table">([\s\S]*?)<\/template>/);
  const tableHtml = m ? m[1] : "";

  const form = `
        <form class="cart" action="/cart" method="post" data-cart-form>
          ${tableHtml}
          <!-- bcpo done -->
          <div class="cart-tools clearfix">
            <div class="instructions">
              <label for="cart__note">Special instructions</label>
              <textarea class="field" id="cart__note" name="note" ></textarea>
            </div>
            <div class="totals">
              <ul class="cart-discounts" data-cart-discounts>
            </ul>
              <p class="price">
                <span class="money" data-cart-total>
                  <span class="bcpo-cart-original-total">${moneySpan(cart.total_price)}</span>
                </span>
              </p>
              <p class="message">
                Tax included and shipping calculated at checkout
              </p>
              <div class="checkout">
                <noscript>
                  <input class=" action-button desaturated cart-update " type="submit" name="update" value="Update cart">
                </noscript>
                <button class=" action-button cart-submit " type="submit" name="checkout" value="Checkout">
                  <span>Checkout</span>
                </button>
              </div>
            </div>
          </div>
        </form>`;

  // Replace the empty-state paragraph with the populated form.
  html = html.replace(/<p class="empty">[\s\S]*?<\/p>/, form);
  return rewriteForLocal(html);
}

/* --------------------------------------------------- collection rendering */

/**
 * Collections are server-rendered on the origin: sorting, filtering and
 * pagination all change which products appear. The clone reproduces that by
 * reordering / re-slicing the mirrored product grid.
 */

const PER_PAGE = 32;

/**
 * Shopify sorts collection products by the lowest variant price, breaking
 * ties by the product's `updated_at` timestamp.
 *
 * (Verified against the live store for every sort option the theme offers.)
 */
const SORTS = {
  "title-ascending": (a, b) => a.title.localeCompare(b.title) || updatedTie(a, b),
  "title-descending": (a, b) => b.title.localeCompare(a.title) || updatedTie(a, b),
  "price-ascending": (a, b) => minPrice(a) - minPrice(b) || updatedTie(a, b),
  "price-descending": (a, b) => minPrice(b) - minPrice(a) || updatedTie(a, b),
  "created-ascending": (a, b) => String(a.created_at).localeCompare(String(b.created_at)) || updatedTie(a, b),
  "created-descending": (a, b) => String(b.created_at).localeCompare(String(a.created_at)) || updatedTie(a, b),
};

/** Tie-break by product update time, then by id for full determinism. */
const updatedTie = (a, b) => String(a.updated_at).localeCompare(String(b.updated_at)) || a.id - b.id;

const minPrice = (p) => {
  const prices = (p.variants || []).map((v) => Number(v.price)).filter((n) => !Number.isNaN(n));
  return prices.length ? Math.min(...prices) : Infinity;
};

/** The products of a collection, in the collection's own order. */
function collectionProductList(handle) {
  const list = collectionProducts[handle];
  if (!list) return null;
  return list.map((p, i) => {
    const full = productByHandle.get(p.handle);
    return { ...(full || p), position: i };
  });
}

/**
 * Renders a collection page with the requested sort / filter / page applied.
 *
 * The mirrored HTML holds the default product grid; this rebuilds the grid
 * from the local product data and swaps it in, then updates the pagination
 * links to match.
 */
function renderCollectionPage(handle, query) {
  const file = htmlFiles.get(`/collections/${handle}`);
  if (!file) return null;

  const list = collectionProductList(handle);
  if (!list) {
    // No captured product list: fall back to the mirrored page, and only
    // honour pagination when the collection's data is unavailable.
    return rewriteForLocal(fs.readFileSync(file, "utf8"));
  }
  let filtered = list.slice();

  // ---- filters
  // The theme does not expose price filtering, and the origin ignores those
  // query parameters too, so the product set is left untouched.

  // ---- sort
  const sortKey = query.sort_by;
  const captured = collectionSortOrder[handle];

  if (captured && captured[sortKey]?.length) {
    // The origin's exact order for this sort was captured; replay it.
    const byId = new Map(filtered.map((p) => [String(p.id), p]));
    const ordered = captured[sortKey].map((id) => byId.get(String(id))).filter(Boolean);
    // Include anything not present in the capture (e.g. filtered out ones).
    for (const p of filtered) if (!ordered.includes(p)) ordered.push(p);
    filtered = ordered;
  } else if (sortKey && SORTS[sortKey]) {
    filtered.sort(SORTS[sortKey]);
  } else if (sortKey === "best-selling") {
    // Rank by how many collections list the product (a good proxy).
    const counts = new Map();
    for (const items of Object.values(collectionProducts)) {
      for (const p of items) counts.set(p.handle, (counts.get(p.handle) || 0) + 1);
    }
    filtered.sort((a, b) => (counts.get(b.handle) || 0) - (counts.get(a.handle) || 0) || a.id - b.id);
  }

  // ---- paginate
  const page = Math.max(1, Number(query.page) || 1);
  const total = filtered.length;
  const pageCount = Math.max(1, Math.ceil(total / PER_PAGE));
  const start = (page - 1) * PER_PAGE;
  const shown = filtered.slice(start, start + PER_PAGE);

  let html = fs.readFileSync(file, "utf8");

  // Rebuild the product grid from the local data. The replacement always
  // happens — a page past the end renders an empty grid, as the origin does.
  const grid = buildProductGrid(handle, shown);
  html = replaceProductGrid(html, grid);

  // Update the pagination links.
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) if (k !== "page" && v != null) params.set(k, v);
  const linkFor = (p) => {
    const sp = new URLSearchParams(params);
    if (p > 1) sp.set("page", String(p));
    const qs = sp.toString();
    return `/collections/${handle}${qs ? "?" + qs : ""}`;
  };

  html = html.replace(/<link rel="prev"[^>]*>/g, page > 1 ? `<link rel="prev" href="${linkFor(page - 1)}">` : "");
  html = html.replace(
    /<link rel="next"[^>]*>/g,
    page < pageCount ? `<link rel="next" href="${linkFor(page + 1)}">` : ""
  );

  // Add the pagination links the mirrored page does not carry.
  const links = [];
  if (page > 1) links.push(`  <link rel="prev" href="${linkFor(page - 1)}">`);
  if (page < pageCount) links.push(`  <link rel="next" href="${linkFor(page + 1)}">`);
  if (links.length && !/<link rel="next"/.test(html)) {
    html = html.replace("</head>", `${links.join("\n")}\n</head>`);
  }

  return rewriteForLocal(html);
}

/**
 * Replaces the contents of the collection's product grid.
 *
 * The grid <ul> contains nested markup (promo blocks with their own lists),
 * so the closing tag has to be matched by nesting depth rather than lazily.
 */
function replaceProductGrid(html, grid) {
  const open = html.match(/<ul[^>]*class="[^"]*product-list[^"]*"[^>]*>/i);
  if (!open) return html;

  const start = open.index + open[0].length;
  let depth = 1;
  let pos = start;
  const tagRe = /<\/?ul\b[^>]*>/gi;

  while (pos < html.length) {
    tagRe.lastIndex = pos;
    const m = tagRe.exec(html);
    if (!m) break;
    const isClose = m[0].startsWith("</");
    depth += isClose ? -1 : 1;
    pos = m.index + m[0].length;
    if (depth === 0) {
      return html.slice(0, start) + grid + html.slice(pos);
    }
  }
  return html;
}

/**
 * Renders the product cards for a collection page, reusing the card markup
 * the origin emits for each product.
 */
function buildProductGrid(handle, products) {
  const cards = [];
  products.forEach((p, i) => {
    const card = productCards.get(p.handle);
    if (card) {
      cards.push(normalizeCard(card, p, i, products.length));
      return;
    }
    cards.push(fallbackProductCard(p, handle, i, products.length));
  });
  return cards.join("\n");
}

/**
 * Rewrites a captured product card for the clone: plain product URLs and the
 * first/last markers for this page's position.
 */
function normalizeCard(card, p, index, total) {
  const $ = cheerio.load(`<ul>${card}</ul>`, null, false);
  const li = $("li").first();

  li.find('a[href*="/products/"]').each((i, el) => {
    $(el).attr("href", `/products/${p.handle}`);
  });
  li.find("[data-product-url]").each((i, el) => {
    $(el).attr("data-product-url", `/products/${p.handle}`);
  });

  const cls = new Set((li.attr("class") || "").split(/\s+/).filter(Boolean));
  cls.delete("first");
  cls.delete("last");
  if (index === 0) cls.add("first");
  if (index === total - 1) cls.add("last");
  li.attr("class", [...cls].join(" "));

  return $.html(li);
}

/**
 * A product card in the theme's markup, for products whose captured card was
 * not stored (the origin renders the same markup for every product).
 */
function fallbackProductCard(p, _collectionHandle, index = 0, total = 1) {
  const variant = (p.variants || []).find((v) => v.available) || (p.variants || [])[0];
  const img = p.images?.[0]?.url;
  const imgUrl = sizedImageUrl(img, 600, 900);
  const price = variant ? Math.round(Number(variant.price) * 100) : 0;
  const compare = variant?.compare_at_price ? Math.round(Number(variant.compare_at_price) * 100) : null;
  const soldOut = !variant?.available;
  const ext = imgUrl.match(/\.[a-z0-9]+$/i)?.[0] || "";
  const template = img ? localImageUrl(img).replace(/\.[a-z0-9]+$/i, "") + "_{size}" + ext : "";
  const imgTag = img
    ? `<img src="${imgUrl}" alt="" data-rimg="lazy" data-rimg-scale="1" data-rimg-template="${template}" srcset="data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='600' height='900'></svg>">`
    : "";

  return `
<li class="
    product
    product-${p.id}
    ${index === 0 ? "first" : ""}
    ${index === total - 1 ? "last" : ""}
  " data-product-item>
  <div class="product-inner">
    <figure class="product-card-figure">
      ${imgTag}
      <a href="/products/${p.handle}" tabindex="-1" aria-label="${escapeHtml(p.title)}"></a>
      <a class="product-card-overlay" href="/products/${p.handle}" aria-label="${escapeHtml(p.title)}">
        <div class="product-card-overlay-content">
  <div class="product-card-interactions">
      <button class="product-card-interaction product-card-interaction-quickshop" data-product-card-interaction-quickshop data-product-url="/products/${p.handle}">
        Quickshop
      </button>
      <button class="product-card-interaction product-card-interaction-addtocart" ${soldOut ? "disabled" : ""} data-product-card-interaction-addtocart data-product-variant-id="${variant?.id || ""}" data-cart-redirect="false">
        <span class="product-card-interaction-addtocart-available">
            ${soldOut ? "Sold out" : "Add to cart"}
        </span>
        <span class="product-card-interaction-addtocart-error">
          Unavailable
        </span>
      </button>
  </div>
        </div>
      </a>
    </figure>
      <div class="product-card-footer">
  <div class="product-card-details">
            <a href="/products/${p.handle}"><span class="product-card__title">${escapeHtml(p.title)}</span></a>
            <div class="price">
              ${compare ? `<span class="money money--compare">${moneySpan(compare)}</span>` : ""}
              <span class="money">${moneySpan(price)}</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  </li>`;
}

/* --------------------------------------------------- static page delivery */

const htmlFiles = new Map();
function indexHtmlFiles(dir = PUBLIC, prefix = "") {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (["api", "assets"].includes(entry.name)) continue;
      indexHtmlFiles(path.join(dir, entry.name), prefix + entry.name + "/");
    } else if (entry.name.endsWith(".html")) {
      const stem = prefix + entry.name.replace(/\.html$/, "");
      // "index.html" -> "/", "collections__perfume.html" -> "/collections/perfume"
      const route = "/" + stem.replace(/(^|\/)index$/, "").replace(/__/g, "/");
      htmlFiles.set(route.replace(/\/+$/, "") || "/", path.join(dir, entry.name));
    }
  }
}
indexHtmlFiles();

// Rewritten HTML is cached in memory (the source files never change at runtime).
const htmlCache = new Map();

app.get("/assets/img/*splat", async (req, res) => {
  // Express 5 exposes named wildcards as an array of path segments.
  const segments = Array.isArray(req.params.splat) ? req.params.splat : [req.params.splat];
  const file = segments.map((s) => decodeURIComponent(s)).join("/");
  try {
    const img = await renderImage(file);
    if (!img) return res.status(404).end();
    res.set("Content-Type", img.type);
    res.set("Cache-Control", "public, max-age=31536000, immutable");
    res.send(img.buffer);
  } catch {
    res.status(500).end();
  }
});

app.use("/assets", express.static(path.join(PUBLIC, "assets"), { maxAge: "1h" }));

// The theme loads the country list from the storefront's services path; it
// powers the footer's country / currency picker.
app.use("/services/javascripts", express.static(path.join(PUBLIC, "services", "javascripts"), { maxAge: "1h" }));

// Liveness/readiness probe for the container platform. Registered before the
// catch-all page handler so it is never shadowed by it.
app.get("/healthz", (req, res) => {
  res.json({
    status: "ok",
    pages: htmlFiles.size,
    products: products.length,
    collections: collections.length,
    uptime: Math.round(process.uptime()),
  });
});

// Serve the mirrored pages. Shopify-style trailing-slash-free paths.
app.use((req, res, next) => {
  if (req.method !== "GET" && req.method !== "HEAD") return next();
  let route = req.path.replace(/\/+$/, "") || "/";
  const candidates = [route, route + "/"];

  // The cart page is rendered per session.
  if (route === "/cart") {
    const html = renderCartPage(getSession(req, res));
    if (html) return res.type("html").send(html);
  }

  // Collection pages honour sort / filter / page query parameters.
  const collMatch = route.match(/^\/collections\/([^/]+)$/);
  if (collMatch) {
    const html = renderCollectionPage(collMatch[1], req.query);
    if (html) return res.type("html").send(html);
  }

  for (const c of candidates) {
    if (htmlFiles.has(c)) {
      let html = htmlCache.get(c);
      if (html === undefined) {
        html = rewriteForLocal(fs.readFileSync(htmlFiles.get(c), "utf8"));
        htmlCache.set(c, html);
      }
      return res.type("html").send(html);
    }
  }
  // 404 page
  const notFound = htmlFiles.get("/pages/page-1") || htmlFiles.get("/");
  if (notFound) {
    let html = htmlCache.get("__404");
    if (html === undefined) {
      html = rewriteForLocal(fs.readFileSync(notFound, "utf8"));
      htmlCache.set("__404", html);
    }
    return res.status(404).type("html").send(html);
  }
  next();
});

/* ------------------------------------------------------- local rewriting */

/**
 * The scraped HTML still references the live origin for a few runtime bits
 * (Shopify globals, CDN asset URLs). Point them at the clone.
 */
function rewriteForLocal(html) {
  let out = html;

  // Theme + shopify CDN assets -> local /assets
  out = out.replace(
    /(?:https?:)?\/\/www\.nasoprofumi\.com\/cdn\/shop\/t\/30\/assets\/([A-Za-z0-9._-]+)(\?v=\d+)?/g,
    (m, file) => {
      if (/\.(woff2?|ttf|otf)$/i.test(file)) return `/assets/fonts/${file}`;
      if (/\.css$/i.test(file)) return `/assets/css/${file}`;
      if (/\.js$/i.test(file)) return `/assets/js/${file}`;
      if (/\.(png|jpe?g|gif|svg|webp)$/i.test(file)) return `/assets/img/${file}`;
      return `/assets/js/${file}`;
    }
  );

  // Shopify CDN images -> local /assets/img
  out = out.replace(
    /(?:https?:)?\/\/(?:www\.nasoprofumi\.com\/cdn\/shop\/(files|products|articles|collections)|cdn\.shopify\.com\/s\/files\/1\/\d+\/\d+\/\d+\/(files|products|articles|collections))\/([^"'?\s)]+)(\?v=\d+)?/g,
    (m, t1, t2, file) => {
      const type = t1 || t2;
      const clean = file.replace(/\?.*$/, "");
      const encoded = encodeURIComponent(clean).replace(/%7B/g, "{").replace(/%7D/g, "}");
      return `/assets/img/${type}/${encoded}`;
    }
  );

  // Remaining absolute same-site links -> relative
  out = out.replace(/https?:\/\/www\.nasoprofumi\.com(?=\/)/g, "");

  // The exit-interstitial hijacks every outbound link; neutralize it locally.
  out = out.replace(/<script data-source-attribution="shopify\.exit_interstitial">[\s\S]*?<\/script>/g, "");

  // Point the Shopify runtime globals at the clone.
  out = out.replace(/Shopify\.shop\s*=\s*"[^"]*"/g, 'Shopify.shop = "naso-profumi.myshopify.com"');
  out = out.replace(/Shopify\.cdnHost\s*=\s*"[^"]*"/g, 'Shopify.cdnHost = ""');
  out = out.replace(/"domain":"[^"]*"/g, '"domain":"localhost"');
  out = out.replace(/"backendHost":"[^"]*"/g, '"backendHost":""');

  out = fixFooter(out);

  // The demo notice's stylesheet.
  if (!out.includes("/assets/css/demo-notice.css")) {
    out = out.replace(
      "</head>",
      '  <link rel="stylesheet" href="/assets/css/demo-notice.css">\n</head>'
    );
  }

  return out;
}

/* ------------------------------------------------------------------ footer */

/**
 * Footer corrections.
 *
 * The mirrored footer is the origin's own markup, but two things need
 * adjusting for a local demo:
 *
 *   1. The "Information" link is a dead `#` anchor on the origin (it opens a
 *      dropdown that is not part of the static build). It is pointed at the
 *      sitemap instead so it goes somewhere useful.
 *   2. A demo notice is appended below the footer.
 *
 * The shared implementation lives in lib/footer.mjs so the build can bake the
 * same corrections into the files (a statically served page then matches one
 * rendered at request time).
 */
function fixFooter(html) {
  return applyFooterFixes(html);
}

/* --------------------------------------------------- static page delivery */

// Exported so a serverless entry point can hand the app to the platform
// instead of listening (see api/index.mjs).
export default app;

// Only listen when run directly, not when imported by a serverless runtime.
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  const server = app.listen(PORT, () => {
    console.log(`NASO clone running at http://localhost:${PORT}`);
    console.log(`  pages: ${htmlFiles.size}, products: ${products.length}, collections: ${collections.length}`);
  });

  // Shut down cleanly so container platforms can restart without dropping
  // in-flight requests.
  for (const signal of ["SIGTERM", "SIGINT"]) {
    process.on(signal, () => {
      console.log(`\n${signal} received, closing server...`);
      server.close(() => process.exit(0));
      // Force-close if connections linger.
      setTimeout(() => process.exit(0), 5000).unref();
    });
  }
}
