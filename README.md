# Naso Profumi — Storefront

A self-hosted web storefront for **Naso Profumi**, built as an internship
project. The client supplied the brand direction, page structure, catalogue
content, imagery, and campaign creatives; this repository contains the
application that serves them — the complete shopping experience, running
independently of the original commerce platform.

> **Demo only.** This is a local, non-commercial site of nasoprofumi built
> for demonstration and testing. It is not affiliated with, endorsed by, or
> connected to Naso Profumi. No orders are processed and no payments are
> taken — checkout is disabled.

```bash
npm install
npm start          # http://localhost:3000
```

---

## Overview of the Naso site

Naso Profumi is a luxury fragrance house. The storefront covers:

| Area | Content |
| --- | --- |
| **Catalogue** | Extrait de parfum, eau de parfum, attars, candles, reed diffusers, diffuser oils, body care, incense and gift sets |
| **Collections** | Signature lines, best sellers, seasonal and festive edits, gifting, and designer collaborations (Naso x Aroka, Naso x Sambhavi, Naso x Jade, Rezon x Naso) |
| **Editorial** | Brand story, vision, principles, stockists, the *Venue Scenting* journal, policies and FAQs |
| **Shopping** | Collection browsing with sort and pagination, product detail with variants, quick-shop, predictive search, cart drawer and cart page, product recommendations |
| **Design language** | Editorial luxury layout — large imagery, restrained typography, generous whitespace, a persistent cart drawer and a country/currency selector in the footer |

---

## Objectives

1. Deliver the storefront the client specified — approved design, navigation, page structure and brand feel.
2. Reproduce the complete shopping journey: home → collection → product → cart, plus search, quick-shop and recommendations.
3. Make the application fully self-hosted, with no runtime dependency on the original commerce platform.
4. Serve responsive imagery at every size the design requests, with the correct crop.
5. Keep the cart functional without a database, across restarts and instances.
6. Make deployment repeatable with a container build, health checks and a single deploy command.
7. Prove quality automatically — every route, asset and interactive endpoint checked.
8. Keep the demo safe: no payments, checkout disabled, clear demo notice.

---

## Client-provided inputs

### Design direction and requirements
- Luxury fragrance positioning: editorial layout, large imagery, restrained typography, generous whitespace.
- Information architecture: home, collections, product pages, brand-story pages, journal, policies, contact.
- Navigation and footer: main menu, collection menus, country/currency selector, newsletter signup.
- Interaction requirements: cart drawer, quick-shop from collection grids, predictive search, product recommendations.
- Responsive behaviour for mobile and desktop.

### Content
- Product catalogue: names, variants, prices, descriptions and SKUs.
- Collection definitions and the order products should appear in.
- Editorial copy: brand story, journal articles, shipping, refund and privacy policies.

### Imagery
- Product photography (perfume bottles, candles, gift sets, diffusers).
- Lifestyle and banner imagery for the hero and collection headers.
- Brand marks and logos.

### Campaign creatives
- Promotional banners and campaign artwork for seasonal and collection launches.
- Ad copy and calls to action.
- Placement guidance for the hero slot, collection banners and promotional sections.

### Acceptance criteria
- Match the approved design and content structure.
- Work across desktop and mobile breakpoints.
- Demo-only: no live payments and no order processing.

---

## Technologies used

| Technology | Role |
| --- | --- |
| **Node.js 22** (ES modules) | Application runtime |
| **Express 5** | HTTP server, routing and middleware |
| **sharp / libvips** | On-demand image resizing and cropping |
| **cheerio** | Server-side HTML parsing and manipulation |
| **HTML5 / CSS3 / vanilla JavaScript** | Storefront front end |
| **HMAC-SHA256 signed cookies** (`node:crypto`) | Stateless, tamper-proof cart |
| **Docker** (multi-stage build) | Reproducible container image |
| **Fly.io** | Production hosting (512 MB machine) |
| **Render** | Alternative hosting via blueprint |
| **GitHub Actions** | CI — verification and container build on every push |
| **Git / GitHub** | Version control |
| **Vercel** | Evaluated as an alternative target |
| **PowerShell** | Development and operational scripts |

---

## What the application provides

### Pages and routing
**201 routes** — home, 38 collections, 109 products, 22 content pages, 2 blogs
with 20 posts, policies, search, cart and account pages.

### Storefront runtime
The theme expects a set of commerce endpoints. They are implemented locally:

| Endpoint | Purpose |
| --- | --- |
| `GET /cart.js` | Cart state as JSON |
| `POST /cart/add.js` | Add a line item |
| `POST /cart/change.js` | Change a line-item quantity |
| `POST /cart/update.js` | Update quantities |
| `POST /cart/clear.js` | Empty the cart |
| `GET /cart?view=mini` | Cart drawer fragment |
| `GET /cart?view=_ajax` | Cart table fragment |
| `GET /search/suggest?q=` | Predictive search fragment |
| `GET /recommendations/products` | Product recommendation fragment |
| `GET /products/:handle?view=quickshop` | Quick-shop section |
| `GET /products.json`, `/collections.json` | Catalogue feeds |
| `GET /assets/img/<type>/<file>` | Images, resized on demand |
| `GET /healthz` | Liveness / readiness probe |

### Collection merchandising
- Sorting by title, price, date, best-selling and manual order.
- Pagination at 32 products per page, following the client's merchandising order.

### Images
The theme's responsive-image runtime requests sizes computed from the viewport,
which never appear in the markup. The **380 base originals** are stored, and
every `WxH` or cover-crop variant is generated on demand with the platform's
CDN resize semantics, then cached on disk.

### Cart
The cart lives in an **HMAC-signed cookie**, so it survives restarts and works
across instances without a database or shared session store. Tampered cookies
are rejected.

### Footer
- The country/currency picker works offline: the country list and the platform
  scripts it needs are served locally.
- The "Information" link points at `/collections`.
- The demo notice is appended below the footer, styled by
  `public/assets/css/demo-notice.css`.

### Performance
- HTML transformations are applied at **build time**, so requests do no rewriting.
- The page cache is a bounded LRU (default 40 pages).
- The libvips cache and concurrency are capped.
- Peak memory after visiting every page: **~210 MB**, down from 459 MB.

---

## Architecture

A single stateless Node process serves the pages, the storefront endpoints and
the images. There is no database and no external service at runtime.

```
Browser ──▶ Express (server/server.mjs)
              ├─ pages            public/*.html (baked at build time)
              ├─ storefront APIs  cart, search, quick-shop, recommendations
              ├─ images           server/images.mjs ──▶ sharp ──▶ disk cache
              └─ cart             signed cookie (lib/cart.mjs)
```

---

## Repository layout

```
lib/config.mjs        paths + fetch helpers shared by the server and pipeline
lib/cart.mjs          the stateless, signed-cookie cart
lib/bake.mjs          the build-time HTML transformations
server/server.mjs     the application: pages, storefront APIs, image routing
server/images.mjs     CDN-compatible resize rules (sharp)
api/index.mjs         Vercel entry point (exports the Express app)
scraper/              content ingestion pipeline (not needed at runtime)
public/               the site
  *.html              201 pages, one per route
  assets/img/<type>/  base image originals
  assets/css|js|fonts theme assets
  api/                runtime payloads (products, cart fixture, …)
  services/           the country list the footer's picker needs
.github/workflows/    CI (verify + docker build)
Dockerfile            container build
fly.toml, render.yaml deployment blueprints
vercel.json           Vercel configuration
```

---

## Content pipeline

`scraper/` is a one-off pipeline that brings the client's published pages,
assets and runtime payloads into the project and normalises asset paths. It is
**not needed at runtime** — the deployed container only needs `lib/`, `server/`
and `public/`.

| Script | Purpose |
| --- | --- |
| `scrape.mjs` | Imports every published page, downloads theme assets and images, rewrites asset URLs to local paths. |
| `repair-challenges.mjs` | Re-fetches pages that were served behind a bot challenge during the import. |
| `capture-api.mjs` | Records the runtime payloads the storefront needs: product/collection feeds, quick-shop sections and a populated cart fixture. |
| `capture-recommendations.mjs` | Records the product-recommendation section for every product. |
| `capture-product-cards.mjs` | Extracts product-card markup so collection grids keep the exact structure. |
| `complete-collection-products.mjs` | Reads each collection's full product list from the rendered pages. |
| `capture-sort-orders.mjs` | Records the rendered order per collection and sort option. |
| `mirror-remaining-assets.mjs` | Imports image types outside the main files directory. |
| `mirror-platform-scripts.mjs` | Imports the platform scripts the footer's country picker needs. |
| `fetch-image-bases.mjs`, `fetch-typed-bases.mjs`, `normalize-images.mjs` | Fetch base originals and normalise every image path to `/assets/img/<type>/<file>`. |
| `prune-regenerable-images.mjs`, `dedupe-images.mjs` | Drop stored size variants the server can rebuild (and duplicate copies), cutting ~1.2 GB without changing a pixel. |
| `verify-resize-fidelity.mjs` | Confirms a rebuilt variant matches the reference CDN output in dimensions and pixels. |
| `bake.mjs` | Applies the build-time HTML transformations. |

The pipeline is resumable: the source site rate-limits high-volume clients, so
`npm run scrape` may need more than one run.

---

## Verification

```bash
npm start          # in one terminal
npm run verify     # in another
```

`scraper/verify.mjs` checks every route against the approved reference pages,
resolves every asset the pages reference, and exercises the runtime endpoints
and the full cart flow.

`scraper/verify-fragments.mjs` compares the runtime fragments — cart drawer,
cart table, predictive search and quick-shop — with the reference markup.

---

## Outcomes

### Measured results

| Metric | Result |
| --- | --- |
| Routes served | **201 / 201** |
| Products | **109** |
| Collections | **38** |
| Content pages / blog posts | **22 / 20** |
| Assets resolving | **3,206 / 3,206** |
| Automated checks | **227 / 227 passing** |
| Runtime fragment fidelity | **100% structural overlap** |
| Peak memory | **~210 MB** (fits a 512 MB instance) |
| Disk footprint | **~700 MB** |
| Startup | one process, no database |
| Deploy | one command (`fly deploy`) |

### Engineering outcomes
- Reproduced CDN-grade image behaviour locally, with every variant generated from the originals.
- Removed the need for a database or session store with a signed-cookie cart.
- Cut memory use by more than half through build-time work and bounded caches.
- Established a verification harness that catches regressions before deploy.
- Delivered a reproducible container image and CI pipeline.

---

## Deployment

**See [DEPLOY.md](DEPLOY.md) for a step-by-step walkthrough** (Fly.io, Render,
Docker or Vercel), including how to verify a live deployment.

The app listens on `PORT` (default `3000`) and exposes `GET /healthz` for load
balancers.

| Requirement | Value |
| --- | --- |
| Disk | ~700 MB |
| Memory | ~210 MB peak — fits a 512 MB instance |
| Runtime | Node 22+, one process, no database |

### Docker (any host)

```bash
docker build -t naso-demo .
docker run --rm -p 3000:3000 naso-demo
```

### Fly.io — recommended

```bash
fly deploy --ha=false
```

`fly.toml` provisions a 512 MB `shared-cpu-1x` machine. Set `CART_SECRET` so
every instance signs the cart cookie with the same key.

### Render

`render.yaml` is a ready blueprint — connect the repo and Render builds the
Dockerfile. The 512 MB plan is sufficient.

### Vercel

`vercel.json` wires the Express app in `api/index.mjs` to the Node.js runtime
and serves `public/` from the CDN.

Two things to know:

- **Use a Pro account.** The pages and images total ~850 MB; Hobby caps static
  uploads at 100 MB. The function bundle also needs the large-functions beta
  (`VERCEL_SUPPORT_LARGE_FUNCTIONS=1` unless the project was created after
  June 2026).
- **The image cache is written to the temp directory**, since a function's
  filesystem is read-only outside `/tmp`.

### Continuous integration

`.github/workflows/ci.yml` verifies every route and asset, then builds the
Docker image on every push to `main`.

### Environment variables

| Variable | Purpose |
| --- | --- |
| `PORT` | Port to listen on (default `3000`) |
| `CART_SECRET` | Signs the cart cookie. Set it so every instance shares carts. |
| `IMG_CACHE_DIR` | Where the resized-image cache is written |
| `HTML_CACHE_MAX` | Pages kept in memory (default `40`, ~36 MB) |
| `SHARP_CONCURRENCY` | libvips concurrency for resizing (default `2`) |

`.env.example` lists them with notes.

---

## Notes and limitations

- **Third-party widgets** (reviews, shoppable video, popup tools) still load
  from their original CDNs and will not function offline. The theme's own
  layout is fully local.
- **Checkout is not connected** — `/checkout` shows a placeholder.
- **The cart is stateless**, held in a signed cookie, so it survives restarts
  and works where each request may run in a separate instance. Set
  `CART_SECRET` in the environment so every instance signs and verifies with
  the same key; without it a development fallback is used.
- **The content payload is ~700 MB**, dominated by the base image originals
  needed to generate responsive sizes.
- **The image cache is disposable** — it is rebuilt on demand.

---

## Attribution

This is a demonstration build prepared for educational and testing purposes.
It is not affiliated with, endorsed by, or connected to Naso Profumi. Product
names, imagery and brand assets remain the property of their respective
owners.
