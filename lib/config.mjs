/**
 * Shared config + helpers for the NASO clone.
 *
 * Used by both the server and the scraper. Lives at the repository root so
 * the deployed container only needs `lib/` and `server/`.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const ORIGIN = "https://www.nasoprofumi.com";
export const CDN = "https://cdn.shopify.com";

export const DATA = path.join(ROOT, "data");
export const PUBLIC = path.join(ROOT, "public");
export const CACHE = path.join(ROOT, ".cache");

export const ensureDir = (d) => fs.mkdirSync(d, { recursive: true });
export const readJson = (p, fallback = null) => {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return fallback;
  }
};
export const writeJson = (p, v) => {
  ensureDir(path.dirname(p));
  fs.writeFileSync(p, JSON.stringify(v, null, 1));
};

/** Shopify's money_format for this store: "Rs. {{amount}} INR" style wrapping. */
export function formatMoney(cents, withCurrency = true) {
  const amount = (cents / 100).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return withCurrency ? `Rs. ${amount}` : amount;
}

/** The HTML the theme expects for a money span. */
export const moneySpan = (cents) =>
  `<span class='money'><span class=money>Rs. ${(cents / 100).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}</span></span>`;

/** Async sleep helper for polite crawling. */
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Fetch with retry + a browser-ish UA (the origin rejects default undici UA). */
export async function grab(url, opts = {}) {
  const { retries = 3, timeout = 45000, ...init } = opts;
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeout);
    try {
      const res = await fetch(url, {
        ...init,
        signal: ac.signal,
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
          "Accept-Language": "en-IN,en;q=0.9",
          ...(init.headers || {}),
        },
      });
      clearTimeout(timer);
      return res;
    } catch (err) {
      clearTimeout(timer);
      lastErr = err;
      if (attempt < retries) await sleep(400 * (attempt + 1));
    }
  }
  throw lastErr;
}

export const grabText = async (url, opts) => (await grab(url, opts)).text();
export const grabBuffer = async (url, opts) => Buffer.from(await (await grab(url, opts)).arrayBuffer());
