/**
 * Completes the per-collection product lists.
 *
 * `/collections/:handle/products.json` caps at 38 products (the storefront
 * limit), so the remaining products have to be read from the rendered pages.
 * The origin throttles hard, so this runs patiently and resumes where it
 * left off.
 */
import fs from "node:fs";
import path from "node:path";
import * as cheerio from "cheerio";
import { ORIGIN, PUBLIC, writeJson, sleep } from "./lib.mjs";

const FILE = path.join(PUBLIC, "api", "collection-products.json");
const data = JSON.parse(fs.readFileSync(FILE, "utf8"));
const products = JSON.parse(fs.readFileSync(path.join(PUBLIC, "api", "products.json"), "utf8")).products;
const byHandle = new Map(products.map((p) => [p.handle, p]));
const byId = new Map(products.map((p) => [String(p.id), p]));

const collections = JSON.parse(fs.readFileSync(path.join(PUBLIC, "api", "collections.json"), "utf8")).collections;

// A warm session keeps the origin from throttling.
const jar = new Map();
const cookie = () => [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
function absorb(res) {
  for (const c of res.headers.getSetCookie ? res.headers.getSetCookie() : []) {
    const [kv] = c.split(";");
    const i = kv.indexOf("=");
    if (i > 0) jar.set(kv.slice(0, i), kv.slice(i + 1));
  }
}
async function warm() {
  try {
    const res = await fetch(ORIGIN + "/", { headers: { Cookie: cookie() } });
    absorb(res);
    await res.text();
  } catch {}
}

async function fetchPage(url) {
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      const res = await fetch(url, { headers: { Cookie: cookie(), Accept: "text/html" } });
      absorb(res);
      const html = await res.text();
      if (res.status === 429) {
        await sleep(15000 + Math.random() * 15000);
        await warm();
        continue;
      }
      if (!res.ok) {
        await sleep(3000);
        continue;
      }
      if (/challenge-platform|connection needs to be verified/.test(html)) {
        await sleep(8000);
        await warm();
        continue;
      }
      return html;
    } catch {
      await sleep(3000);
    }
  }
  return "";
}

const idsOf = (html) => {
  const $ = cheerio.load(html);
  const ids = [];
  $("[data-product-item]").each((i, el) => {
    const cls = ($(el).attr("class") || "").split(/\s+/).find((c) => /^product-\d+$/.test(c));
    if (cls) ids.push(cls.replace("product-", ""));
  });
  return ids;
};

/** Reads a collection's full rendered product list. */
async function readCollection(handle) {
  const ids = [];
  let next = `${ORIGIN}/collections/${handle}`;
  let guard = 0;

  while (next && guard++ < 12) {
    const html = await fetchPage(next);
    if (!html) break;
    const page = idsOf(html);
    if (!page.length) break;
    ids.push(...page);
    const $ = cheerio.load(html);
    const href = $('link[rel="next"]').attr("href");
    next = href ? ORIGIN + href : null;
    await sleep(2500);
  }
  return ids;
}

let done = 0;
for (const coll of collections) {
  const handle = coll.handle;
  const current = (data[handle] || []).filter(Boolean);

  // The mirrored page already holds page 1 of the collection.
  const mirrored = path.join(PUBLIC, `collections__${handle}.html`);
  const page1 = fs.existsSync(mirrored) ? idsOf(fs.readFileSync(mirrored, "utf8")) : [];

  // Only the pages beyond the first need fetching.
  let ids = page1;
  if (current.length > page1.length) {
    const rest = await readCollection(handle);
    ids = rest.length ? rest : page1;
  }

  if (!ids.length) {
    console.error(`  ! ${handle}: no products`);
    done++;
    continue;
  }

  const merged = [];
  const seen = new Set();
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    const existing = current.find((p) => p && String(p.id) === id);
    merged.push(byId.get(id) || (existing && byHandle.get(existing.handle)) || existing);
  }
  for (const p of current) {
    if (p && !seen.has(String(p.id))) merged.push(p);
  }

  data[handle] = merged;
  done++;
  console.log(`  ${handle}: ${current.length} -> ${merged.length}`);
  writeJson(FILE, data);
  await sleep(2000);
}

console.log(`done — ${done} collections`);
