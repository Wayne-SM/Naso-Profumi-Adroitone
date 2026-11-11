/**
 * NASO site scraper.
 *
 * Clones the live Shopify storefront into a static mirror:
 *   - every page rendered by the origin theme
 *   - every asset (CSS/JS/fonts/images) downloaded locally
 *   - every runtime JSON/section endpoint captured so the theme keeps working
 *
 * Output layout (public/):
 *   index.html, collections/<h>.html, products/<h>.html, pages/<h>.html,
 *   blogs/<blog>.html, blogs/<blog>/<article>.html, policies/<h>.html
 *   assets/css/*.css  assets/js/*.js  assets/fonts/*.woff  assets/img/*
 *   api/*.json         (captured runtime payloads)
 */
import fs from "node:fs";
import path from "node:path";
import * as cheerio from "cheerio";
import { DATA, PUBLIC, ORIGIN, ensureDir, writeJson, readJson, grabText, grabBuffer, sleep } from "./lib.mjs";

const CONCURRENCY = 6;
const FORCE = process.argv.includes("--force");

/* ------------------------------------------------------------------ utils */

async function pool(items, worker, limit = CONCURRENCY) {
  const queue = [...items];
  const runners = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    while (queue.length) {
      const item = queue.shift();
      try {
        await worker(item);
      } catch (err) {
        console.error("  ! failed:", item, err.message);
      }
    }
  });
  await Promise.all(runners);
}

const exists = (p) => fs.existsSync(p);

/* ------------------------------------------------------- URL classification */

/** Convert an origin path into a local route key. */
function routeFor(pathname) {
  const clean = pathname.replace(/\/+$/, "") || "/";
  return clean;
}

/** Map a route key to the on-disk html path. */
function htmlPathFor(route) {
  if (route === "/") return path.join(PUBLIC, "index.html");
  const safe = route.replace(/^\//, "").replace(/\//g, "__");
  return path.join(PUBLIC, `${safe}.html`);
}

/* --------------------------------------------------------- asset handling */

/** Rewrite origin CDN URLs to local paths. */
function localizeHtml(html, opts = {}) {
  const assetMap = opts.assetMap || new Map();
  let out = html;

  // Stylesheets / scripts / fonts from the store's own theme assets.
  out = out.replace(
    /(https?:)?\/\/www\.nasoprofumi\.com\/cdn\/shop\/t\/30\/assets\/([A-Za-z0-9._-]+)(\?v=\d+)?/g,
    (m, proto, file) => {
      const key = `theme/${file}`;
      const local = assetMap.get(key) || `/assets/${file}`;
      return local;
    }
  );

  // Shopify CDN image files -> local image route with the size suffix preserved.
  out = out.replace(
    /(https?:)?\/\/(www\.nasoprofumi\.com\/cdn\/shop\/files|cdn\.shopify\.com\/s\/files\/1\/\d+\/\d+\/\d+\/files)\/([^"'?\s)]+)(\?v=\d+)?/g,
    (m, proto, host, file, ver) => {
      const clean = file.replace(/\?.*$/, "");
      // Keep the {size} placeholder literal — the theme's rimg runtime
      // substitutes it client-side, so it must not be percent-encoded.
      const encoded = encodeURIComponent(clean).replace(/%7B/g, "{").replace(/%7D/g, "}");
      return `/assets/img/${encoded}${ver || ""}`;
    }
  );

  // Remaining absolute origin links -> site-relative.
  out = out.replace(/https?:\/\/www\.nasoprofumi\.com(?=\/)/g, "");
  out = out.replace(/https?:\/\/naso-profumi\.myshopify\.com(?=\/)/g, "");

  return out;
}

/* ------------------------------------------------------------- crawl plan */

async function collectUrls() {
  const smIndex = await grabText(`${ORIGIN}/sitemap.xml`);
  const smUrls = [...smIndex.matchAll(/<loc>(.*?)<\/loc>/g)].map((m) => m[1]);
  const subMaps = smUrls.filter((u) => u.includes("sitemap_"));

  const pages = new Set(["/"]);
  const collections = new Set();
  const products = new Set();
  const blogs = new Set();
  const articles = new Set();

  for (const sm of subMaps) {
    const xml = await grabText(sm);
    const locs = [...xml.matchAll(/<loc>(.*?)<\/loc>/g)].map((m) => m[1]);
    for (const loc of locs) {
      const p = new URL(loc).pathname;
      if (p.includes("/collections/") && p.includes("/products/")) continue; // variant URLs
      if (p.startsWith("/collections/")) collections.add(p);
      else if (p.startsWith("/products/")) products.add(p);
      else if (p.startsWith("/pages/")) pages.add(p);
      else if (/^\/blogs\/[^/]+\/[^/]+$/.test(p)) articles.add(p);
      else if (p.startsWith("/blogs/")) blogs.add(p);
    }
  }

  // Extra storefront routes that exist but aren't in the sitemap.
  for (const p of ["/collections/all", "/collections", "/search", "/cart", "/account/login", "/account/register", "/account", "/policies/privacy-policy", "/policies/terms-of-service", "/policies/refund-policy", "/policies/shipping-policy"]) {
    pages.add(p);
  }

  return { pages: [...pages], collections: [...collections], products: [...products], blogs: [...blogs], articles: [...articles] };
}

/* ------------------------------------------------------------ page fetches */

async function fetchPages(urls, label) {
  const results = [];
  await pool(urls, async (url) => {
    const route = routeFor(new URL(url, ORIGIN).pathname);
    const dest = htmlPathFor(route);
    if (!FORCE && exists(dest)) {
      results.push({ route, url, cached: true });
      return;
    }
    const html = await grabText(url);
    ensureDir(path.dirname(dest));
    fs.writeFileSync(dest, html);
    results.push({ route, url, bytes: html.length });
    process.stdout.write(`\r  ${label}: ${results.length}/${urls.length}   `);
  });
  process.stdout.write("\n");
  return results;
}

/* ------------------------------------------------------------ asset mirror */

async function collectAssets(allHtml) {
  const theme = new Map(); // "theme/file.css" -> {url, dest, type}
  const images = new Map(); // "name.jpg" -> {url, dest}

  const imgRe = /(https?:)?\/\/(?:www\.nasoprofumi\.com\/cdn\/shop\/files|cdn\.shopify\.com\/s\/files\/1\/\d+\/\d+\/\d+\/files)\/([^"'?\s)]+)(\?v=\d+)?/g;

  for (const html of allHtml) {
    // theme assets: css/js/woff
    for (const m of html.matchAll(/(?:https?:)?\/\/www\.nasoprofumi\.com\/cdn\/shop\/t\/30\/assets\/([A-Za-z0-9._-]+)/g)) {
      const file = m[1];
      if (!theme.has(file)) {
        const dest = file.endsWith(".woff") || file.endsWith(".woff2") || file.endsWith(".ttf") || file.endsWith(".otf")
          ? path.join(PUBLIC, "assets", "fonts", file)
          : file.endsWith(".css")
            ? path.join(PUBLIC, "assets", "css", file)
            : path.join(PUBLIC, "assets", "js", file);
        theme.set(file, { url: `${ORIGIN}/cdn/shop/t/30/assets/${file}`, dest });
      }
    }
    // images
    for (const m of html.matchAll(imgRe)) {
      const raw = m[2];
      const ver = m[3] || "";
      // skip the "{size}" template marker -> handled at runtime by the rimg script
      if (raw.includes("{size}")) continue;
      const clean = raw.replace(/\?.*$/, "");
      if (!images.has(clean)) {
        images.set(clean, {
          url: `${ORIGIN}/cdn/shop/files/${clean}${ver}`,
          dest: path.join(PUBLIC, "assets", "img", clean),
        });
      }
    }
  }
  return { theme, images };
}

async function downloadAssets(theme, images) {
  ensureDir(path.join(PUBLIC, "assets", "css"));
  ensureDir(path.join(PUBLIC, "assets", "js"));
  ensureDir(path.join(PUBLIC, "assets", "fonts"));
  ensureDir(path.join(PUBLIC, "assets", "img"));

  await pool([...theme.values()], async (a) => {
    ensureDir(path.dirname(a.dest));
    if (!FORCE && exists(a.dest) && fs.statSync(a.dest).size > 0) return;
    const buf = await grabBuffer(a.url);
    fs.writeFileSync(a.dest, buf);
    process.stdout.write(`\r  theme assets: ${[...theme.keys()].indexOf(path.basename(a.dest)) + 1}/${theme.size}   `);
  });
  process.stdout.write("\n");

  let n = 0;
  await pool([...images.values()], async (a) => {
    ensureDir(path.dirname(a.dest));
    if (!FORCE && exists(a.dest) && fs.statSync(a.dest).size > 0) return;
    const buf = await grabBuffer(a.url);
    fs.writeFileSync(a.dest, buf);
    n++;
    process.stdout.write(`\r  images: ${n}/${images.size}   `);
  });
  process.stdout.write("\n");
}

/* -------------------------------------------------------------------- main */

async function main() {
  console.log("NASO scraper");
  console.log("origin:", ORIGIN);

  const urls = await collectUrls();
  console.log(
    `plan: ${urls.pages.length} pages, ${urls.collections.length} collections, ` +
      `${urls.products.length} products, ${urls.blogs.length} blogs, ${urls.articles.length} articles`
  );

  const groups = [
    ["pages", urls.pages.map((p) => ORIGIN + p)],
    ["collections", urls.collections.map((p) => ORIGIN + p)],
    ["products", urls.products.map((p) => ORIGIN + p)],
    ["blogs", urls.blogs.map((p) => ORIGIN + p)],
    ["articles", urls.articles.map((p) => ORIGIN + p)],
  ];

  const fetched = [];
  for (const [label, list] of groups) {
    const res = await fetchPages(list, label);
    fetched.push(...res);
    console.log(`  ${label}: ${res.length} pages`);
  }

  // ---- assets
  const allHtml = [];
  for (const f of fetched) {
    const p = htmlPathFor(f.route);
    if (exists(p)) allHtml.push(fs.readFileSync(p, "utf8"));
  }
  const { theme, images } = await collectAssets(allHtml);
  console.log(`  assets: ${theme.size} theme files, ${images.size} images`);
  await downloadAssets(theme, images);

  // ---- localize HTML
  const assetMap = new Map();
  for (const file of theme.keys()) {
    const dest = theme.get(file).dest;
    const rel = "/" + path.relative(PUBLIC, dest).split(path.sep).join("/");
    assetMap.set(`theme/${file}`, rel);
  }

  let rewritten = 0;
  for (const f of fetched) {
    const p = htmlPathFor(f.route);
    if (!exists(p)) continue;
    const html = fs.readFileSync(p, "utf8");
    fs.writeFileSync(p, localizeHtml(html, { assetMap }));
    rewritten++;
  }
  console.log(`  localized ${rewritten} html files`);

  writeJson(path.join(DATA, "routes.json"), fetched);
  console.log("done.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
