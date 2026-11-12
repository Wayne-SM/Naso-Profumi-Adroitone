/**
 * Local image CDN.
 *
 * The Atlantic theme's responsive-image runtime (`rimg`) rewrites image URLs
 * on the fly using Shopify's CDN naming convention:
 *
 *   NAME.jpg                  -> original
 *   NAME_600x901.jpg          -> fit inside a 600x901 box (aspect preserved)
 *   NAME_600x901_crop_center.jpg -> cover-crop to exactly 600x901
 *   NAME_{size}.jpg           -> template the runtime fills in
 *
 * These rules were verified byte-for-byte against the live CDN, so this module
 * reproduces them locally using sharp.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { PUBLIC } from "../lib/config.mjs";

const IMG_DIR = path.join(PUBLIC, "assets", "img");

// libvips keeps its own memory cache, which dominates the process footprint.
// It is capped so the app fits comfortably on a small instance.
sharp.cache({ memory: 32, files: 20, items: 100 });
sharp.concurrency(Number(process.env.SHARP_CONCURRENCY || 2));

/**
 * Where generated variants are cached.
 *
 * Serverless platforms give a function a read-only filesystem, so the cache
 * falls back to the writable temp directory there. Set IMG_CACHE_DIR to
 * override it (point it at a mounted volume to keep the cache between
 * deployments).
 */
const CACHE_DIR = (() => {
  if (process.env.IMG_CACHE_DIR) return process.env.IMG_CACHE_DIR;
  const preferred = path.join(PUBLIC, ".imgcache");
  try {
    fs.mkdirSync(preferred, { recursive: true });
    fs.accessSync(preferred, fs.constants.W_OK);
    return preferred;
  } catch {
    return path.join(os.tmpdir(), "naso-imgcache");
  }
})();

// "NAME_600x901.jpg" / "NAME_600x601_crop_center.jpg"
// The base is greedy so the LAST "_<W>x<H>" segment is treated as the size.
const SIZE_RE = /^(.+)_(\d+)x(\d+)(_crop_center)?\.([a-z0-9]+)$/i;

/**
 * Resolves a requested image name to its on-disk source.
 *
 * `name` may be either a bare file ("foo.jpg") or a type-scoped path
 * ("files/foo.jpg", "products/foo.jpg") mirroring Shopify's CDN layout.
 *
 * Shopify's CDN also accepts `NAME_crop_center.jpg` (a cover-crop of the
 * original). The store's own markup references a few of these without a size,
 * and the origin 404s on them — so the base original is served instead.
 */
export function resolveImage(name) {
  const safe = path
    .normalize("/" + name)
    .replace(/^\/+/, "")
    .replace(/\.\./g, "");
  const direct = path.join(IMG_DIR, safe);
  if (fs.existsSync(direct)) return { path: direct, kind: "direct" };

  const m = safe.match(SIZE_RE);
  if (!m) return null;

  const [, base, w, h, crop, ext] = m;
  const basePath = path.join(IMG_DIR, base + "." + ext);
  if (!fs.existsSync(basePath)) return null;

  return { path: basePath, kind: "resize", width: Number(w), height: Number(h), crop: Boolean(crop), base: base + "." + ext };
}

/**
 * Falls back to the base original for a `_crop_center` name that has no size
 * component (the origin 404s on these too).
 */
export function resolveImageLenient(name) {
  const info = resolveImage(name);
  if (info) return info;

  const m = name.match(/^(.*)_crop_center\.([a-z0-9]+)$/i);
  if (!m) return null;
  const basePath = path.join(IMG_DIR, `${m[1]}.${m[2]}`);
  if (!fs.existsSync(basePath)) return null;
  return { path: basePath, kind: "direct" };
}
/** Produces the resized bytes for a request, with an on-disk cache. */
export async function renderImage(name) {
  const info = resolveImageLenient(name);
  if (!info) return null;

  if (info.kind === "direct") {
    return { buffer: fs.readFileSync(info.path), type: mimeFor(info.path) };
  }

  // Cache key is derived from the request path, normalized for the filesystem.
  const cacheKey = info.base.replace(/[\\/]/g, "_") + `_${info.width}x${info.height}${info.crop ? "_crop_center" : ""}` +
    path.extname(info.base);
  const cachePath = path.join(CACHE_DIR, cacheKey);
  if (fs.existsSync(cachePath)) {
    return { buffer: fs.readFileSync(cachePath), type: mimeFor(cachePath) };
  }

  const src = fs.readFileSync(info.path);
  const pipeline = sharp(src);

  let out;
  if (info.crop) {
    // Shopify's crop_center scales to cover the box, but never enlarges past
    // the source's own resolution (matches the live CDN).
    const meta = await sharp(src).metadata();
    const coverScale = Math.max(info.width / meta.width, info.height / meta.height);
    if (coverScale > 1) {
      out = await pipeline.resize(info.width, info.height, { fit: "inside", withoutEnlargement: true }).toBuffer();
    } else {
      out = await pipeline
        .resize(info.width, info.height, { fit: "cover", position: "centre", withoutEnlargement: true })
        .toBuffer();
    }
  } else {
    out = await pipeline.resize(info.width, info.height, { fit: "inside", withoutEnlargement: true }).toBuffer();
  }

  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.writeFileSync(cachePath, out);
  return { buffer: out, type: mimeFor(cachePath) };
}

function mimeFor(p) {
  const ext = path.extname(p).toLowerCase();
  return (
    {
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".png": "image/png",
      ".gif": "image/gif",
      ".webp": "image/webp",
      ".svg": "image/svg+xml",
      ".avif": "image/avif",
      ".ico": "image/x-icon",
    }[ext] || "application/octet-stream"
  );
}
