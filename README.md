# NASO Profumi — clone

A self-contained mirror of [nasoprofumi.com](https://www.nasoprofumi.com)
(a Shopify storefront using the **Atlantic** theme).

Everything runs offline from `public/`: all 201 pages, all images, the theme's
CSS/JS/fonts, and a local server that replays the storefront APIs the theme
calls at runtime — cart, predictive search, quickshop, product
recommendations and the cart drawer.

> **Demo clone only.** This is a local, non-commercial replica built for
> demonstration and testing. It is not affiliated with, endorsed by, or
> connected to Naso Profumi. No orders are processed and no payments are taken
> — checkout is disabled.

```bash
npm install
npm start          # http://localhost:3000
```

## What is included

| Area | Coverage |
| --- | --- |
| Pages | 201 routes — home, 38 collections, 109 products, 22 pages, 2 blogs, 20 blog posts, policies, search, cart, account |
| Images | 380 base originals, served with Shopify's exact CDN resize semantics |
| Runtime APIs | cart (add / change / update / clear), cart drawer + cart table fragments, predictive search, quickshop, product recommendations, product & collection JSON feeds |
| Behaviour | collection sorting and pagination; session cart with a persistent cookie |

## Repository layout

```
lib/config.mjs        paths + fetch helpers shared by the server and scraper
lib/cart.mjs          the stateless, signed-cookie cart
lib/bake.mjs          the build-time HTML transformations
server/server.mjs     the application: pages, storefront APIs, image routing
server/images.mjs     Shopify-compatible CDN resize rules (sharp)
api/index.mjs         Vercel entry point (exports the Express app)
scraper/              the crawl pipeline (not needed at runtime)
public/               the mirrored site
  *.html              201 pages, one per route
  assets/img/<type>/  base image originals
  assets/css|js|fonts theme assets
  api/                captured runtime payloads (products, cart fixture, …)
  services/           the country list the footer's picker needs
.github/workflows/    CI (verify + docker build)
Dockerfile            container build
fly.toml, render.yaml deployment blueprints
vercel.json           Vercel configuration
```

## How it works

### 1. Scraping (`scraper/`)

| Script | Purpose |
| --- | --- |
| `scrape.mjs` | Walks the sitemaps, downloads every page, mirrors the theme assets and images, and rewrites CDN URLs to local paths. |
| `repair-challenges.mjs` | Re-fetches pages the origin served as a Cloudflare challenge (it throttles high-rate clients). |
| `capture-api.mjs` | Captures the runtime payloads: product/collection JSON feeds, per-product quickshop sections and a populated cart fixture. |
| `capture-recommendations.mjs` | Captures the product-recommendation section for every product. |
| `capture-product-cards.mjs` | Extracts the origin's product-card markup so collection grids keep the exact structure. |
| `complete-collection-products.mjs` | Reads each collection's full product list from the rendered pages (the JSON feed caps at 38). |
| `capture-sort-orders.mjs` | Records the origin's rendered order per collection and sort option. |
| `mirror-remaining-assets.mjs` | Mirrors the image types outside `/cdn/shop/files/` (`products`, `articles`, `collections`). |
| `mirror-platform-scripts.mjs` | Mirrors the Shopify platform scripts the pages load from the origin (`api.jquery`, `shopify_common`, `load_feature`, …), which the footer's country picker needs. |
| `fetch-image-bases.mjs`, `fetch-typed-bases.mjs`, `normalize-images.mjs` | Fetch base originals so any size can be generated locally, and normalise every image path to `/assets/img/<type>/<file>`. |
| `prune-regenerable-images.mjs`, `dedupe-images.mjs` | Drop the stored size variants the server can rebuild (and duplicate copies), cutting ~1.2 GB without changing a pixel. |
| `verify-resize-fidelity.mjs` | Checks that a locally rebuilt variant matches the origin's CDN output in dimensions and pixels. |

### 2. Serving (`server/`)

`server.mjs` serves the mirrored pages and implements the Shopify endpoints
the theme expects:

```
GET  /cart.js                      cart state
POST /cart/add.js                  add a line item
POST /cart/change.js               change quantity
POST /cart/update.js               update quantities
POST /cart/clear.js                empty the cart
GET  /cart?view=mini               cart drawer fragment
GET  /cart?view=_ajax              cart table fragment
GET  /search/suggest?q=            predictive search fragment
GET  /recommendations/products     product recommendation fragment
GET  /products/:handle?view=quickshop
GET  /products.json, /collections.json, /collections/:h/products.json
GET  /assets/img/<type>/<file>     images, resized on demand
GET  /healthz                      liveness / readiness probe
```

`lib/config.mjs` holds the paths and fetch helpers shared by the server and
the scraper, so the deployed container only needs `lib/`, `server/` and
`public/`.

### 3. Images

Shopify's CDN derives `NAME_600x901.jpg` from `NAME.jpg` and
`NAME_600x601_crop_center.jpg` from a cover-crop. Those rules were verified
byte-for-byte against the live CDN and are reproduced in `server/images.mjs`
using sharp, with an on-disk cache. The theme's responsive-image runtime
requests sizes the HTML never mentions (it computes them from the viewport),
so the base originals are all mirrored and every size is generated on demand.

### 4. Collections

The origin renders collection pages server-side, so sorting, filtering and
pagination all change which products appear. The clone reproduces this by
reordering the mirrored product grid:

* **Sort** — `?sort_by=title-ascending|title-descending|price-ascending|price-descending|created-ascending|created-descending|best-selling|manual`
* **Paginate** — `?page=N` (32 products per page, like the origin)

Shopify's tie-break inside equal-price groups follows an internal ordering
that the public feeds do not expose, so the rendered order is captured per
collection and sort option and replayed verbatim.

### 5. Footer

The mirrored footer is the origin's own markup, with three adjustments for a
local demo:

* The **country / currency picker** works: the country list is mirrored to
  `/services/javascripts/countries.js` and the Shopify platform scripts
  (`api.jquery`, `shopify_common`, `load_feature`, …) are served locally
  rather than from the origin.
* The **"Information" link**, a dead `#` anchor on the origin, points at
  `/collections`.
* A **demo notice** is appended below the footer:

  > **Demo clone only.** This is a local, non-commercial replica of
  > nasoprofumi.com built for demonstration and testing. It is not affiliated
  > with, endorsed by, or connected to Naso Profumi. No orders are processed
  > and no payments are taken — checkout is disabled.

  Its styles live in `public/assets/css/demo-notice.css`, kept separate from
  the theme's stylesheet so the clone's own additions stay distinguishable
  from the mirrored site.

## Verification

```bash
npm start          # in one terminal
npm run verify     # in another
```

`scraper/verify.mjs` checks every route against the HTML captured from the
origin, resolves every asset the pages reference, and exercises the runtime
endpoints and the full cart flow.

`scraper/verify-fragments.mjs` compares the runtime fragments — cart drawer,
cart table, predictive search and quickshop — against the live origin's markup.

Current results:

```
201/201 routes match the origin's text content
3205/3205 referenced assets resolve
cart mini / cart table / predictive search / quickshop: 100% structural overlap
226/226 checks pass
```

## Deployment

The app is a single Node process serving static files plus the storefront API
emulation. It listens on `PORT` (default `3000`) and exposes `GET /healthz`
for load balancers.

**What it needs:**

| | |
| --- | --- |
| Disk | ~700 MB (the mirrored pages and image originals) |
| Memory | ~210 MB peak — fits a 512 MB instance |
| Runtime | Node 22+, one process, no database |

The image originals are the bulk of the disk. They are needed because the
theme's responsive-image runtime asks for sizes computed from the viewport,
which appear nowhere in the HTML; `server/images.mjs` regenerates any size on
demand and caches it under `public/.imgcache/` (or the temp directory on a
read-only filesystem — set `IMG_CACHE_DIR` to point it at a volume).

### Docker (any host)

```bash
docker build -t naso-clone .
docker run --rm -p 3000:3000 naso-clone
```

### Fly.io — recommended

```bash
fly launch --no-deploy
fly deploy
```

`fly.toml` provisions a 512 MB shared-cpu-1x machine, which the app fits
comfortably. Set `CART_SECRET` so every instance signs the cart cookie with
the same key.

### Render

`render.yaml` is a ready blueprint — connect the repo in Render and it will
build the Dockerfile and deploy. The Starter plan's 512 MB is enough.

### Vercel

```bash
npm i -g vercel
vercel --prod
```

`vercel.json` wires the Express app in `api/index.mjs` to the Node.js runtime
and serves everything in `public/` from the CDN.

Two things to know before deploying there:

* **Use a Pro account.** The mirrored pages and images total ~850 MB, and
  Vercel caps static uploads at 100 MB on Hobby. The function bundle also
  exceeds the standard 250 MB limit, so the deployment needs the large
  functions beta — automatic for projects created after June 2026, otherwise
  set `VERCEL_SUPPORT_LARGE_FUNCTIONS=1`.
* **The image cache is written to the temp directory**, since a function's
  filesystem is read-only outside `/tmp`. Set `IMG_CACHE_DIR` to point it
  somewhere persistent if you want the cache to survive invocations.

The cart is stateless (it lives in a signed cookie), so it works across
serverless instances without any shared store.

### Render

`render.yaml` is a ready blueprint — connect the repo in Render and it will
build the Dockerfile and deploy.

### Continuous integration

`.github/workflows/ci.yml` verifies every route and asset and then builds the
Docker image on every push to `main`.

### Environment variables

| Variable | Purpose |
| --- | --- |
| `PORT` | Port to listen on (default `3000`) |
| `CART_SECRET` | Signs the cart cookie. Set it so every instance shares carts. |
| `IMG_CACHE_DIR` | Where the resized-image cache is written |
| `HTML_CACHE_MAX` | How many pages to keep in memory (default `40`, ~36 MB) |
| `SHARP_CONCURRENCY` | libvips concurrency for resizing (default `2`) |

`.env.example` lists them with notes.

### Notes for production

* The repository carries the mirrored pages and images (~650 MB). The image
  set is the bulk of it: base originals are required because the theme's
  responsive-image runtime requests sizes computed from the viewport, which
  appear nowhere in the HTML. `server/images.mjs` regenerates any size on
  demand and caches the result under `public/.imgcache/`, so mount a volume
  there if the cache should survive restarts.
* Third-party app widgets (judge.me reviews, Quinn shoppable videos, popup
  tools) still load from their original CDNs and will not function offline;
  the theme's own layout is fully local.
* Checkout is not connected — `/checkout` shows a placeholder.
* **The cart is stateless**, held in a signed cookie, so it survives
  restarts and works on platforms where each request may run in a separate
  instance. Set `CART_SECRET` in the environment so every instance signs and
  verifies with the same key; without it a development fallback is used.

## Notes

* The mirror totals ~670 MB, dominated by base image originals.
* `scraper/` re-runs the crawl against the live origin, which rate-limits
  aggressively. The scripts are resumable; `npm run scrape` may need to be
  run more than once to complete.
