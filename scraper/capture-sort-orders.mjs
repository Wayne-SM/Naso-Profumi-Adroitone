/**
 * Captures the exact product order the origin renders for each collection
 * under each sort option.
 *
 * Shopify's tie-break inside equal-price groups follows an internal ordering
 * that cannot be derived from the public JSON feeds, so the rendered order is
 * recorded directly. The clone then replays it verbatim.
 */
import fs from "node:fs";
import path from "node:path";
import * as cheerio from "cheerio";
import { ORIGIN, PUBLIC, writeJson, sleep } from "./lib.mjs";

const SORTS = [
  "manual",
  "best-selling",
  "title-ascending",
  "title-descending",
  "price-ascending",
  "price-descending",
  "created-ascending",
  "created-descending",
];

const collections = JSON.parse(fs.readFileSync(path.join(PUBLIC, "api", "collections.json"), "utf8")).collections;

// A warm session keeps the origin from challenging us.
const jar = new Map();
const cookie = () => [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
function absorb(res) {
  for (const c of res.headers.getSetCookie ? res.headers.getSetCookie() : []) {
    const [kv] = c.split(";");
    const i = kv.indexOf("=");
    if (i > 0) jar.set(kv.slice(0, i), kv.slice(i + 1));
  }
}

// A shared cooldown: when the origin throttles, every request pauses.
let cooldownUntil = 0;
const respectCooldown = async () => {
  const wait = cooldownUntil - Date.now();
  if (wait > 0) await sleep(wait);
};
async function warm() {
  await respectCooldown();
  try {
    const res = await fetch(ORIGIN + "/", { headers: { Cookie: cookie() } });
    absorb(res);
    await res.text();
  } catch {}
  // A short pause keeps the session warm without tripping the rate limiter.
  await sleep(600);
}

/** Fetches one collection page, retrying through rate limits. */
async function fetchPage(url) {
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      await respectCooldown();
      const res = await fetch(url, {
        headers: { Cookie: cookie(), Accept: "text/html" },
      });
      absorb(res);
      const html = await res.text();
      if (res.status === 429) {
        // The origin throttles hard; back off and re-warm the session.
        cooldownUntil = Date.now() + 10000 + Math.random() * 8000;
        await sleep(8000 + Math.random() * 8000);
        await warm();
        continue;
      }
      if (!res.ok) {
        await sleep(2000 + Math.random() * 2000);
        continue;
      }
      if (/cdn-cgi\/challenge-platform|Your connection needs to be verified/.test(html)) {
        await warm();
        await sleep(4000 + Math.random() * 4000);
        continue;
      }
      return html;
    } catch {
      await sleep(2000 + Math.random() * 2000);
    }
  }
  console.error(`\n  ! gave up on ${url}`);
  return "";
}

/**
 * Fetches every page of a collection under one sort, following the pagination
 * links. Pages are fetched one at a time — the origin rate-limits concurrent
 * requests aggressively.
 */
async function fetchAllPages(handle, sort) {
  // "manual" is the collection's default order and has no sort_by parameter.
  const firstUrl =
    sort === "manual"
      ? `${ORIGIN}/collections/${handle}`
      : `${ORIGIN}/collections/${handle}?sort_by=${sort}`;
  const first = await fetchPage(firstUrl);
  if (!first) return [];
  const $ = cheerio.load(first);
  const ids = [];
  $("[data-product-item]").each((i, el) => {
    const cls = ($(el).attr("class") || "").split(/\s+/).find((c) => /^product-\d+$/.test(c));
    if (cls) ids.push(cls.replace("product-", ""));
  });

  let nextHref = $('link[rel="next"]').attr("href");
  let guard = 0;
  while (nextHref && guard++ < 12) {
    const html = await fetchPage(ORIGIN + nextHref);
    if (!html) break;
    const $$ = cheerio.load(html);
    let count = 0;
    $$("[data-product-item]").each((i, el) => {
      const cls = ($$(el).attr("class") || "").split(/\s+/).find((c) => /^product-\d+$/.test(c));
      if (cls) {
        ids.push(cls.replace("product-", ""));
        count++;
      }
    });
    if (!count) break;
    nextHref = $$('link[rel="next"]').attr("href");
    await sleep(900);
  }
  return ids;
}

const orders = {};
let done = 0;
let requests = 0;

// Resume from a previous run if one exists.
const OUT = path.join(PUBLIC, "api", "collection-sort-order.json");
if (fs.existsSync(OUT)) {
  try {
    Object.assign(orders, JSON.parse(fs.readFileSync(OUT, "utf8")));
    done = Object.keys(orders).length;
    console.log(`resuming: ${done} collections already captured`);
  } catch {}
}

for (const coll of collections) {
  const handle = coll.handle;
  if (orders[handle] && SORTS.every((s) => orders[handle][s]?.length)) {
    done++;
    continue;
  }
  orders[handle] = orders[handle] || {};

  for (const sort of SORTS) {
    if (orders[handle][sort]?.length) continue;
    // Re-warm before each sort; the session cookie expires quickly.
    await warm();
    const ids = await fetchAllPages(handle, sort);
    if (!ids.length) {
      console.error(`\n  ! empty result for ${handle} / ${sort}`);
      await sleep(4000);
      continue;
    }
    orders[handle][sort] = ids;
    requests++;
    // Persist incrementally so a run can be resumed.
    writeJson(OUT, orders);
    await sleep(1500);
  }

  done++;
  const counts = SORTS.map((s) => `${s}:${orders[handle][s].length}`).join(" ");
  process.stdout.write(`\r  ${done}/${collections.length} collections (${requests} requests)  ${handle}: ${counts}   `);
}

process.stdout.write("\n");
writeJson(path.join(PUBLIC, "api", "collection-sort-order.json"), orders);
console.log(`done — ${requests} requests`);
