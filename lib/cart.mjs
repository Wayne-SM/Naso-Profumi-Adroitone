/**
 * A stateless, cookie-backed cart.
 *
 * The cart lives in a signed cookie rather than in process memory, so it
 * survives restarts and works on platforms that run each request in a fresh
 * instance (Vercel Functions, Cloudflare Workers) where in-memory state is
 * neither shared nor durable.
 *
 * The cookie holds only line identifiers and quantities; prices and product
 * details are always resolved from the local product data on the server, so
 * the client can never tamper with them.
 */
import crypto from "node:crypto";

export const CART_COOKIE = "naso_cart";

/**
 * The signing secret. Set CART_SECRET in the environment so the same value is
 * used by every instance; the fallback keeps local development working.
 */
const SECRET = process.env.CART_SECRET || "naso-clone-development-secret";

/** Signs a payload; the first 27 chars of an HMAC-SHA256 base64url digest. */
function sign(payload) {
  return crypto.createHmac("sha256", SECRET).update(payload).digest("base64url").slice(0, 27);
}

/** Encodes cart lines into a signed cookie value. */
export function encodeCart(lines) {
  const payload = Buffer.from(JSON.stringify(lines)).toString("base64url");
  return `${payload}.${sign(payload)}`;
}

/** Decodes and verifies a signed cookie value; returns [] when invalid. */
export function decodeCart(raw) {
  if (!raw) return [];
  const idx = raw.lastIndexOf(".");
  if (idx <= 0) return [];

  const payload = raw.slice(0, idx);
  const signature = raw.slice(idx + 1);
  const expected = sign(payload);

  if (signature.length !== expected.length) return [];
  if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return [];

  try {
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
